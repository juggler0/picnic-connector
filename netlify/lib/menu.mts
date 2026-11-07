/**
 * Family menu website: storage, users and sessions.
 *
 * Data lives in Netlify Blobs (store "menu"):
 *   weeks/<friday-date>                 the menu of one week (Friday to Thursday)
 *   feedback/<friday-date>/<person>     one person's feedback and ratings for that week
 *   auth/fails/<person>                 failed login attempts (brief lockout)
 *   meta/ratingsProcessedAt             until when Claude processed ratings into Notion
 *
 * Users come from the MENU_USERS env var, e.g. "Johan:1234,Andrea:5678,Laura:1111,Merle:2222".
 * The first name (or MENU_OWNER) is the owner: the only one who may change dishes and ingredients.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

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
  editedAt: string;
};
export type Week = { id: string; title: string; status: string; days: Day[]; updatedAt: string };
export type FeedbackItem = { comment: string; rating: number | null; updatedAt: string };
export type PersonFeedback = { person: string; items: Record<string, FeedbackItem>; extras?: string; extrasUpdatedAt?: string };

const DAY_NAMES = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
export const dayName = (date: string) => DAY_NAMES[new Date(date + "T12:00:00Z").getUTCDay()];
export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");

// ---------- users ----------
export function users(): { name: string; pin: string }[] {
  return (Netlify.env.get("MENU_USERS") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [name, pin] = x.split(":").map((s) => s.trim());
      return { name, pin: pin ?? "" };
    })
    .filter((u) => u.name && /^\d{4,8}$/.test(u.pin));
}
export const owner = () => Netlify.env.get("MENU_OWNER")?.trim() || users()[0]?.name || "";
export const findUser = (name: string) => users().find((u) => u.name.toLowerCase() === String(name).trim().toLowerCase());

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------- sessions: "name.expiry.signature" in an HttpOnly cookie ----------
const SESSION_DAYS = 120;
const sessionKey = () => createHmac("sha256", Netlify.env.get("CONNECTOR_SECRET") ?? "").update("menu-session-v1").digest();
const sign = (payload: string) => createHmac("sha256", sessionKey()).update(payload).digest("base64url");

export function makeSession(name: string) {
  const payload = `${Buffer.from(name).toString("base64url")}.${Date.now() + SESSION_DAYS * 864e5}`;
  return `${payload}.${sign(payload)}`;
}
export function readSession(req: Request): string | null {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)menu_session=([^;]+)/);
  if (!m || !(Netlify.env.get("CONNECTOR_SECRET")?.length ?? 0)) return null;
  const [n, exp, sig] = m[1].split(".");
  if (!n || !exp || !sig || !eq(sig, sign(`${n}.${exp}`)) || Number(exp) < Date.now()) return null;
  const name = Buffer.from(n, "base64url").toString();
  return findUser(name)?.name ?? null; // a removed user is logged out
}
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
  if (fails.count >= 8) return { ok: false, error: "Te vaak een verkeerde pincode. Probeer het over een half uur opnieuw." };
  if (!eq(String(pin), user.pin)) {
    fails.count += 1;
    await s.setJSON(key, fails);
    return { ok: false, error: "Verkeerde pincode." };
  }
  await s.delete(key);
  return { ok: true, name: user.name };
}

// ---------- weeks ----------
export async function getWeek(id: string): Promise<Week | null> {
  return (await menuStore().get(`weeks/${id}`, { type: "json" })) as Week | null;
}
export async function listWeekIds(): Promise<string[]> {
  const { blobs } = await menuStore().list({ prefix: "weeks/" });
  return blobs.map((b) => b.key.slice(6)).filter(isDate).sort();
}

const cleanDay = (d: any, editedBy: Day["editedBy"]): Day => ({
  date: d.date,
  dish: clip(d.dish, 200),
  ingredients: clip(d.ingredients, 2000),
  picnic: clip(d.picnic, 3000),
  notes: clip(d.notes, 500),
  recipeUrl: /^https?:\/\//.test(d.recipeUrl ?? "") ? clip(d.recipeUrl, 500) : "",
  away: Boolean(d.away),
  editedBy,
  editedAt: new Date().toISOString(),
});

/**
 * Claude writes a week. Days the owner edited on the website keep the owner's dish, ingredients,
 * notes, recipe and "away"; Claude may still update the Picnic products of those days.
 */
export async function putWeekFromClaude(input: { id: string; title?: string; status?: string; days: any[] }) {
  if (!isDate(input.id)) throw new Error("week id moet de vrijdag zijn als JJJJ-MM-DD");
  const old = await getWeek(input.id);
  const byDate = new Map((old?.days ?? []).map((d) => [d.date, d]));
  const kept: string[] = [];
  for (const raw of input.days ?? []) {
    if (!isDate(raw?.date)) continue;
    const prev = byDate.get(raw.date);
    if (prev?.editedBy === "owner") {
      byDate.set(raw.date, { ...prev, picnic: clip(raw.picnic ?? prev.picnic, 3000) });
      kept.push(raw.date);
    } else {
      byDate.set(raw.date, cleanDay(raw, "claude"));
    }
  }
  const week: Week = {
    id: input.id,
    title: clip(input.title ?? old?.title ?? `Week van ${input.id}`, 120),
    status: clip(input.status ?? old?.status ?? "voorstel", 40),
    days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    updatedAt: new Date().toISOString(),
  };
  await menuStore().setJSON(`weeks/${week.id}`, week);
  return { week, keptOwnerDays: kept };
}

/** The owner edits one day on the website. */
export async function putDayFromOwner(weekId: string, raw: any) {
  const week = await getWeek(weekId);
  if (!week || !isDate(raw?.date)) throw new Error("Week of dag niet gevonden");
  const prev = week.days.find((d) => d.date === raw.date);
  const day = cleanDay({ ...prev, ...raw, picnic: prev?.picnic ?? "" }, "owner");
  week.days = [...week.days.filter((d) => d.date !== raw.date), day].sort((a, b) => a.date.localeCompare(b.date));
  week.updatedAt = new Date().toISOString();
  await menuStore().setJSON(`weeks/${weekId}`, week);
  return day;
}

// ---------- feedback ----------
export async function getFeedback(weekId: string): Promise<Record<string, PersonFeedback>> {
  const out: Record<string, PersonFeedback> = {};
  for (const u of users()) {
    const f = (await menuStore().get(`feedback/${weekId}/${u.name.toLowerCase()}`, { type: "json" })) as PersonFeedback | null;
    if (f) out[u.name] = f;
  }
  return out;
}

/** A person changes only their own feedback for one day. */
export async function putOwnFeedback(person: string, weekId: string, date: string, comment: unknown, rating: unknown) {
  if (!isDate(weekId) || !isDate(date)) throw new Error("Ongeldige week of dag");
  const key = `feedback/${weekId}/${person.toLowerCase()}`;
  const f = ((await menuStore().get(key, { type: "json" })) as PersonFeedback | null) ?? { person, items: {} };
  const r = rating === null || rating === "" || rating === undefined ? null : Number(rating);
  if (r !== null && !(Number.isInteger(r) && r >= 1 && r <= 10)) throw new Error("Cijfer moet 1 t/m 10 zijn");
  if (r !== null && date > today()) throw new Error("Een cijfer kan pas als het gerecht gegeten is");
  const text = clip(comment, 1000).trim();
  if (!text && r === null) delete f.items[date];
  else f.items[date] = { comment: text, rating: r, updatedAt: new Date().toISOString() };
  await menuStore().setJSON(key, f);
  return f;
}

/** A person changes only their own "extra boodschappen" for a week (free text, one item per line). */
export async function putOwnExtras(person: string, weekId: string, extras: unknown) {
  if (!isDate(weekId)) throw new Error("Ongeldige week");
  const key = `feedback/${weekId}/${person.toLowerCase()}`;
  const f = ((await menuStore().get(key, { type: "json" })) as PersonFeedback | null) ?? { person, items: {} };
  f.extras = clip(extras, 1000).trim();
  f.extrasUpdatedAt = new Date().toISOString();
  await menuStore().setJSON(key, f);
  return f;
}

/** Today's date in the Netherlands. */
export const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
