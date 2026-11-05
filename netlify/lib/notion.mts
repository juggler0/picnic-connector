/**
 * Minimal Notion API client for the order-history export.
 * Uses the NOTION_TOKEN env var (an "internal integration" secret you create in Notion).
 * Notion allows about 3 requests per second, so every call waits a little and retries on 429.
 */
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function notionConfigured() {
  return Boolean(Netlify.env.get("NOTION_TOKEN"));
}

export async function notion(method: string, path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(350);
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${Netlify.env.get("NOTION_TOKEN")}`,
        "Notion-Version": VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(Number(res.headers.get("retry-after") ?? 2) * 1000);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Notion ${res.status}: ${data.message ?? res.statusText}`);
    return data;
  }
  throw new Error("Notion bleef te druk (te veel verzoeken)");
}

// ---------- property helpers ----------
export const title = (text: string) => ({ title: [{ text: { content: text.slice(0, 2000) } }] });
export const text = (value: string | null | undefined) => ({ rich_text: value ? [{ text: { content: value.slice(0, 2000) } }] : [] });
export const num = (value: number | null | undefined) => ({ number: value ?? null });
export const euros = (cents: number | null | undefined) => num(cents == null ? null : Math.round(cents) / 100);
export const date = (start: string | null | undefined, end?: string | null) => ({ date: start ? { start, end: end ?? null } : null });
export const select = (name: string | null | undefined) => ({ select: name ? { name: name.slice(0, 100) } : null });
export const multi = (names: string[]) => ({ multi_select: names.filter(Boolean).map((n) => ({ name: n.replace(/,/g, " ").slice(0, 100) })) });
export const checkbox = (value: boolean) => ({ checkbox: value });
export const relation = (pageId: string) => ({ relation: [{ id: pageId }] });
export const files = (url: string | null) => ({ files: url ? [{ type: "external", name: "afbeelding", external: { url } }] : [] });

/** Finds the page "Picnic-geschiedenis" that was shared with the integration. */
export async function findParentPage(): Promise<string | null> {
  const res = await notion("POST", "/search", {
    query: "Picnic-geschiedenis",
    filter: { property: "object", value: "page" },
  });
  const page = (res.results ?? []).find((p: any) => {
    const t = Object.values(p.properties ?? {}).find((v: any) => v?.type === "title") as any;
    return t?.title?.map((x: any) => x.plain_text).join("").trim().toLowerCase() === "picnic-geschiedenis";
  });
  return page?.id ?? null;
}

/** Creates the two databases (deliveries and order lines) under the parent page. */
export async function createDatabases(parentId: string) {
  const orders = await notion("POST", "/databases", {
    parent: { type: "page_id", page_id: parentId },
    icon: { type: "emoji", emoji: "📦" },
    title: [{ text: { content: "Picnic bestellingen" } }],
    properties: {
      Bezorging: { title: {} },
      Datum: { date: {} },
      Status: { select: {} },
      Totaal: { number: { format: "euro" } },
      Korting: { number: { format: "euro" } },
      Actiekorting: { number: { format: "euro" } },
      Ledenkorting: { number: { format: "euro" } },
      Statiegeld: { number: { format: "euro" } },
      Kosten: { number: { format: "euro" } },
      "Aantal producten": { number: {} },
      "Aantal regels": { number: {} },
      Bestellingen: { number: {} },
      "Bezorging-id": { rich_text: {} },
    },
  });
  const lines = await notion("POST", "/databases", {
    parent: { type: "page_id", page_id: parentId },
    icon: { type: "emoji", emoji: "🧾" },
    title: [{ text: { content: "Picnic bestelregels" } }],
    properties: {
      Product: { title: {} },
      Datum: { date: {} },
      Bezorging: { relation: { database_id: orders.id, single_property: {} } },
      Aantal: { number: {} },
      Prijs: { number: { format: "euro" } },
      "Prijs zonder korting": { number: { format: "euro" } },
      Stukprijs: { number: { format: "euro" } },
      Verpakking: { rich_text: {} },
      "Prijs per eenheid": { rich_text: {} },
      Actie: { rich_text: {} },
      Kenmerken: { multi_select: {} },
      "Niet geleverd": { checkbox: {} },
      "Product-id": { rich_text: {} },
      Afbeelding: { files: {} },
    },
  });
  return { ordersDb: orders.id as string, linesDb: lines.id as string };
}
