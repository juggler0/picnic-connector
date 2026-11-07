/**
 * API behind the family menu website (public/menu/index.html).
 *   POST /api/menu/login     {name, pin}         → sets the session cookie
 *   POST /api/menu/logout
 *   GET  /api/menu/state                         → weeks + everyone's feedback (logged in)
 *   POST /api/menu/feedback  {weekId, date, comment, rating}   → own feedback only
 *   POST /api/menu/extras    {weekId, extras}    → own extra groceries for that week
 *   POST /api/menu/day       {weekId, day}       → owner only: change a dish / ingredients
 */
import type { Config, Context } from "@netlify/functions";
import * as M from "../lib/menu.mts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const WEEKS_BACK_DAYS = 56; // show the last 8 weeks

export default async (req: Request, context: Context) => {
  const action = context.params.action;
  // Simple CSRF guard: the page always sends this header; a foreign form cannot.
  if (req.method === "POST" && req.headers.get("x-menu") !== "1") return json({ error: "Niet toegestaan" }, 403);

  try {
    if (action === "login" && req.method === "POST") {
      if (!M.users().length) return json({ error: "Er zijn nog geen gebruikers ingesteld (MENU_USERS in Netlify)." }, 500);
      const { name, pin } = await req.json();
      const r = await M.checkLogin(String(name ?? ""), String(pin ?? ""));
      if (!r.ok) return json({ error: r.error }, 401);
      return json({ ok: true, name: r.name }, 200, { "set-cookie": M.sessionCookie(M.makeSession(r.name)) });
    }
    if (action === "logout" && req.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": M.sessionCookie("", 0) });
    }

    const me = M.readSession(req);
    if (!me) return json({ error: "Niet ingelogd" }, 401);
    const isOwner = me === M.owner();

    if (action === "state" && req.method === "GET") {
      const from = new Date(Date.now() - WEEKS_BACK_DAYS * 864e5).toISOString().slice(0, 10);
      const ids = (await M.listWeekIds()).filter((id) => id >= from);
      const weeks = await Promise.all(
        ids.map(async (id) => ({ week: await M.getWeek(id), feedback: await M.getFeedback(id) })),
      );
      return json({ me, isOwner, owner: M.owner(), people: M.users().map((u) => u.name), today: M.today(), weeks });
    }

    if (action === "feedback" && req.method === "POST") {
      const { weekId, date, comment, rating } = await req.json();
      const f = await M.putOwnFeedback(me, weekId, date, comment, rating);
      return json({ ok: true, feedback: f });
    }

    if (action === "extras" && req.method === "POST") {
      const { weekId, extras } = await req.json();
      return json({ ok: true, feedback: await M.putOwnExtras(me, weekId, extras) });
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
