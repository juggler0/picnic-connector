/**
 * Weekly price list of every product the household ever ordered, in a Notion database "Picnic prijzen <year>"
 * on the page Picnic-geschiedenis: one row per product and one column per week ("Wk 46"), plus the current
 * price, last week's price, the change, the lowest and highest price this year and the current promotion.
 *
 * Works a little at a time (called every 2 minutes by the scheduled function prices-sync, ~10 s per run):
 *  1. reads newly copied order lines from "Picnic bestelregels" to know which products were ever bought,
 *  2. from Monday of each new week: looks up the current price of each of those products at Picnic and fills in
 *     that week's column. About 1000 products take roughly an hour and a half.
 * Needs NOTION_TOKEN and the order-history copy (history.mts); does nothing until both are there.
 */
import { store, loggedInClient, describeError } from "./common.mts";
import * as N from "./notion.mts";
import { loadState as loadHistoryState } from "./history.mts";

const STATE_KEY = "prices/state";
const PRODUCTS_KEY = "prices/products";
const RUN_MS = 10_000;

type Product = { name: string; unit: string; count: number; last: string };
type Stats = { price: number | null; prev: number | null; low: number | null; high: number | null };
type PriceState = {
  linesSeenUntil?: string; // created_time of the last order line read
  year?: number;
  db?: string;
  week?: string; // "2026-W46" being filled or filled last
  column?: string; // "Wk 46"
  todo?: string[];
  pages?: Record<string, string>; // product id → Notion page id (this year's database)
  stats?: Record<string, Stats>; // per product, this year
  done?: boolean;
  note?: string;
  updatedAt?: number;
};

const saveState = (s: PriceState) => store().setJSON(STATE_KEY, { ...s, updatedAt: Date.now() });
export async function loadPriceState(): Promise<PriceState> {
  return ((await store().get(STATE_KEY, { type: "json" })) as PriceState | null) ?? {};
}

/** ISO week of a date in the Netherlands: { year, week }. */
export function isoWeek(d = new Date()) {
  const local = new Date(d.toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" }) + "T12:00:00Z");
  const day = (local.getUTCDay() + 6) % 7; // Monday = 0
  local.setUTCDate(local.getUTCDate() - day + 3); // Thursday of this week
  const year = local.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return { year, week: 1 + Math.round((local.getTime() - firstThursday.getTime()) / (7 * 864e5)) };
}

const plain = (p: any) => (p?.rich_text ?? p?.title ?? []).map((x: any) => x.plain_text).join("");

async function findDatabase(title: string): Promise<string | null> {
  const res = await N.notion("POST", "/search", { query: title, filter: { property: "object", value: "database" } });
  const db = (res.results ?? []).find((d: any) => !d.archived && (d.title ?? []).map((x: any) => x.plain_text).join("").trim() === title);
  return db?.id ?? null;
}

export async function runPriceSync(): Promise<PriceState> {
  const started = Date.now();
  const timeLeft = () => Date.now() - started < RUN_MS;
  if (!N.notionConfigured()) return { note: "NOTION_TOKEN ontbreekt." };
  const s = await loadPriceState();
  const { year, week } = isoWeek();
  const weekKey = `${year}-W${String(week).padStart(2, "0")}`;
  // Idle until next Monday: stop right away (only this one storage read).
  if (s.done && s.week === weekKey) return s;

  const h = await loadHistoryState();
  // Start once the order history is complete and cleaned up, so the product list and "Keer gekocht" are right.
  if (!h.linesDb || !h.parentId || h.queue.length || h.current || !h.repair?.done) return { ...s, note: "Wacht tot de bestelgeschiedenis in Notion compleet is." };

  try {
    // 1. Products ever bought, from the order lines copied since the last look.
    const products = ((await store().get(PRODUCTS_KEY, { type: "json" })) as Record<string, Product> | null) ?? {};
    let more = true;
    while (more && timeLeft()) {
      const r = await N.notion("POST", `/databases/${h.linesDb}/query`, {
        page_size: 100,
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        ...(s.linesSeenUntil ? { filter: { timestamp: "created_time", created_time: { after: s.linesSeenUntil } } } : {}),
      });
      for (const l of r.results ?? []) {
        s.linesSeenUntil = l.created_time;
        if (l.archived || l.in_trash) continue;
        const P = l.properties;
        const id = plain(P["Product-id"]);
        if (!id) continue;
        const day = P.Datum?.date?.start?.slice(0, 10) ?? "";
        const p = (products[id] ??= { name: plain(P.Product), unit: plain(P.Verpakking), count: 0, last: "" });
        p.count += P.Aantal?.number ?? 1;
        if (day >= p.last) Object.assign(p, { last: day, name: plain(P.Product) || p.name, unit: plain(P.Verpakking) || p.unit });
      }
      more = Boolean(r.has_more);
    }
    await store().setJSON(PRODUCTS_KEY, products);
    await saveState(s);
    if (more) return { ...s, note: "Producten verzamelen…" };

    // 2. A new week: make sure this year's database and the week column exist, then list the work.
    if (s.week !== weekKey) {
      if (s.year !== year || !s.db) {
        const title = `Picnic prijzen ${year}`;
        s.db = (await findDatabase(title)) ?? undefined;
        if (!s.db) {
          const db = await N.notion("POST", "/databases", {
            parent: { type: "page_id", page_id: h.parentId },
            icon: { type: "emoji", emoji: "🏷️" },
            title: [{ text: { content: title } }],
            properties: {
              Product: { title: {} },
              "Prijs nu": { number: { format: "euro" } },
              "Vorige week": { number: { format: "euro" } },
              Verandering: { number: { format: "percent" } },
              Laagste: { number: { format: "euro" } },
              Hoogste: { number: { format: "euro" } },
              Actie: { rich_text: {} },
              Leverbaar: { checkbox: {} },
              Verpakking: { rich_text: {} },
              "Keer gekocht": { number: {} },
              "Laatst gekocht": { date: {} },
              "Product-id": { rich_text: {} },
            },
          });
          s.db = db.id;
        }
        Object.assign(s, { year, pages: {}, stats: {} });
        // Existing rows (e.g. after a restart).
        let cursor: string | undefined;
        do {
          const r = await N.notion("POST", `/databases/${s.db}/query`, { page_size: 100, start_cursor: cursor });
          for (const p of r.results ?? []) if (!p.archived) s.pages![plain(p.properties["Product-id"])] = p.id;
          cursor = r.has_more ? r.next_cursor : undefined;
        } while (cursor);
      }
      const column = `Wk ${String(week).padStart(2, "0")}`;
      await N.notion("PATCH", `/databases/${s.db}`, { properties: { [column]: { number: { format: "euro" } } } });
      Object.assign(s, { week: weekKey, column, todo: Object.keys(products), done: false });
      await saveState(s);
    }

    // 3. This week's prices, product by product.
    const client = await loggedInClient();
    if (!client) return { ...s, note: "Niet ingelogd bij Picnic." };
    let n = 0;
    while (s.todo!.length && timeLeft()) {
      const id = s.todo![0];
      const meta = products[id];
      let p: any = null;
      try {
        p = await client.catalog.getProduct(id);
      } catch (err) {
        const msg = describeError(err);
        if (/429|too many|rate/i.test(msg)) break; // Picnic wants a pause: continue next run
        p = null; // no longer sold
      }
      const price = typeof p?.displayPrice === "number" ? p.displayPrice : null;
      const st = (s.stats![id] ??= { price: null, prev: null, low: null, high: null });
      if (price !== null) {
        st.prev = st.price;
        st.price = price;
        st.low = st.low === null ? price : Math.min(st.low, price);
        st.high = st.high === null ? price : Math.max(st.high, price);
      }
      const props: Record<string, unknown> = {
        Product: N.title(p?.name ?? meta?.name ?? id),
        "Product-id": N.text(id),
        [s.column!]: N.euros(price),
        "Prijs nu": N.euros(price),
        "Vorige week": N.euros(price !== null ? st.prev : st.price),
        Verandering: N.num(price !== null && st.prev ? Math.round(((price - st.prev) / st.prev) * 1000) / 1000 : null),
        Laagste: N.euros(st.low),
        Hoogste: N.euros(st.high),
        Actie: N.text(p?.promotion?.label ?? ""),
        Leverbaar: N.checkbox(price !== null),
        Verpakking: N.text(p?.unitQuantity ?? meta?.unit ?? ""),
        "Keer gekocht": N.num(meta?.count ?? null),
        "Laatst gekocht": N.date(meta?.last || null),
      };
      const pageId = s.pages![id];
      if (pageId) await N.notion("PATCH", `/pages/${pageId}`, { properties: props });
      else s.pages![id] = (await N.notion("POST", "/pages", { parent: { database_id: s.db }, properties: props })).id;
      s.todo!.shift();
      n++;
    }
    s.done = s.todo!.length === 0;
    s.note = s.done ? `${s.column} klaar (${Object.keys(s.pages!).length} producten).` : `${s.column}: nog ${s.todo!.length} producten.`;
    console.info("price sync:", s.note, `this run=${n}`);
  } catch (err) {
    console.error("price sync failed:", err);
    s.note = `Fout: ${describeError(err)}`;
  }
  await saveState(s);
  return s;
}
