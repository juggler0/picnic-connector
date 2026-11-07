/**
 * API behind the family menu website (public/menu/index.html).
 *   GET  /api/menu/people                        → first names for the login screen (public)
 *   POST /api/menu/login     {name, pin}         → sets the session cookie
 *   POST /api/menu/guest                         → guest session (read everything, a few ratings per day)
 *   POST /api/menu/logout
 *   GET  /api/menu/state                         → weeks + everyone's feedback (logged in)
 *   POST /api/menu/feedback  {weekId, date, comment, rating}   → own feedback only (date "week" = the whole menu)
 *   POST /api/menu/day       {weekId, day}       → owner only: change a dish / ingredients
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
      return json({ people: M.users().map((u) => u.name) });
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
      const from = new Date(Date.now() - WEEKS_BACK_DAYS * 864e5).toISOString().slice(0, 10);
      const ids = (await M.listWeekIds()).filter((id) => id >= from);
      const weeks = await Promise.all(
        ids.map(async (id) => ({ week: await M.getWeek(id), feedback: await M.getFeedback(id), guest: await M.getGuestFeedback(id) })),
      );
      return json({
        me, isOwner, isGuest, owner: M.owner(), people: M.users().map((u) => u.name), today: M.today(), weeks,
        guestLeft: isGuest ? await M.guestQuotaLeft() : null,
      });
    }

    if (action === "feedback" && req.method === "POST") {
      const { weekId, date, comment, rating } = await req.json();
      if (isGuest) return json({ ok: true, guest: await M.putGuestRating(weekId, date, rating, comment), guestLeft: await M.guestQuotaLeft() });
      return json({ ok: true, feedback: await M.putOwnFeedback(me, weekId, date, comment, rating) });
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
