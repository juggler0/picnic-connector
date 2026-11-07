/**
 * Copies the Picnic order history into two Notion databases, a little at a time.
 * Called every 2 minutes by the scheduled function history-sync. Each run works for at most ~10 seconds,
 * remembers where it stopped (in Netlify Blobs) and continues on the next run:
 *  - first a one-time backfill of all completed deliveries (newest first),
 *  - afterwards it checks Picnic every 6 hours for newly completed deliveries.
 */
import { store, loggedInClient, describeError } from "./common.mts";
import * as N from "./notion.mts";

const STATE_KEY = "history/state";
// Netlify answers a scheduled run after ~15 s and retries runs that take longer, so stay well below that.
const RUN_MS = 10_000;
const RECHECK_MS = 6 * 60 * 60 * 1000;

export type HistoryState = {
  parentId?: string;
  ordersDb?: string;
  linesDb?: string;
  done: string[]; // delivery ids fully copied
  queue: string[]; // delivery ids still to copy (newest first)
  current?: { deliveryId: string; pageId: string; nextLine: number } | null;
  lastListAt?: number;
  totalCompleted?: number;
  linesWritten?: number;
  failed?: Record<string, string>;
  note?: string;
  updatedAt?: number;
};

export async function loadState(): Promise<HistoryState> {
  const s = (await store().get(STATE_KEY, { type: "json" })) as HistoryState | null;
  return s ?? { done: [], queue: [] };
}
const saveState = (s: HistoryState) => store().setJSON(STATE_KEY, { ...s, updatedAt: Date.now() });

export async function runHistorySync(): Promise<HistoryState> {
  const started = Date.now();
  const timeLeft = () => Date.now() - started < RUN_MS;
  // The Notion export is optional: without NOTION_TOKEN this does nothing at all (no storage reads either).
  if (!N.notionConfigured()) return { done: [], queue: [], note: "NOTION_TOKEN ontbreekt in Netlify." };

  const s = await loadState();
  s.failed ??= {};
  s.linesWritten ??= 0;
  // Nothing to do until the next 6-hour check: stop right away to save compute.
  if (s.ordersDb && !s.current && s.queue.length === 0 && s.lastListAt && Date.now() - s.lastListAt < RECHECK_MS) return s;

  // 1. Notion setup: find the shared page, create the databases once.
  if (!s.parentId) {
    s.parentId = (await N.findParentPage()) ?? undefined;
    if (!s.parentId) {
      s.note = "Pagina 'Picnic-geschiedenis' niet gevonden — is hij gedeeld met de integratie Picnic-export?";
      await saveState(s);
      return s;
    }
  }
  if (!s.ordersDb || !s.linesDb) {
    Object.assign(s, await N.createDatabases(s.parentId));
    await saveState(s);
  }

  const client = await loggedInClient();
  if (!client) {
    s.note = "Niet ingelogd bij Picnic.";
    await saveState(s);
    return s;
  }

  try {
    // 2. Refresh the to-do list when it is empty and the last check is old enough.
    if (!s.current && s.queue.length === 0 && (!s.lastListAt || Date.now() - s.lastListAt > RECHECK_MS)) {
      const completed = await client.delivery.getDeliverySummaries(["COMPLETED"]);
      const done = new Set([...s.done, ...Object.keys(s.failed)]);
      s.queue = completed.map((d) => d.id).filter((id) => !done.has(id));
      s.totalCompleted = completed.length;
      s.lastListAt = Date.now();
      await saveState(s);
    }

    // 3. Copy deliveries until the time is up.
    while (timeLeft() && (s.current || s.queue.length)) {
      const deliveryId = s.current?.deliveryId ?? s.queue[0];
      let d;
      try {
        d = await client.delivery.getDelivery(deliveryId);
      } catch (err) {
        s.failed[deliveryId] = describeError(err);
        s.queue = s.queue.filter((id) => id !== deliveryId);
        s.current = null;
        await saveState(s);
        continue;
      }
      const day = (d.windowStart ?? d.creationTime ?? "").slice(0, 10);
      const items = d.orders.flatMap((o) => o.items);

      if (!s.current) {
        const page = await N.notion("POST", "/pages", {
          parent: { database_id: s.ordersDb },
          properties: {
            Bezorging: N.title(`${day} · €${(d.totalPrice / 100).toFixed(2).replace(".", ",")}`),
            Datum: N.date(d.windowStart ?? d.creationTime, d.windowEnd),
            Status: N.select(d.status),
            Totaal: N.euros(d.totalPrice),
            Korting: N.euros(d.discount),
            Actiekorting: N.euros(d.promotionSavings),
            Ledenkorting: N.euros(d.membershipSavings),
            Statiegeld: N.euros(d.depositTotal),
            Kosten: N.euros(d.fees.reduce((sum, f) => sum + f.amount, 0)),
            "Aantal producten": N.num(d.totalCount),
            "Aantal regels": N.num(items.length),
            Bestellingen: N.num(d.orders.length),
            "Bezorging-id": N.text(d.id),
          },
        });
        s.current = { deliveryId, pageId: page.id, nextLine: 0 };
        s.queue = s.queue.filter((id) => id !== deliveryId);
        await saveState(s);
      }

      const cur = s.current!;
      while (cur.nextLine < items.length && timeLeft()) {
        const i = items[cur.nextLine];
        await N.notion("POST", "/pages", {
          parent: { database_id: s.linesDb },
          properties: {
            Product: N.title(i.name),
            Datum: N.date(day),
            Bezorging: N.relation(cur.pageId),
            Aantal: N.num(i.quantity),
            Prijs: N.euros(i.displayPrice),
            "Prijs zonder korting": N.euros(i.originalPrice),
            Stukprijs: N.euros(i.quantity ? i.displayPrice / i.quantity : null),
            Verpakking: N.text(i.unitQuantity),
            "Prijs per eenheid": N.text(i.basePrice),
            Actie: N.text(i.labels.map((l) => l.text).join(", ")),
            Kenmerken: N.multi(i.characteristics ?? []),
            "Niet geleverd": N.checkbox(Boolean(i.isUnavailable)),
            "Product-id": N.text(i.productId),
            Afbeelding: N.files(i.imageId ? client.catalog.getImageUrl(i.imageId, "small") : null),
          },
        });
        cur.nextLine += 1;
        s.linesWritten += 1;
        if (cur.nextLine % 5 === 0) await saveState(s);
      }
      if (cur.nextLine >= items.length) {
        s.done.push(deliveryId);
        s.current = null;
      }
      await saveState(s);
    }
    s.note = s.queue.length || s.current ? "Bezig met kopiëren…" : "Bijgewerkt.";
  } catch (err) {
    console.error("history sync failed:", err);
    s.note = `Fout: ${describeError(err)}`;
  }
  await saveState(s);
  return s;
}
