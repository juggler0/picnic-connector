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
  /** One-time repair of lines written twice by overlapping runs (before the 10-second limit). */
  repair?: { todo: string[] | null; done: boolean; removed: number; added: number };
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
  if (s.ordersDb && !s.current && s.queue.length === 0 && s.repair?.done && s.lastListAt && Date.now() - s.lastListAt < RECHECK_MS) return s;

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
        await N.notion("POST", "/pages", { parent: { database_id: s.linesDb }, properties: lineProps(client, i, day, cur.pageId) });
        cur.nextLine += 1;
        s.linesWritten += 1;
        await saveState(s); // after every line, so a cut-off run never writes a line twice
      }
      if (cur.nextLine >= items.length) {
        s.done.push(deliveryId);
        s.current = null;
      }
      await saveState(s);
    }
    // One-time, after the backfill: remove lines that overlapping runs wrote twice. Checked against Picnic itself,
    // so a product that really was ordered twice in one delivery stays twice.
    s.repair ??= { todo: null, done: false, removed: 0, added: 0 };
    if (!s.current && !s.queue.length && !s.repair.done && timeLeft()) await repairDuplicates(s, client, timeLeft);
    s.note = s.queue.length || s.current ? "Bezig met kopiëren…"
      : !s.repair.done ? "Bezig met opruimen van dubbele regels…"
      : `Bijgewerkt.${s.repair.removed || s.repair.added ? ` (Dubbele regels opgeruimd: ${s.repair.removed} weg, ${s.repair.added} aangevuld.)` : ""}`;
  } catch (err) {
    console.error("history sync failed:", err);
    s.note = `Fout: ${describeError(err)}`;
  }
  await saveState(s);
  return s;
}

type Client = NonNullable<Awaited<ReturnType<typeof loggedInClient>>>;

function lineProps(client: Client, i: any, day: string, pageId: string) {
  return {
    Product: N.title(i.name),
    Datum: N.date(day),
    Bezorging: N.relation(pageId),
    Aantal: N.num(i.quantity),
    Prijs: N.euros(i.displayPrice),
    "Prijs zonder korting": N.euros(i.originalPrice),
    Stukprijs: N.euros(i.quantity ? i.displayPrice / i.quantity : null),
    Verpakking: N.text(i.unitQuantity),
    "Prijs per eenheid": N.text(i.basePrice),
    Actie: N.text((i.labels ?? []).map((l: any) => l.text).join(", ")),
    Kenmerken: N.multi(i.characteristics ?? []),
    "Niet geleverd": N.checkbox(Boolean(i.isUnavailable)),
    "Product-id": N.text(i.productId),
    Afbeelding: N.files(i.imageId ? client.catalog.getImageUrl(i.imageId, "small") : null),
  };
}

async function queryAll(db: string, filter: unknown): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await N.notion("POST", `/databases/${db}/query`, { filter, page_size: 100, start_cursor: cursor });
    out.push(...(r.results ?? []).filter((p: any) => !p.archived && !p.in_trash));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}
const plain = (p: any) => (p?.rich_text ?? p?.title ?? []).map((x: any) => x.plain_text).join("");
const lineKey = (productId: string, quantity: number | null, cents: number | null) => `${productId}|${quantity ?? ""}|${cents ?? ""}`;

/**
 * For every copied delivery: keep one Notion page per delivery (the one with the most lines) and make its lines
 * match Picnic exactly — extra copies are archived (Notion's trash), missing lines are added.
 */
async function repairDuplicates(s: HistoryState, client: Client, timeLeft: () => boolean) {
  const r = s.repair!;
  if (!r.todo) {
    const pages = await queryAll(s.ordersDb!, undefined);
    r.todo = [...new Set(pages.map((p) => plain(p.properties["Bezorging-id"])).filter(Boolean))];
    await saveState(s);
  }
  while (r.todo.length && timeLeft()) {
    const bid = r.todo[0];
    const pages = await queryAll(s.ordersDb!, { property: "Bezorging-id", rich_text: { equals: bid } });
    const withLines = await Promise.all(pages.map(async (p) => ({ page: p, lines: await queryAll(s.linesDb!, { property: "Bezorging", relation: { contains: p.id } }) })));
    withLines.sort((a, b) => b.lines.length - a.lines.length);
    const [keep, ...extra] = withLines;
    let finished = true;
    for (const x of extra) {
      for (const l of x.lines) {
        if (!timeLeft()) { finished = false; break; }
        await N.notion("PATCH", `/pages/${l.id}`, { archived: true });
        r.removed += 1;
      }
      if (!finished) break;
      await N.notion("PATCH", `/pages/${x.page.id}`, { archived: true });
    }
    if (finished && keep) {
      const d = await client.delivery.getDelivery(bid);
      const day = (d.windowStart ?? d.creationTime ?? "").slice(0, 10);
      const want = new Map<string, any[]>();
      for (const i of d.orders.flatMap((o: any) => o.items)) {
        const k = lineKey(i.productId, i.quantity, i.displayPrice ?? null);
        want.set(k, [...(want.get(k) ?? []), i]);
      }
      const have = new Map<string, any[]>();
      for (const l of keep.lines) {
        const P = l.properties;
        const cents = typeof P.Prijs?.number === "number" ? Math.round(P.Prijs.number * 100) : null;
        const k = lineKey(plain(P["Product-id"]), P.Aantal?.number ?? null, cents);
        have.set(k, [...(have.get(k) ?? []), l]);
      }
      for (const [k, list] of have) {
        const extraLines = list.slice((want.get(k) ?? []).length || 1); // unknown to Picnic now: keep one copy
        for (const l of extraLines) {
          if (!timeLeft()) { finished = false; break; }
          await N.notion("PATCH", `/pages/${l.id}`, { archived: true });
          r.removed += 1;
        }
        if (!finished) break;
      }
      for (const [k, items] of want) {
        if (!finished) break;
        for (const i of items.slice((have.get(k) ?? []).length)) {
          if (!timeLeft()) { finished = false; break; }
          await N.notion("POST", "/pages", { parent: { database_id: s.linesDb }, properties: lineProps(client, i, day, keep.page.id) });
          r.added += 1;
        }
      }
    }
    if (finished) r.todo.shift();
    await saveState(s);
  }
  if (!r.todo.length) r.done = true;
}
