/**
 * API behind the family menu website (public/menu/index.html).
 *   GET  /api/menu/people                        → first names for the login screen (public); only the owner needs a PIN
 *   POST /api/menu/login     {name, pin}         → sets the session cookie
 *   POST /api/menu/guest                         → guest session (read everything, a few ratings per day)
 *   POST /api/menu/logout
 *   GET  /api/menu/state                         → weeks + everyone's feedback + groceries (logged in)
 *   POST /api/menu/rating    {weekId, date, rating, person?}   → a rating, change any time (owner may rate for others)
 *   POST /api/menu/comment   {weekId, date, comment}           → a reaction, once per person per dish (date "week" = the whole menu)
 *   POST /api/menu/day       {weekId, day}       → owner only: change a dish / ingredients
 *   POST /api/menu/grocery   {weekId, product, amount}         → suggest a product (owner: approved straight away)
 *   POST /api/menu/grocery-status {id, action}   → owner: goedgekeurd/afgewezen/gepland; anyone: "remove" own suggestion
 * Everything is read from and written to Notion straight away (see netlify/lib/menu.mts).
 */
import type { Config, Context } from "@netlify/functions";
import * as M from "../lib/menu.mts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const WEEKS_BACK_DAYS = 70; // show the last 10 weeks

export default async (req: Request, context: Context) => {
  const action = context.params.action;
  // Simple CSRF guard: the page always sends this header; a foreign form cannot.
  if (req.method === "POST" && req.headers.get("x-menu") !== "1") return json({ error: "Niet toegestaan" }, 403);

  try {
    if (action === "people" && req.method === "GET") {
      return json({ people: M.users().map((u) => u.name), pin: M.users().filter((u) => M.needsPin(u.name)).map((u) => u.name) });
    }
    if (action === "login" && req.method === "POST") {
      if (!M.users().length) return json({ error: "Er zijn nog geen gebruikers ingesteld (MENU_USERS in Netlify)." }, 500);
      const { name, pin } = await req.json();
      const r = await M.checkLogin(String(name ?? ""), String(pin ?? ""));
      if (!r.ok) return json({ error: r.error }, 401);
      return json({ ok: true, name: r.name }, 200, { "set-cookie": M.sessionCookie(M.makeSession(r.name)) });
    }
    if (action === "guest" && req.method === "POST") {
      return json({ ok: true, name: M.GUEST }, 200, { "set-cookie": M.sessionCookie(M.makeSession(M.GUEST, 7), 7) });
    }
    if (action === "logout" && req.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": M.sessionCookie("", 0) });
    }

    const me = M.readSession(req);
    if (!me) return json({ error: "Niet ingelogd" }, 401);
    const isGuest = me === M.GUEST;
    const isOwner = !isGuest && me === M.owner();

    if (action === "state" && req.method === "GET") {
      const t = M.today();
      const weeks = await M.loadWeeks({
        from: M.addDays(t, -WEEKS_BACK_DAYS),
        groceriesFrom: M.weekIdFor(t), // groceries for the current week and the ones after it
        guestSid: isGuest ? M.guestSessionId(req) : undefined,
      });
      return json({
        me, isOwner, isGuest, owner: M.owner(), people: M.users().map((u) => u.name), today: t, weeks,
        guestLeft: isGuest ? await M.guestQuotaLeft() : null,
      });
    }

    if (action === "rating" && req.method === "POST") {
      const { weekId, date, rating, person } = await req.json();
      if (isGuest) return json({ ok: true, guest: await M.putGuestRating(M.guestSessionId(req), weekId, date, rating), guestLeft: await M.guestQuotaLeft() });
      return json({ ok: true, ...(await M.putRating(me, String(person || me), weekId, date, rating)) });
    }

    if (action === "comment" && req.method === "POST") {
      const { weekId, date, comment } = await req.json();
      if (isGuest) return json({ ok: true, guest: await M.putGuestComment(M.guestSessionId(req), weekId, date, comment) });
      return json({ ok: true, item: await M.putComment(me, weekId, date, comment) });
    }

    if (action === "grocery" && req.method === "POST") {
      if (isGuest) return json({ error: "Gasten kunnen geen boodschappen voorstellen." }, 403);
      const { weekId, product, amount } = await req.json();
      return json({ ok: true, groceries: await M.suggestGrocery(me, weekId, product, amount) });
    }

    if (action === "grocery-status" && req.method === "POST") {
      if (isGuest) return json({ error: "Niet toegestaan" }, 403);
      const { id, action: what } = await req.json();
      return json({ ok: true, ...(await M.changeGrocery(me, id, what)) });
    }

    if (action === "day" && req.method === "POST") {
      if (!isOwner) return json({ error: "Alleen " + M.owner() + " kan gerechten aanpassen." }, 403);
      const { weekId, day } = await req.json();
      return json({ ok: true, day: await M.putDayFromOwner(weekId, day) });
    }

    return json({ error: "Onbekende actie" }, 404);
  } catch (err) {
    console.error("menu api:", action, err);
    return json({ error: err instanceof Error ? err.message : "Er ging iets mis" }, 400);
  }
};

export const config: Config = {
  path: "/api/menu/:action",
  rateLimit: { windowSize: 60, windowLimit: 60, aggregateBy: ["ip", "domain"] },
};
