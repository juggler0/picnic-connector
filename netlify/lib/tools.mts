/**
 * All tools the connector offers to Claude.
 *
 * READ-ONLY tools only look things up. WRITE tools change the cart.
 * Deliberately NOT included: ordering, paying, cancelling an order.
 * Those stay in the Picnic app, done by the user.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeError, euro, loggedInClient } from "./common.mts";

type Client = NonNullable<Awaited<ReturnType<typeof loggedInClient>>>;
type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }] });
const fail = (message: string): Result => ({ content: [{ type: "text", text: message }], isError: true });

const NOT_LOGGED_IN =
  "Er is nog niet ingelogd bij Picnic. De gebruiker moet eenmalig inloggen via de inlogpagina van de connector (de hoofdpagina van de Netlify-site).";

/** Runs a tool with the stored Picnic login; logs the call and turns errors into a readable message. */
async function run(tool: string, args: unknown, fn: (c: Client) => Promise<unknown>): Promise<Result> {
  console.info("tool call:", tool, JSON.stringify(args));
  const client = await loggedInClient();
  if (!client) return fail(NOT_LOGGED_IN);
  try {
    return ok(await fn(client));
  } catch (err) {
    console.error("tool failed:", tool, err);
    return fail(describeError(err));
  }
}

// ---------- shaping Picnic's data into short, readable answers ----------

const productId = z.string().regex(/^s\d+$/).describe("Product-id, bijv. 's1004201'");
const date = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

const tile = (p: any) => ({
  id: p.id,
  name: [p.namePrefix, p.name].filter(Boolean).join(" "),
  brand: p.brand ?? null,
  unit: p.unitQuantity,
  price: euro(p.displayPrice),
  originalPrice: euro(p.originalPrice),
  unitPrice: p.unitPrice ?? null,
  promo: (p.labels ?? []).map((l: any) => l.text).filter(Boolean).join(", ") || null,
  unavailable: p.isUnavailable || undefined,
});

const line = (i: any) => ({
  id: i.productId,
  name: i.name,
  unit: i.unitQuantity,
  quantity: i.quantity,
  price: euro(i.displayPrice),
  labels: (i.labels ?? []).map((l: any) => l.text).filter(Boolean).join(", ") || null,
});

const cartSummary = (cart: any) => ({
  totalCount: cart.totalCount,
  totalPrice: euro(cart.totalPrice),
  promotionSavings: euro(cart.promotionSavings),
  items: (cart.items ?? []).map(line),
});

const matches = (text: string | null | undefined, filter?: string) =>
  !filter || (text ?? "").toLowerCase().includes(filter.toLowerCase());

// ---------- the tools ----------

export function registerTools(server: McpServer) {
  // ===== READ-ONLY: account and cart =====

  server.tool(
    "picnic_status",
    "Controleert of de connector bij Picnic is ingelogd en geeft het aantal producten en totaal in de winkelmand. Alleen lezen.",
    {},
    async () => run("picnic_status", {}, async (c) => {
      const cart = await c.cart.getCart();
      return { loggedIn: true, cartCount: cart.totalCount, cartTotal: euro(cart.totalPrice) };
    }),
  );

  server.tool(
    "picnic_get_cart",
    "Toont de huidige winkelmand: producten, aantallen, prijzen, actielabels en totaal. Alleen lezen.",
    {},
    async () => run("picnic_get_cart", {}, async (c) => cartSummary(await c.cart.getCart())),
  );

  // ===== READ-ONLY: finding products =====

  server.tool(
    "picnic_search",
    "Zoekt producten zoals in de app. boughtBefore=true betekent eerder gekocht (sectie 'Opnieuw bestellen'); dat is een hint, geen voorkeur — een A-merk dat eens in de aanbieding is gekocht hoeft niet opnieuw. Vergelijk bij acties de prijs per kilo/liter (unitPrice) met het huismerk. 'promo' toont een actielabel. Geeft ook Picnic-recepten die bij de zoekterm passen. Alleen lezen.",
    {
      query: z.string().min(1).max(100).describe("Zoekterm in het Nederlands, bijv. 'kipfilet'"),
      limit: z.coerce.number().int().min(1).max(20).default(8).describe("Maximaal aantal producten"),
    },
    async ({ query, limit }) => run("picnic_search", { query, limit }, async (c) => {
      const res = await c.catalog.getSearchResults(query);
      const seen = new Map<string, any>();
      for (const section of res.products?.sections ?? []) {
        const boughtBefore = section.type === "RFY";
        for (const p of section.products) {
          const existing = seen.get(p.id);
          if (existing) existing.boughtBefore ||= boughtBefore;
          else seen.set(p.id, { ...tile(p), boughtBefore });
        }
      }
      const products = [...seen.values()]
        .sort((a, b) => Number(b.boughtBefore) - Number(a.boughtBefore))
        .slice(0, limit);
      const recipes = (res.recipes ?? []).slice(0, 5).map((r: any) => ({ id: r.id, name: r.name, subtitle: r.subtitle ?? null }));
      return { query: res.correctedQuery ?? res.query, products, recipes };
    }),
  );

  server.tool(
    "picnic_product",
    "Details van één product: prijs, prijs per kilo/liter, actie, omschrijving, ingrediënten/allergenen en vergelijkbare producten. Alleen lezen.",
    { product_id: productId },
    async ({ product_id }) => run("picnic_product", { product_id }, async (c) => {
      const p: any = await c.catalog.getProduct(product_id);
      return {
        id: p.id,
        name: p.name,
        brand: p.brand,
        unit: p.unitQuantity,
        price: euro(p.displayPrice),
        originalPrice: euro(p.originalPrice),
        unitPrice: p.unitPrice,
        promotion: p.promotion?.label ?? null,
        description: p.description,
        info: (p.infoSections ?? []).map((s: any) => ({ title: s.title, content: String(s.content).slice(0, 600) })),
        similar: (p.similarProducts ?? []).slice(0, 6).map((s: any) => ({ id: s.id, name: s.name, unit: s.unitQuantity, price: euro(s.displayPrice) })),
      };
    }),
  );

  server.tool(
    "picnic_favorites",
    "Producten die de gebruiker vaak koopt (tab 'Favorieten'), per schap. Zonder aisle_id: alle schappen (lange schappen deels); met aisle_id: dat hele schap. Alleen lezen.",
    { aisle_id: z.string().optional().describe("Schap-id uit een eerdere aanroep, bijv. 'DAIRY'") },
    async ({ aisle_id }) => run("picnic_favorites", { aisle_id }, async (c) => {
      if (aisle_id) return { aisle: aisle_id, products: (await c.catalog.getFavoritesInAisle(aisle_id)).map(tile) };
      const fav = await c.catalog.getFavorites();
      return {
        aisles: fav.aisles
          .filter((a) => a.products.length)
          .map((a) => ({ id: a.id, title: a.title, complete: a.complete, products: a.products.map(tile) })),
      };
    }),
  );

  // ===== READ-ONLY: promotions =====

  server.tool(
    "picnic_promotions",
    "De actiepagina van Picnic: per sectie de producten in de aanbieding en de groepsacties (bijv. 'Korting op Alpro'). Gebruik 'filter' om op sectie- of productnaam te zoeken (bijv. 'kaas'). Alleen lezen.",
    { filter: z.string().max(50).optional().describe("Optioneel woord om op te filteren") },
    async ({ filter }) => run("picnic_promotions", { filter }, async (c) => {
      const promos = await c.catalog.getPromotions();
      return {
        sections: promos.sections
          .map((s) => {
            const sectionHit = matches(s.title, filter);
            return {
              title: s.title,
              products: s.products.filter((p) => sectionHit || matches(p.name, filter) || matches(p.brand, filter)).map(tile),
              groups: s.groups
                .filter((g) => sectionHit || matches(g.name, filter) || matches(g.example, filter))
                .map((g) => ({ id: g.id, name: g.name, example: g.example, promo: g.label })),
            };
          })
          .filter((s) => s.products.length || s.groups.length),
      };
    }),
  );

  server.tool(
    "picnic_promotion_group",
    "Alle producten van één groepsactie uit picnic_promotions (bijv. alle producten in 'Korting op Alpro'). Alleen lezen.",
    { group_id: z.string().min(1).describe("Id van de groepsactie") },
    async ({ group_id }) => run("picnic_promotion_group", { group_id }, async (c) => {
      const g = await c.catalog.getPromotionGroup(group_id);
      return { id: g.id, name: g.name, products: g.products.map(tile) };
    }),
  );

  // ===== READ-ONLY: order history =====

  server.tool(
    "picnic_order_history",
    "Lijst van eerdere en lopende bezorgingen (nieuwste eerst): id, datum, status, aantal producten, bedrag. Alleen lezen.",
    { limit: z.coerce.number().int().min(1).max(300).default(10).describe("Aantal bezorgingen") },
    async ({ limit }) => run("picnic_order_history", { limit }, async (c) => {
      const list = await c.delivery.getDeliverySummaries();
      return list.slice(0, limit).map((d) => ({
        id: d.id,
        date: date(d.windowStart ?? d.creationTime),
        status: d.status,
        total: euro(d.totalPrice),
      }));
    }),
  );

  server.tool(
    "picnic_order_details",
    "Alle producten van één bezorging uit picnic_order_history, met aantallen en prijzen. Alleen lezen.",
    { delivery_id: z.string().min(1).describe("Id van de bezorging") },
    async ({ delivery_id }) => run("picnic_order_details", { delivery_id }, async (c) => {
      const d = await c.delivery.getDelivery(delivery_id);
      return {
        id: d.id,
        date: date(d.windowStart ?? d.creationTime),
        status: d.status,
        total: euro(d.totalPrice),
        items: d.orders.flatMap((o) => o.items.map(line)),
      };
    }),
  );

  server.tool(
    "picnic_purchase_stats",
    "Telt over afgeronde bezorgingen welke producten de gebruiker koopt: in hoeveel bezorgingen (orders, share %), hoe vaak in de laatste 12 (recent12), gemiddeld aantal per keer, eerst en laatst gekocht. Bedoeld om voorkeursproducten en vaste hoeveelheden te bepalen. Gebruik skip om verder terug te kijken in blokken. Alleen lezen.",
    {
      deliveries: z.coerce.number().int().min(1).max(60).default(12).describe("Aantal afgeronde bezorgingen om te tellen"),
      skip: z.coerce.number().int().min(0).max(500).default(0).describe("Zoveel recente bezorgingen eerst overslaan (voor oudere blokken)"),
      min_orders: z.coerce.number().int().min(1).max(60).default(1).describe("Alleen producten tonen die in minstens zoveel bezorgingen zaten"),
    },
    async ({ deliveries, skip, min_orders }) => run("picnic_purchase_stats", { deliveries, skip, min_orders }, async (c) => {
      const summaries = (await c.delivery.getDeliverySummaries(["COMPLETED"])).slice(skip, skip + deliveries);
      // Fetch the deliveries a few at a time, to stay friendly to Picnic and within the function time limit.
      const details: Awaited<ReturnType<typeof c.delivery.getDelivery>>[] = [];
      for (let i = 0; i < summaries.length; i += 6) {
        details.push(...(await Promise.all(summaries.slice(i, i + 6).map((s) => c.delivery.getDelivery(s.id)))));
      }
      const stats = new Map<string, any>();
      details.forEach((d, index) => {
        const day = date(d.windowStart ?? d.creationTime);
        const seenHere = new Set<string>();
        for (const i of d.orders.flatMap((o) => o.items)) {
          const s = stats.get(i.productId) ?? { id: i.productId, name: i.name, unit: i.unitQuantity, orders: 0, recent12: 0, totalQuantity: 0, firstBought: day, lastBought: day };
          if (!seenHere.has(i.productId)) {
            s.orders += 1;
            if (index < 12) s.recent12 += 1;
            seenHere.add(i.productId);
          }
          s.totalQuantity += i.quantity;
          if (day && (!s.lastBought || day > s.lastBought)) s.lastBought = day;
          if (day && (!s.firstBought || day < s.firstBought)) s.firstBought = day;
          stats.set(i.productId, s);
        }
      });
      return {
        deliveriesCounted: details.length,
        from: date(summaries.at(-1)?.windowStart ?? summaries.at(-1)?.creationTime),
        to: date(summaries[0]?.windowStart ?? summaries[0]?.creationTime),
        products: [...stats.values()]
          .filter((s) => s.orders >= min_orders)
          .map((s) => ({
            ...s,
            share: `${Math.round((s.orders / Math.max(details.length, 1)) * 100)}%`,
            avgQuantity: Math.round((s.totalQuantity / s.orders) * 10) / 10,
          }))
          .sort((a, b) => b.orders - a.orders || b.totalQuantity - a.totalQuantity),
      };
    }),
  );

  server.tool(
    "picnic_next_delivery",
    "De lopende bezorging(en) en de beschikbare bezorgmomenten voor de winkelmand (met slot_id, besteldeadline en minimumbedrag). Geef 'date' (JJJJ-MM-DD) om alleen de momenten van die dag te zien. Alleen lezen; kiezen gaat met picnic_set_delivery_slot.",
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Alleen bezorgmomenten op deze dag, bijv. '2026-11-12'") },
    async ({ date: day }) => run("picnic_next_delivery", { date: day }, async (c) => {
      const current = await c.delivery.getDeliverySummaries(["CURRENT"]);
      const slots = await c.cart.getDeliverySlots().catch(() => null);
      return {
        current: current.map((d) => ({ id: d.id, windowStart: d.windowStart, windowEnd: d.windowEnd, total: euro(d.totalPrice) })),
        selectedSlot: slots?.selectedSlot ?? null,
        availableSlots: (slots?.slots ?? [])
          .filter((s) => s.isAvailable && (!day || s.windowStart.startsWith(day)))
          .slice(0, day ? 50 : 20)
          .map((s) => ({
            slot_id: s.slotId,
            start: s.windowStart,
            end: s.windowEnd,
            orderBefore: s.cutOffTime,
            minimumOrder: euro(s.minimumOrderValue),
            selected: s.isSelected || undefined,
          })),
      };
    }),
  );

  // ===== WRITE: delivery slot (choosing a slot is not ordering) =====

  server.tool(
    "picnic_set_delivery_slot",
    "Kiest het bezorgmoment voor de huidige winkelmand (slot_id uit picnic_next_delivery). Dit plaatst GEEN bestelling: de gebruiker rekent zelf af in de app.",
    { slot_id: z.string().min(1).describe("slot_id uit picnic_next_delivery") },
    async ({ slot_id }) => run("picnic_set_delivery_slot", { slot_id }, async (c) => {
      const cart: any = await c.cart.setDeliverySlot(slot_id);
      return { selectedSlot: cart.selectedSlot ?? null, cart: cartSummary(cart) };
    }),
  );

  // ===== READ-ONLY: Picnic recipes =====

  server.tool(
    "picnic_saved_recipes",
    "De recepten die de gebruiker in de Picnic-app heeft bewaard, en zijn eigen recepten. Alleen lezen.",
    {},
    async () => run("picnic_saved_recipes", {}, async (c) => {
      const [saved, own] = await Promise.all([c.recipe.getSavedRecipes(), c.recipe.getUserDefinedRecipes()]);
      const short = (r: any) => ({ id: r.id, name: r.name, subtitle: r.subtitle ?? null, minutes: r.cookingTimeMinutes ?? null });
      return { saved: saved.map(short), own: own.map(short) };
    }),
  );

  server.tool(
    "picnic_recipe",
    "Eén Picnic-recept met ingrediënten (product-id's en aantallen) voor het gekozen aantal personen. Alleen lezen.",
    {
      recipe_id: z.string().min(1).describe("Recept-id uit picnic_search of picnic_saved_recipes"),
      portions: z.coerce.number().int().min(1).max(12).default(4).describe("Aantal personen"),
    },
    async ({ recipe_id, portions }) => run("picnic_recipe", { recipe_id, portions }, async (c) => {
      const r = await c.recipe.getRecipe(recipe_id, { portions, resolveIngredientNames: true });
      return {
        id: r.id,
        name: r.name,
        portions: r.portions,
        description: r.description,
        ingredients: r.ingredients.map((i) => ({ name: i.name, product_id: i.sellingUnitId, quantity: i.quantity, type: i.type, available: i.isAvailable })),
      };
    }),
  );

  // ===== WRITE: the cart (never an order) =====

  server.tool(
    "picnic_add_to_cart",
    "Voegt een of meer producten toe aan de winkelmand (zit het er al in, dan gaat het aantal omhoog). Gebruik id's uit de andere tools. Plaatst GEEN bestelling.",
    {
      items: z.array(z.object({ product_id: productId, count: z.coerce.number().int().min(1).max(10).default(1) })).min(1).max(40),
    },
    async ({ items }) => run("picnic_add_to_cart", { items }, async (c) => {
      const failed: { product_id: string; error: string }[] = [];
      let cart: any = null;
      for (const item of items) {
        try {
          cart = await c.cart.addProductToCart(item.product_id, item.count);
        } catch (err) {
          failed.push({ product_id: item.product_id, error: describeError(err) });
        }
      }
      cart ??= await c.cart.getCart();
      return { added: items.length - failed.length, failed, cart: cartSummary(cart) };
    }),
  );

  server.tool(
    "picnic_remove_from_cart",
    "Haalt een aantal stuks van een product uit de winkelmand.",
    { product_id: productId, count: z.coerce.number().int().min(1).max(20).default(1) },
    async ({ product_id, count }) => run("picnic_remove_from_cart", { product_id, count }, async (c) =>
      cartSummary(await c.cart.removeProductFromCart(product_id, count)),
    ),
  );

  server.tool(
    "picnic_clear_cart",
    "Maakt de hele winkelmand leeg. ALLEEN gebruiken als de gebruiker daar in dit gesprek uitdrukkelijk om vraagt — nooit in de wekelijkse taak.",
    { confirm: z.literal(true).describe("Moet true zijn: de gebruiker heeft er uitdrukkelijk om gevraagd") },
    async () => run("picnic_clear_cart", {}, async (c) => cartSummary(await c.cart.clearCart())),
  );
}
