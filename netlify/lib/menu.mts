/**
 * Family menu website: storage, users and sessions.
 *
 * The menu itself lives in three Notion databases on the page "Weekmenu" (found by title, created if missing):
 *   Weekmenu-dagen          one row per day: dish, ingredients, Picnic products, everyone's rating and reaction
 *   Weekmenu-weken          one row per week: title, status, reactions on the menu as a whole
 *   Weekmenu-boodschappen   standard groceries per week (planned by Claude) and suggestions from the family
 * Every "Opslaan" on the website writes to Notion straight away (NOTION_TOKEN).
 *
 * Small things stay in Netlify Blobs (store "menu"):
 *   auth/fails/<person>     failed login attempts (brief lockout)
 *   guest/<friday-date>     individual guest ratings (Notion gets the average)
 *   guest/quota             when the guest account gave its last ratings
 *   events/<time>           change log, so Claude can see what is new since it last looked
 *   meta/*                  cached database ids, processing markers, migration state
 *
 * Users come from the MENU_USERS env var, e.g. "Johan:1234,Andrea:5678,Laura:1111,Merle:2222".
 * The first name (or MENU_OWNER) is the owner: the only one who may change dishes and approve groceries.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import * as N from "./notion.mts";

export const menuStore = () => getStore({ name: "menu", consistency: "strong" });

// ---------- types ----------
export type Day = {
  date: string; // YYYY-MM-DD
  dish: string; // "" = nothing planned
  ingredients: string;
  picnic: string; // exact Picnic products (proposal or ordered)
  notes: string; // "Bijzonderheden"
  recipeUrl: string;
  away: boolean; // nobody eats at home
  editedBy: "claude" | "owner";
  claudeNote: string; // what Claude changed after a reaction
  editedAt: string;
};
export type Week = { id: string; title: string; status: string; delivery: string; days: Day[]; updatedAt: string };
export type FeedbackItem = { comment: string; rating: number | null; updatedAt: string };
export type PersonFeedback = { person: string; items: Record<string, FeedbackItem> }; // key = date, or "week" for the menu as a whole
export type GuestItem = { rating: number; comment: string; at: string; commentAt?: string; sid?: string; mine?: boolean };
export type GuestFeedback = { items: Record<string, GuestItem[]> };
export type Grocery = { id: string; product: string; amount: number | null; picnic: string; price: number | null; status: string; by: string };
export type MenuEvent = {
  at: string; kind: "feedback" | "guest" | "suggestion" | "owner-edit"; week: string; date?: string; day?: string;
  dish?: string; person: string; rating?: number | null; comment?: string; product?: string;
};

const DAY_NAMES = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
export const dayName = (date: string) => DAY_NAMES[new Date(date + "T12:00:00Z").getUTCDay()];
export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");
export const addDays = (date: string, n: number) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
/** The Friday on or before a date: the id of the menu week it belongs to. */
export const weekIdFor = (date: string) => addDays(date, -((new Date(date + "T12:00:00Z").getUTCDay() + 2) % 7));
/** Today's date in the Netherlands. */
export const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });

// ---------- users ----------
function rawUsers(): { name: string; pin: string }[] {
  return (Netlify.env.get("MENU_USERS") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [name, pin] = x.split(":").map((s) => s.trim());
      return { name, pin: pin ?? "" };
    })
    .filter((u) => u.name);
}
export const owner = () => Netlify.env.get("MENU_OWNER")?.trim() || rawUsers()[0]?.name || "";
/** Family members. Only the owner logs in with a PIN (4–8 digits); the others just tap their name. */
export function users(): { name: string; pin: string }[] {
  const o = owner();
  return rawUsers().filter((u) => u.name !== o || /^\d{4,8}$/.test(u.pin));
}
export const needsPin = (name: string) => name === owner();
export const findUser = (name: string) => users().find((u) => u.name.toLowerCase() === String(name).trim().toLowerCase());

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The shared guest account: may read everything and give a few ratings per day. */
export const GUEST = "Gast";
export const GUEST_PER_DAY = 3;

// ---------- sessions: "name.expiry.signature" in an HttpOnly cookie ----------
const SESSION_DAYS = 120;
const sessionKey = () => createHmac("sha256", Netlify.env.get("CONNECTOR_SECRET") ?? "").update("menu-session-v1").digest();
const sign = (payload: string) => createHmac("sha256", sessionKey()).update(payload).digest("base64url");

export function makeSession(name: string, days = SESSION_DAYS) {
  const payload = `${Buffer.from(name).toString("base64url")}.${Date.now() + days * 864e5}`;
  return `${payload}.${sign(payload)}`;
}
function sessionParts(req: Request) {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)menu_session=([^;]+)/);
  if (!m || !(Netlify.env.get("CONNECTOR_SECRET")?.length ?? 0)) return null;
  const [n, exp, sig] = m[1].split(".");
  if (!n || !exp || !sig || !eq(sig, sign(`${n}.${exp}`)) || Number(exp) < Date.now()) return null;
  return { name: Buffer.from(n, "base64url").toString(), sig };
}
export function readSession(req: Request): string | null {
  const s = sessionParts(req);
  if (!s) return null;
  if (s.name === GUEST) return GUEST;
  return findUser(s.name)?.name ?? null; // a removed user is logged out
}
/** Identifies one guest session, so a guest who rates the same dish again updates their own rating. */
export const guestSessionId = (req: Request) => sessionParts(req)?.sig.slice(0, 16) ?? "";
export const sessionCookie = (value: string, maxAgeDays = SESSION_DAYS) =>
  `menu_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.round(maxAgeDays * 86400)}`;

/** Checks a PIN with a brief lockout after repeated failures. */
export async function checkLogin(name: string, pin: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const user = findUser(name);
  if (!user) return { ok: false, error: "Onbekende naam." };
  const key = `auth/fails/${user.name.toLowerCase()}`;
  const s = menuStore();
  const fails = ((await s.get(key, { type: "json" })) as { count: number; since: number } | null) ?? { count: 0, since: Date.now() };
  if (Date.now() - fails.since > 30 * 60_000) Object.assign(fails, { count: 0, since: Date.now() });
  if (!needsPin(user.name)) return { ok: true, name: user.name }; // family members: no PIN
  if (fails.count >= 8) return { ok: false, error: "Te vaak een verkeerde pincode. Probeer het over een half uur opnieuw." };
  if (!eq(String(pin), user.pin)) {
    fails.count += 1;
    await s.setJSON(key, fails);
    return { ok: false, error: "Verkeerde pincode." };
  }
  await s.delete(key);
  return { ok: true, name: user.name };
}

// ---------- Notion databases ----------
const TITLES = { days: "Weekmenu-dagen", weeks: "Weekmenu-weken", groceries: "Weekmenu-boodschappen" } as const;
type DbKey = keyof typeof TITLES;
type Dbs = Record<DbKey, string> & { schemaFor: string };
const DB_KEY = "meta/notionDbs";
const ownerEditProp = () => `Aangepast door ${owner()}`;
const reactionProp = (person: string) => `Reactie ${person}`;
/** voorstel → in winkelmand (Wednesday, not yet paid) → besteld (from delivery day) → gegeten (day has passed). */
export const DAY_STATUS = ["voorstel", "in winkelmand", "besteld", "gegeten"];
export const GROCERY_STATUS = ["gepland", "voorstel", "goedgekeurd", "afgewezen"];

function schema(key: DbKey): Record<string, unknown> {
  const people = users().map((u) => u.name);
  const statusSel = { select: { options: DAY_STATUS.map((name) => ({ name })) } };
  if (key === "days") {
    const s: Record<string, unknown> = {
      Gerecht: { title: {} }, Datum: { date: {} }, Week: { rich_text: {} }, Status: statusSel,
      Boodschappen: { rich_text: {} }, "Picnic-producten": { rich_text: {} }, Bijzonderheden: { rich_text: {} },
      Recept: { url: {} }, "Niet thuis": { checkbox: {} }, [ownerEditProp()]: { checkbox: {} }, "Claude-notitie": { rich_text: {} },
    };
    for (const p of people) s[p] = { number: {} };
    for (const p of people) s[reactionProp(p)] = { rich_text: {} };
    Object.assign(s, { Gast: { number: {} }, "Gast aantal": { number: {} }, "Gast reacties": { rich_text: {} }, "Verwerkt in overzicht": { checkbox: {} } });
    return s;
  }
  if (key === "weeks") {
    const s: Record<string, unknown> = { Week: { title: {} }, "Week-id": { rich_text: {} }, Status: statusSel, Bezorging: { date: {} }, "Claude-notitie": { rich_text: {} } };
    for (const p of people) s[reactionProp(p)] = { rich_text: {} };
    return s;
  }
  return {
    Product: { title: {} }, Week: { rich_text: {} }, Aantal: { number: {} }, "Picnic-product": { rich_text: {} }, Prijs: { number: { format: "euro" } },
    Status: { select: { options: GROCERY_STATUS.map((name) => ({ name })) } },
    Door: { select: { options: ["Claude", ...people].map((name) => ({ name })) } },
  };
}

let dbCache: Dbs | null = null;
const SCHEMA_VERSION = 2; // raise when schema() gets new columns, so they are added to existing databases
const schemaSignature = () => `v${SCHEMA_VERSION}|` + users().map((u) => u.name).join(",") + "|" + owner();

/** Finds the three databases (shared with the integration via the page "Weekmenu"); creates missing ones and missing columns. */
export async function dbs(): Promise<Dbs> {
  if (!N.notionConfigured()) throw new Error("NOTION_TOKEN ontbreekt in Netlify.");
  const sig = schemaSignature();
  if (dbCache?.schemaFor === sig) return dbCache;
  const cached = (await menuStore().get(DB_KEY, { type: "json" })) as Dbs | null;
  if (cached?.schemaFor === sig) return (dbCache = cached);

  const found: Partial<Record<DbKey, string>> = {};
  const res = await N.notion("POST", "/search", { query: "Weekmenu", filter: { property: "object", value: "database" }, page_size: 100 });
  for (const db of res.results ?? []) {
    if (db.archived || db.in_trash) continue;
    const t = (db.title ?? []).map((x: any) => x.plain_text).join("").trim();
    for (const k of Object.keys(TITLES) as DbKey[]) if (t === TITLES[k] && !found[k]) found[k] = db.id;
  }
  let parent: string | null = null;
  for (const k of Object.keys(TITLES) as DbKey[]) {
    if (found[k]) {
      // Add columns that are missing (e.g. a new family member).
      const db = await N.notion("GET", `/databases/${found[k]}`);
      const missing = Object.fromEntries(Object.entries(schema(k)).filter(([name, def]) => !db.properties?.[name] && !("title" in (def as object))));
      if (Object.keys(missing).length) await N.notion("PATCH", `/databases/${found[k]}`, { properties: missing });
      continue;
    }
    parent ??= await findPage("Weekmenu");
    if (!parent) throw new Error("Notion: pagina 'Weekmenu' niet gevonden. Voeg in Notion de connectie toe aan die pagina (••• → Connecties).");
    const db = await N.notion("POST", "/databases", { parent: { type: "page_id", page_id: parent }, title: [{ text: { content: TITLES[k] } }], properties: schema(k) });
    found[k] = db.id;
  }
  dbCache = { ...(found as Record<DbKey, string>), schemaFor: sig };
  await menuStore().setJSON(DB_KEY, dbCache);
  return dbCache;
}
async function findPage(name: string): Promise<string | null> {
  const res = await N.notion("POST", "/search", { query: name, filter: { property: "object", value: "page" } });
  const page = (res.results ?? []).find((p: any) => {
    const t = Object.values(p.properties ?? {}).find((v: any) => v?.type === "title") as any;
    return !p.archived && t?.title?.map((x: any) => x.plain_text).join("").trim().toLowerCase() === name.toLowerCase();
  });
  return page?.id ?? null;
}
/** Forget cached ids (e.g. after a database was deleted). */
async function resetDbs() {
  dbCache = null;
  await menuStore().delete(DB_KEY);
}
async function withDbs<T>(fn: (d: Dbs) => Promise<T>): Promise<T> {
  try {
    return await fn(await dbs());
  } catch (err) {
    if (/Notion 404/.test(String(err))) {
      await resetDbs();
      return fn(await dbs());
    }
    throw err;
  }
}

async function queryAll(db: string, body: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await N.notion("POST", `/databases/${db}/query`, { ...body, page_size: 100, start_cursor: cursor });
    out.push(...(r.results ?? []).filter((p: any) => !p.archived && !p.in_trash));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Runs fn over items, a few at a time, until the deadline. Returns the items that were not done. */
async function pool<T>(items: T[], fn: (item: T) => Promise<void>, deadline = Infinity, size = 3): Promise<T[]> {
  const queue = [...items];
  const left: T[] = [];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        if (Date.now() > deadline) left.push(item);
        else await fn(item);
      }
    }),
  );
  return left;
}

// ---------- reading Notion properties ----------
const plain = (p: any): string =>
  p?.type === "title" ? p.title.map((x: any) => x.plain_text).join("")
  : p?.type === "rich_text" ? p.rich_text.map((x: any) => x.plain_text).join("")
  : p?.type === "url" ? p.url ?? ""
  : p?.type === "select" ? p.select?.name ?? ""
  : "";
const numOf = (p: any): number | null => (typeof p?.number === "number" ? p.number : null);
const dateOf = (p: any): string => p?.date?.start?.slice(0, 10) ?? "";

function toDay(page: any): Day {
  const P = page.properties;
  return {
    date: dateOf(P.Datum),
    dish: plain(P.Gerecht),
    ingredients: plain(P.Boodschappen),
    picnic: plain(P["Picnic-producten"]),
    notes: plain(P.Bijzonderheden),
    recipeUrl: plain(P.Recept),
    away: Boolean(P["Niet thuis"]?.checkbox),
    editedBy: P[ownerEditProp()]?.checkbox ? "owner" : "claude",
    claudeNote: plain(P["Claude-notitie"]),
    editedAt: page.last_edited_time,
  };
}
const dayWeekId = (page: any) => {
  const w = plain(page.properties.Week).trim();
  return isDate(w) ? w : weekIdFor(dateOf(page.properties.Datum));
};
function toGrocery(page: any): Grocery {
  const P = page.properties;
  return { id: page.id, product: plain(P.Product), amount: numOf(P.Aantal), picnic: plain(P["Picnic-product"]), price: numOf(P.Prijs), status: plain(P.Status) || "gepland", by: plain(P.Door) };
}

// ---------- weeks ----------
export type WeekData = {
  week: Week; feedback: Record<string, PersonFeedback>; guest: GuestFeedback; groceries: Grocery[] | null;
  ctimes: Record<string, string>; // "date|person" → when that reaction was first posted (for the order on screen)
};

/**
 * Reads all weeks with days on or after `from` (and optionally only the given week ids),
 * with everyone's feedback, guest ratings and (for weeks from `groceriesFrom`) the groceries.
 */
export async function loadWeeks(opts: { from?: string; only?: string; groceriesFrom?: string; guestSid?: string } = {}): Promise<WeekData[]> {
  return withDbs(async (D) => {
    const dayFilter = opts.only
      ? { and: [{ property: "Datum", date: { on_or_after: opts.only } }, { property: "Datum", date: { on_or_before: addDays(opts.only, 6) } }] }
      : { property: "Datum", date: { on_or_after: opts.from ?? "1970-01-01" } };
    const dayPages = await queryAll(D.days, { filter: dayFilter, sorts: [{ property: "Datum", direction: "ascending" }] });
    const ids = new Set<string>(dayPages.map(dayWeekId));
    if (opts.only) ids.add(opts.only);
    const idList = [...ids].filter((id) => !opts.only || id === opts.only).sort();
    const weekPages = idList.length ? await queryAll(D.weeks, { filter: { or: idList.map((id) => ({ property: "Week-id", rich_text: { equals: id } })) } }) : [];
    const groceryIds = idList.filter((id) => opts.only || (opts.groceriesFrom && id >= opts.groceriesFrom));
    const groceryPages = groceryIds.length
      ? await queryAll(D.groceries, { filter: { or: groceryIds.map((id) => ({ property: "Week", rich_text: { equals: id } })) }, sorts: [{ timestamp: "created_time", direction: "ascending" }] })
      : [];
    const people = users().map((u) => u.name);

    return Promise.all(
      idList.map(async (id) => {
        const wp = weekPages.find((p) => plain(p.properties["Week-id"]).trim() === id);
        const pages = dayPages.filter((p) => dayWeekId(p) === id);
        const feedback: Record<string, PersonFeedback> = {};
        for (const person of people) {
          const items: Record<string, FeedbackItem> = {};
          for (const p of pages) {
            const rating = numOf(p.properties[person]);
            const comment = plain(p.properties[reactionProp(person)]);
            if (rating !== null || comment) items[dateOf(p.properties.Datum)] = { rating, comment, updatedAt: p.last_edited_time };
          }
          const wc = wp ? plain(wp.properties[reactionProp(person)]) : "";
          if (wc) items.week = { rating: null, comment: wc, updatedAt: wp.last_edited_time };
          if (Object.keys(items).length) feedback[person] = { person, items };
        }
        const days = pages.map(toDay).filter((d) => d.date).sort((a, b) => a.date.localeCompare(b.date));
        return {
          week: {
            id,
            title: (wp && plain(wp.properties.Week)) || `Week van ${id}`,
            status: (wp && plain(wp.properties.Status)) || plain(pages[0]?.properties.Status) || "voorstel",
            delivery: wp ? dateOf(wp.properties.Bezorging) : "",
            days,
            updatedAt: [wp?.last_edited_time, ...pages.map((p) => p.last_edited_time)].filter(Boolean).sort().at(-1) ?? "",
          },
          feedback,
          guest: publicGuest(await getGuestFeedback(id), opts.guestSid),
          ctimes: await getCommentTimes(id),
          groceries: groceryIds.includes(id) ? groceryPages.filter((p) => plain(p.properties.Week).trim() === id).map(toGrocery) : null,
        };
      }),
    );
  });
}

export async function getWeek(id: string): Promise<WeekData | null> {
  if (!isDate(id)) throw new Error("week id moet de vrijdag zijn als JJJJ-MM-DD");
  return (await loadWeeks({ only: id }))[0] ?? null;
}

async function findDayPage(date: string): Promise<any | null> {
  const D = await dbs();
  const pages = await queryAll(D.days, { filter: { property: "Datum", date: { equals: date } } });
  return pages.find((p) => dayWeekId(p) === weekIdFor(date)) ?? pages[0] ?? null;
}
async function findWeekPage(id: string): Promise<any | null> {
  const D = await dbs();
  return (await queryAll(D.weeks, { filter: { property: "Week-id", rich_text: { equals: id } } }))[0] ?? null;
}

function dayProps(d: any, weekId: string, status?: string) {
  return {
    Gerecht: N.title(clip(d.dish, 200)),
    Datum: N.date(d.date),
    Week: N.text(weekId),
    ...(status ? { Status: N.select(status) } : {}),
    Boodschappen: N.text(clip(d.ingredients, 2000)),
    "Picnic-producten": N.text(clip(d.picnic, 4000)),
    Bijzonderheden: N.text(clip(d.notes, 500)),
    Recept: N.url(/^https?:\/\//.test(d.recipeUrl ?? "") ? clip(d.recipeUrl, 500) : ""),
    "Niet thuis": N.checkbox(Boolean(d.away)),
  };
}

/**
 * Claude writes a week. Days the owner edited keep the owner's dish, ingredients, notes, recipe and "away";
 * Claude may still update their Picnic products, status and Claude-notitie.
 * Ratings already known elsewhere can be passed per day (ratings: {"Johan": {rating, comment}}); they only fill empty cells.
 */
export async function putWeekFromClaude(input: {
  id: string; title?: string; status?: string; delivery?: string; note?: string;
  days: any[]; weekReactions?: Record<string, string>; ownerDays?: string[]; deadline?: number;
}) {
  if (!isDate(input.id)) throw new Error("week id moet de vrijdag zijn als JJJJ-MM-DD");
  return withDbs(async (D) => {
    const existing = await queryAll(D.days, {
      filter: { and: [{ property: "Datum", date: { on_or_after: input.id } }, { property: "Datum", date: { on_or_before: addDays(input.id, 6) } }] },
    });
    const byDate = new Map(existing.map((p) => [dateOf(p.properties.Datum), p]));
    const people = users().map((u) => u.name);
    const kept: string[] = [];
    const raws = (input.days ?? []).filter((d) => isDate(d?.date) && d.date >= input.id && d.date <= addDays(input.id, 6));

    const left = await pool(raws, async (raw) => {
      const prev = byDate.get(raw.date);
      const ownerEdited = Boolean(prev?.properties[ownerEditProp()]?.checkbox);
      let props: Record<string, unknown>;
      if (ownerEdited) {
        kept.push(raw.date);
        props = { "Picnic-producten": N.text(clip(raw.picnic ?? plain(prev.properties["Picnic-producten"]), 4000)) };
        if (input.status) props.Status = N.select(input.status);
      } else {
        props = dayProps(raw, input.id, input.status ?? (prev ? undefined : "voorstel"));
        if (input.ownerDays?.includes(raw.date)) props[ownerEditProp()] = N.checkbox(true);
      }
      if (typeof raw.claudeNote === "string") props["Claude-notitie"] = N.text(clip(raw.claudeNote, 1000));
      for (const person of people) {
        const r = raw.ratings?.[person];
        if (!r) continue;
        const rating = Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 10 ? r.rating : null;
        const comment = clip(r.comment, 1000).trim();
        if (rating !== null && numOf(prev?.properties[person]) === null) props[person] = N.num(rating);
        if (comment && !plain(prev?.properties[reactionProp(person)])) props[reactionProp(person)] = N.text(comment);
      }
      if (prev) await N.notion("PATCH", `/pages/${prev.id}`, { properties: props });
      else await N.notion("POST", "/pages", { parent: { database_id: D.days }, properties: props });
    }, input.deadline);

    const wp = await findWeekPage(input.id);
    const wprops: Record<string, unknown> = { "Week-id": N.text(input.id) };
    if (input.title || !wp) wprops.Week = N.title(clip(input.title || `Week van ${input.id}`, 120));
    if (input.status || !wp) wprops.Status = N.select(input.status || "voorstel");
    if (isDate(input.delivery)) wprops.Bezorging = N.date(input.delivery);
    if (typeof input.note === "string") wprops["Claude-notitie"] = N.text(clip(input.note, 2000));
    for (const [person, c] of Object.entries(input.weekReactions ?? {})) {
      if (people.includes(person) && c && !(wp && plain(wp.properties[reactionProp(person)]))) wprops[reactionProp(person)] = N.text(clip(c, 1000));
    }
    if (wp) await N.notion("PATCH", `/pages/${wp.id}`, { properties: wprops });
    else await N.notion("POST", "/pages", { parent: { database_id: D.weeks }, properties: wprops });

    return { saved: input.id, days: raws.length - left.length, notSaved: left.map((d) => d.date), keptOwnerDays: kept.sort() };
  });
}

/** The owner edits one day on the website. */
export async function putDayFromOwner(weekId: string, raw: any) {
  if (!isDate(weekId) || !isDate(raw?.date)) throw new Error("Week of dag niet gevonden");
  return withDbs(async (D) => {
    const prev = await findDayPage(raw.date);
    const props: Record<string, unknown> = { ...dayProps({ ...raw, picnic: prev ? plain(prev.properties["Picnic-producten"]) : "" }, weekId), [ownerEditProp()]: N.checkbox(true) };
    if (!prev) props.Status = N.select("voorstel");
    const page = prev
      ? await N.notion("PATCH", `/pages/${prev.id}`, { properties: props })
      : await N.notion("POST", "/pages", { parent: { database_id: D.days }, properties: props });
    await logEvent({ kind: "owner-edit", week: weekId, date: raw.date, day: dayName(raw.date), dish: clip(raw.dish, 200), person: owner() });
    return toDay(page);
  });
}

// ---------- feedback ----------
const parseRating = (rating: unknown) => {
  const r = rating === null || rating === "" || rating === undefined ? null : Number(rating);
  if (r !== null && !(Number.isInteger(r) && r >= 1 && r <= 10)) throw new Error("Cijfer moet 1 t/m 10 zijn");
  return r;
};

/**
 * A rating for one eaten day (null = remove). Can be changed as often as you like.
 * Everyone sets their own; the owner may also set someone else's.
 */
export async function putRating(actor: string, person: string, weekId: string, date: string, rating: unknown) {
  if (!isDate(weekId) || !isDate(date)) throw new Error("Ongeldige week of dag");
  if (!users().some((u) => u.name === person)) throw new Error("Onbekende persoon");
  if (person !== actor && actor !== owner()) throw new Error("Je kunt alleen je eigen cijfer geven.");
  const r = parseRating(rating);
  if (r !== null && date > today()) throw new Error("Een cijfer kan pas als het gerecht gegeten is");
  return withDbs(async () => {
    const page = await findDayPage(date);
    if (!page || !plain(page.properties.Gerecht) || page.properties["Niet thuis"]?.checkbox) throw new Error("Dit gerecht bestaat niet");
    await N.notion("PATCH", `/pages/${page.id}`, { properties: { [person]: N.num(r) } });
    await logEvent({ kind: "feedback", week: weekId, date, day: dayName(date), dish: plain(page.properties.Gerecht), person, rating: r, ...(person !== actor ? { comment: `(cijfer ingevuld door ${actor})` } : {}) });
    return { person, rating: r };
  });
}

/** A reaction on a dish (or "week" = the whole menu): once per person; after that it can no longer be changed. */
const CTIME = (weekId: string) => `ctime/${weekId}`;
export async function getCommentTimes(weekId: string): Promise<Record<string, string>> {
  return ((await menuStore().get(CTIME(weekId), { type: "json" })) as Record<string, string> | null) ?? {};
}
async function setCommentTime(weekId: string, key: string, at: string | null) {
  const t = await getCommentTimes(weekId);
  if (at && t[key]) return; // keep the original time when a reaction is edited
  if (at) t[key] = at; else delete t[key];
  await menuStore().setJSON(CTIME(weekId), t);
}

/**
 * A reaction on a dish (or "week" = the whole menu). A new one: once per person.
 * edit = change an existing one (your own; the owner may change everyone's); empty text removes it.
 */
export async function putComment(actor: string, person: string, weekId: string, date: string, comment: unknown, edit = false) {
  if (!isDate(weekId) || !(isDate(date) || date === "week")) throw new Error("Ongeldige week of dag");
  if (!users().some((u) => u.name === person)) throw new Error("Onbekende persoon");
  if (person !== actor && actor !== owner()) throw new Error("Je kunt alleen je eigen reactie aanpassen.");
  const text = await polish(clip(comment, 1000).trim());
  if (!text && !edit) throw new Error("Schrijf eerst een reactie");
  return withDbs(async (D) => {
    let dish = "";
    if (date === "week") {
      const wp = await findWeekPage(weekId);
      if (!edit && wp && plain(wp.properties[reactionProp(person)])) throw new Error("Je hebt al gereageerd op dit menu.");
      const props = { [reactionProp(person)]: N.text(text) };
      if (wp) await N.notion("PATCH", `/pages/${wp.id}`, { properties: props });
      else await N.notion("POST", "/pages", { parent: { database_id: D.weeks }, properties: { ...props, Week: N.title(`Week van ${weekId}`), "Week-id": N.text(weekId), Status: N.select("voorstel") } });
    } else {
      const page = await findDayPage(date);
      if (!page) throw new Error("Deze dag staat niet in het menu");
      if (!edit && plain(page.properties[reactionProp(person)])) throw new Error("Je hebt hier al gereageerd. Tik op je reactie om hem aan te passen.");
      dish = plain(page.properties.Gerecht);
      await N.notion("PATCH", `/pages/${page.id}`, { properties: { [reactionProp(person)]: N.text(text) } });
    }
    const at = new Date().toISOString();
    await setCommentTime(weekId, `${date}|${person}`, text ? at : null);
    await logEvent({ kind: "feedback", week: weekId, date, day: date === "week" ? "hele menu" : dayName(date), dish, person, comment: text || "(reactie verwijderd)", ...(person !== actor ? { by: actor } : {}) } as any);
    return { item: text ? ({ comment: text, rating: null, updatedAt: at } as FeedbackItem) : null, ctime: text ? (await getCommentTimes(weekId))[`${date}|${person}`] : null };
  });
}

/**
 * Light spelling fix for a reaction, with LanguageTool's free public service (Dutch). Only clear typos with an obvious
 * correction are changed; names and anything uncertain stay as typed. Without an answer within 2.5 s: unchanged.
 */
export async function polish(text: string): Promise<string> {
  if (!text || Netlify.env.get("MENU_SPELLING") === "off") return text;
  try {
    const res = await fetch("https://api.languagetool.org/v2/check", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text, language: "nl" }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return text;
    const { matches = [] } = (await res.json()) as any;
    let out = text;
    for (const m of [...matches].sort((a: any, b: any) => b.offset - a.offset)) {
      const word = text.slice(m.offset, m.offset + m.length);
      const fix = m.replacements?.[0]?.value as string | undefined;
      if (!fix || m.rule?.issueType !== "misspelling") continue;
      if (/^[A-ZÀ-Þ]/.test(word) || /\d/.test(word) || word.length < 3) continue; // names, numbers, short words
      if (editDistance(word.toLowerCase(), fix.toLowerCase()) > 2) continue;
      out = out.slice(0, m.offset) + fix + out.slice(m.offset + m.length);
    }
    return out;
  } catch {
    return text;
  }
}
function editDistance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// ---------- guest ratings ----------
export async function getGuestFeedback(weekId: string): Promise<GuestFeedback> {
  return ((await menuStore().get(`guest/${weekId}`, { type: "json" })) as GuestFeedback | null) ?? { items: {} };
}
/** Guest ratings without session ids; the viewer's own ones are marked mine. */
function publicGuest(g: GuestFeedback, sid?: string): GuestFeedback {
  return { items: Object.fromEntries(Object.entries(g.items).map(([d, list]) => [d, list.map(({ sid: s, ...rest }) => ({ ...rest, ...(sid && s === sid ? { mine: true } : {}) }))])) };
}

/** How many new ratings the guest account may still give in the current 24 hours. */
export async function guestQuotaLeft(): Promise<number> {
  const log = ((await menuStore().get("guest/quota", { type: "json" })) as string[] | null) ?? [];
  return Math.max(0, GUEST_PER_DAY - log.filter((t) => Date.now() - Date.parse(t) < 864e5).length);
}

async function guestDish(date: string) {
  const page = await findDayPage(date);
  const dish = page ? plain(page.properties.Gerecht) : "";
  if (!page || !dish || page.properties["Niet thuis"]?.checkbox) throw new Error("Dit gerecht bestaat niet");
  return { page, dish };
}

/**
 * A guest rates an eaten dish. Changing it again in the same session updates that rating
 * (and does not use up another of the 3 ratings per day).
 */
export async function putGuestRating(sid: string, weekId: string, date: string, rating: unknown) {
  if (!isDate(weekId) || !isDate(date)) throw new Error("Ongeldige week of dag");
  if (date > today()) throw new Error("Een cijfer kan pas als het gerecht gegeten is");
  const r = Number(rating);
  if (!(Number.isInteger(r) && r >= 1 && r <= 10)) throw new Error("Kies een cijfer van 1 t/m 10");
  const s = menuStore();
  const g = await getGuestFeedback(weekId);
  const list = (g.items[date] ??= []);
  const own = sid ? list.find((x) => x.sid === sid) : undefined;
  const log = (((await s.get("guest/quota", { type: "json" })) as string[] | null) ?? []).filter((t) => Date.now() - Date.parse(t) < 864e5);
  if (!own && log.length >= GUEST_PER_DAY) throw new Error(`Als gast kun je ${GUEST_PER_DAY} cijfers per dag geven. Morgen kan het weer.`);
  return withDbs(async () => {
    const { page, dish } = await guestDish(date);
    const at = new Date().toISOString();
    if (own) Object.assign(own, { rating: r, at });
    else list.push({ rating: r, comment: "", at, sid });
    g.items[date] = list.slice(-20);
    await s.setJSON(`guest/${weekId}`, g);
    if (!own) {
      log.push(at);
      await s.setJSON("guest/quota", log);
    }
    await writeGuestSummary(page.id, g.items[date]);
    await logEvent({ kind: "guest", week: weekId, date, day: dayName(date), dish, person: GUEST, rating: r });
    return publicGuest(g, sid);
  });
}

/** A guest's reaction on a dish they rated in this session: once. */
/** A guest's reaction on a dish they rated in this session (once; edit = change it, empty removes it). */
export async function putGuestComment(sid: string, weekId: string, date: string, comment: unknown, edit = false) {
  if (!isDate(weekId) || !isDate(date)) throw new Error("Ongeldige week of dag");
  const text = await polish(clip(comment, 1000).trim());
  if (!text && !edit) throw new Error("Schrijf eerst een reactie");
  const g = await getGuestFeedback(weekId);
  const own = sid ? (g.items[date] ?? []).find((x) => x.sid === sid) : undefined;
  if (!own) throw new Error("Geef eerst een cijfer");
  if (own.comment && !edit) throw new Error("Je hebt hier al gereageerd. Tik op je reactie om hem aan te passen.");
  return withDbs(async () => {
    const { page, dish } = await guestDish(date);
    own.comment = text;
    if (text && !own.commentAt) own.commentAt = new Date().toISOString();
    await menuStore().setJSON(`guest/${weekId}`, g);
    await writeGuestSummary(page.id, g.items[date]);
    await logEvent({ kind: "guest", week: weekId, date, day: dayName(date), dish, person: GUEST, rating: own.rating, comment: text });
    return publicGuest(g, sid);
  });
}

/**
 * The owner changes guest ratings and reactions for a day: index = which guest (null = a new one, e.g. a visitor
 * without a phone). rating null removes that guest's rating altogether. No daily limit for the owner.
 */
export async function putGuestByOwner(weekId: string, date: string, index: number | null, change: { rating?: unknown; comment?: unknown }) {
  if (!isDate(weekId) || !isDate(date)) throw new Error("Ongeldige week of dag");
  const g = await getGuestFeedback(weekId);
  const list = (g.items[date] ??= []);
  return withDbs(async () => {
    const { page, dish } = await guestDish(date);
    const at = new Date().toISOString();
    if ("rating" in change) {
      const r = change.rating === null ? null : Number(change.rating);
      if (r !== null && !(Number.isInteger(r) && r >= 1 && r <= 10)) throw new Error("Cijfer moet 1 t/m 10 zijn");
      if (r !== null && date > today()) throw new Error("Een cijfer kan pas als het gerecht gegeten is");
      if (index === null || !list[index]) { if (r !== null) list.push({ rating: r, comment: "", at, sid: "owner-" + randomBytes(4).toString("hex") }); }
      else if (r === null) list.splice(index, 1);
      else Object.assign(list[index], { rating: r, at });
    }
    if ("comment" in change) {
      if (index === null || !list[index]) throw new Error("Deze gast heeft nog geen cijfer");
      const text = await polish(clip(change.comment, 1000).trim());
      list[index].comment = text;
      if (text && !list[index].commentAt) list[index].commentAt = at;
    }
    await menuStore().setJSON(`guest/${weekId}`, g);
    await writeGuestSummary(page.id, list);
    await logEvent({ kind: "guest", week: weekId, date, day: dayName(date), dish, person: GUEST, comment: `(aangepast door ${owner()})` });
    return publicGuest(g);
  });
}
async function writeGuestSummary(pageId: string, list: GuestItem[]) {
  const avg = list.length ? Math.round((list.reduce((a, x) => a + x.rating, 0) / list.length) * 10) / 10 : null;
  await N.notion("PATCH", `/pages/${pageId}`, {
    properties: { Gast: N.num(avg), "Gast aantal": N.num(list.length || null), "Gast reacties": N.text(list.filter((x) => x.comment).map((x) => `${x.rating}: ${x.comment}`).join("\n")) },
  });
}

// ---------- standard groceries ----------
export async function listGroceries(weekId: string): Promise<Grocery[]> {
  return withDbs(async (D) =>
    (await queryAll(D.groceries, { filter: { property: "Week", rich_text: { equals: weekId } }, sorts: [{ timestamp: "created_time", direction: "ascending" }] })).map(toGrocery),
  );
}

/** A family member suggests a product (the owner's own suggestions are approved straight away). */
export async function suggestGrocery(person: string, weekId: string, product: unknown, amount: unknown) {
  const name = clip(product, 120).trim();
  if (!isDate(weekId) || !name) throw new Error("Vul een product in");
  const n = amount === undefined || amount === null || amount === "" ? null : Number(amount);
  if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 50)) throw new Error("Aantal moet 1 t/m 50 zijn");
  return withDbs(async (D) => {
    await N.notion("POST", "/pages", {
      parent: { database_id: D.groceries },
      properties: { Product: N.title(name), Week: N.text(weekId), Aantal: N.num(n), Status: N.select(person === owner() ? "goedgekeurd" : "voorstel"), Door: N.select(person) },
    });
    await logEvent({ kind: "suggestion", week: weekId, person, product: name, comment: n ? `${n}×` : "" });
    return listGroceries(weekId);
  });
}

/** The owner approves or rejects a product; the suggester may withdraw their own open suggestion. */
export async function changeGrocery(person: string, id: unknown, action: unknown) {
  if (typeof id !== "string" || !/^[0-9a-f-]{32,36}$/i.test(id)) throw new Error("Onbekend product");
  return withDbs(async (D) => {
    const page = await N.notion("GET", `/pages/${id}`);
    if (page.parent?.database_id?.replace(/-/g, "") !== D.groceries.replace(/-/g, "")) throw new Error("Onbekend product");
    const g = toGrocery(page);
    const weekId = plain(page.properties.Week).trim();
    const isOwner = person === owner();
    if (action === "remove") {
      if (!isOwner && !(g.by === person && g.status === "voorstel")) throw new Error("Alleen je eigen voorstel kun je weghalen.");
      await N.notion("PATCH", `/pages/${id}`, { archived: true });
    } else {
      if (!isOwner) throw new Error(`Alleen ${owner()} kan producten goedkeuren.`);
      if (!["goedgekeurd", "afgewezen", "gepland"].includes(String(action))) throw new Error("Onbekende actie");
      await N.notion("PATCH", `/pages/${id}`, { properties: { Status: N.select(String(action)) } });
    }
    return { weekId, groceries: await listGroceries(weekId) };
  });
}

/**
 * Claude plans the standard groceries for a week. Existing rows of the same product are updated
 * (a product the owner rejected stays rejected); with replace, Claude's planned products that are not in the
 * new list are removed. Family suggestions are never touched.
 */
export async function putGroceriesFromClaude(weekId: string, items: { product: string; amount?: number | null; picnic?: string; price?: number | null }[], replace: boolean, deadline?: number) {
  if (!isDate(weekId)) throw new Error("week id moet de vrijdag zijn als JJJJ-MM-DD");
  return withDbs(async (D) => {
    const rows = await queryAll(D.groceries, { filter: { property: "Week", rich_text: { equals: weekId } } });
    const key = (s: string) => s.trim().toLowerCase();
    const byName = new Map(rows.map((p) => [key(plain(p.properties.Product)), p]));
    const wanted = new Set(items.map((i) => key(i.product)));
    const work: (() => Promise<void>)[] = [];
    for (const it of items) {
      const prev = byName.get(key(it.product));
      const props: Record<string, unknown> = { "Picnic-product": N.text(clip(it.picnic, 500)) };
      if (it.amount != null || !prev) props.Aantal = N.num(it.amount ?? null);
      if (it.price != null) props.Prijs = N.num(Math.round(it.price * 100) / 100);
      if (prev) work.push(() => N.notion("PATCH", `/pages/${prev.id}`, { properties: props }));
      else work.push(() => N.notion("POST", "/pages", { parent: { database_id: D.groceries }, properties: { ...props, Product: N.title(clip(it.product, 120)), Week: N.text(weekId), Status: N.select("gepland"), Door: N.select("Claude") } }));
    }
    if (replace) {
      for (const p of rows) {
        const g = toGrocery(p);
        if (g.by === "Claude" && g.status === "gepland" && !wanted.has(key(g.product))) work.push(() => N.notion("PATCH", `/pages/${p.id}`, { archived: true }));
      }
    }
    const left = await pool(work, (f) => f(), deadline);
    return { week: weekId, changes: work.length - left.length, notDone: left.length };
  });
}

// ---------- change log for Claude ----------
async function logEvent(e: Omit<MenuEvent, "at">) {
  const at = new Date().toISOString();
  await menuStore().setJSON(`events/${at}-${randomBytes(3).toString("hex")}`, { at, ...e });
}
const MARKERS = { menu: "meta/menuProcessedAt", ratings: "meta/ratingsProcessedAt" } as const;
export type Consumer = keyof typeof MARKERS;

export async function getUpdates(consumer: Consumer, since?: string) {
  const s = menuStore();
  const from = since ?? (((await s.get(MARKERS[consumer], { type: "text" })) as string | null) || "1970-01-01T00:00:00Z");
  const { blobs } = await s.list({ prefix: "events/" });
  const keys = blobs.map((b) => b.key).filter((k) => k.slice(7) > from).sort();
  const items = (await Promise.all(keys.map((k) => s.get(k, { type: "json" })))).filter(Boolean) as MenuEvent[];
  return { since: from, now: new Date().toISOString(), items };
}

export async function markProcessed(consumer: Consumer, until: string) {
  const s = menuStore();
  await s.set(MARKERS[consumer], until);
  // Tidy up: events older than 60 days that both consumers have seen.
  const other = ((await s.get(MARKERS[consumer === "menu" ? "ratings" : "menu"], { type: "text" })) as string | null) ?? "";
  const cutoff = [until, other, new Date(Date.now() - 60 * 864e5).toISOString()].sort()[0];
  const { blobs } = await s.list({ prefix: "events/" });
  for (const b of blobs) if (b.key.slice(7) < cutoff) await s.delete(b.key);
  return { processedUntil: until };
}

// ---------- one-time move of the menu data that was kept in Blobs before ----------
type OldWeek = { id: string; title: string; status: string; days: any[] };
type OldFeedback = { person: string; items: Record<string, { comment: string; rating: number | null }> };
const MIGRATION_KEY = "meta/migration";

export async function migrationPending(): Promise<boolean> {
  const m = (await menuStore().get(MIGRATION_KEY, { type: "json" })) as { finished?: boolean } | null;
  return !m?.finished;
}

/** Copies the weeks that were stored in Blobs into the Notion databases, a few weeks per run. */
export async function migrateFromBlobs(deadline: number) {
  const s = menuStore();
  const state = ((await s.get(MIGRATION_KEY, { type: "json" })) as { done: string[]; finished?: boolean } | null) ?? { done: [] };
  if (state.finished) return state;
  const { blobs } = await s.list({ prefix: "weeks/" });
  const ids = blobs.map((b) => b.key.slice(6)).filter(isDate).sort();
  for (const id of ids) {
    if (state.done.includes(id)) continue;
    if (Date.now() > deadline - 8000) return state;
    const w = (await s.get(`weeks/${id}`, { type: "json" })) as OldWeek | null;
    if (!w) { state.done.push(id); continue; }
    const fb: OldFeedback[] = [];
    for (const u of users()) {
      const f = (await s.get(`feedback/${id}/${u.name.toLowerCase()}`, { type: "json" })) as OldFeedback | null;
      if (f) fb.push({ ...f, person: u.name });
    }
    const days = w.days.map((d) => ({
      ...d,
      dish: d.dish === "AGV-donderdag" ? "AGV" : d.dish,
      ratings: Object.fromEntries(fb.filter((f) => f.items[d.date]).map((f) => [f.person, f.items[d.date]])),
    }));
    const weekReactions = Object.fromEntries(fb.filter((f) => f.items.week?.comment).map((f) => [f.person, f.items.week.comment]));
    const status = DAY_STATUS.includes(w.status) ? w.status : undefined;
    await putWeekFromClaude({ id, title: w.title, status, days, weekReactions, ownerDays: w.days.filter((d) => d.editedBy === "owner").map((d) => d.date) });
    const g = await getGuestFeedback(id);
    for (const [date, list] of Object.entries(g.items)) {
      const page = list.length ? await findDayPage(date) : null;
      if (page) await writeGuestSummary(page.id, list);
    }
    state.done.push(id);
    await s.setJSON(MIGRATION_KEY, state);
  }
  state.finished = true;
  await s.setJSON(MIGRATION_KEY, state);
  return state;
}

// ---------- daily status update ----------
const TICK_KEY = "meta/statusTick";

/**
 * Once a day (called by the scheduled function): days before today become "gegeten"; weeks in the cart become
 * "besteld" from their delivery day (the Thursday before the week); a week whose days are all past becomes "gegeten".
 */
export async function advanceStatuses(): Promise<string | null> {
  if (!N.notionConfigured()) return null;
  const t = today();
  if (((await menuStore().get(TICK_KEY, { type: "text" })) as string | null) === t) return null;
  return withDbs(async (D) => {
    let changed = 0;
    const set = async (id: string, status: string) => { await N.notion("PATCH", `/pages/${id}`, { properties: { Status: N.select(status) } }); changed++; };
    const days = await queryAll(D.days, { filter: { property: "Status", select: { does_not_equal: "gegeten" } } });
    for (const p of days) {
      const date = dateOf(p.properties.Datum);
      const status = plain(p.properties.Status);
      if (date && date < t) await set(p.id, "gegeten");
      else if (status === "in winkelmand" && addDays(dayWeekId(p), -1) <= t) await set(p.id, "besteld");
    }
    for (const p of await queryAll(D.weeks, { filter: { property: "Status", select: { does_not_equal: "gegeten" } } })) {
      const id = plain(p.properties["Week-id"]).trim();
      if (!isDate(id)) continue;
      const status = plain(p.properties.Status);
      if (addDays(id, 6) < t) await set(p.id, "gegeten");
      else if (status === "in winkelmand" && addDays(id, -1) <= t) await set(p.id, "besteld");
    }
    await menuStore().set(TICK_KEY, t);
    return `${t}: ${changed} statussen bijgewerkt`;
  });
}

// ---------- recipes from the overview page (for the owner's "pick a dish" list) ----------
export type Recipe = { name: string; category: string; ingredients: string; recipeUrl: string };
const RECIPES_KEY = "meta/recipes";
const RECIPES_TTL = 6 * 3600_000;

/**
 * Reads the tables on the overview page (default: the page titled "Maaltijden", or MENU_RECIPES_PAGE): per row the
 * dish (first line of the first column), the ingredients (second column, without the pantry items in brackets)
 * and the first link in the recipe column. Cached for 6 hours.
 */
export async function listRecipes(refresh = false): Promise<Recipe[]> {
  const cached = (await menuStore().get(RECIPES_KEY, { type: "json" })) as { at: number; items: Recipe[] } | null;
  if (!refresh && cached && Date.now() - cached.at < RECIPES_TTL) return cached.items;
  const pageId = Netlify.env.get("MENU_RECIPES_PAGE")?.trim() || (await findPage("Maaltijden"));
  if (!pageId) throw new Error("Notion: pagina 'Maaltijden' niet gevonden. Voeg de connectie toe aan die pagina (••• → Connecties).");
  const children = async (id: string) => {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const r = await N.notion("GET", `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
      out.push(...(r.results ?? []));
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    return out;
  };
  const cellText = (cell: any[]) => (cell ?? []).map((t: any) => t.plain_text).join("");
  const cellLink = (cell: any[]) => (cell ?? []).map((t: any) => t.href || (t.plain_text.match(/https?:\/\/\S+/) ?? [])[0]).find(Boolean) ?? "";
  const items: Recipe[] = [];
  let category = "";
  const walk = async (blocks: any[], depth: number) => {
    for (const b of blocks) {
      if (b.type?.startsWith("heading_")) category = cellText(b[b.type].rich_text).replace(/^[^\p{L}]+/u, "").trim();
      else if (b.type === "table") {
        const rows = await children(b.id);
        for (const row of rows.slice(b.table.has_column_header ? 1 : 0)) {
          const cells = row.table_row?.cells ?? [];
          const name = cellText(cells[0]).split("\n")[0].replace(/\(?🌱\)?|🐟/gu, "").replace(/\s+/g, " ").trim();
          if (!name) continue;
          const ingredients = cellText(cells[1]).split("\n").map((l) => l.replace(/^[\s•·-]+/, "").trim()).filter((l) => l && !/^\(.*\)$/.test(l)).join(", ");
          items.push({ name, category, ingredients, recipeUrl: cellLink(cells[2]) });
        }
      } else if (b.has_children && depth < 2 && !["child_page", "child_database", "table"].includes(b.type)) {
        await walk(await children(b.id), depth + 1);
      }
    }
  };
  await walk(await children(pageId), 0);
  await menuStore().setJSON(RECIPES_KEY, { at: Date.now(), items });
  return items;
}
