import type { Config, Context } from "@netlify/functions";
import { AUTH_KEY, MIN_SECRET_LENGTH, PENDING_KEY, checkSecret, describeError, newClient, store } from "../lib/common.mts";
import { loadState } from "../lib/history.mts";
import { notionConfigured } from "../lib/notion.mts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Backend of the login page (public/index.html). Every action needs the connector secret.
 * The Picnic password is only passed on to Picnic and never stored; only the resulting auth key is.
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Ongeldige invoer" }, 400);
  }
  if (!Netlify.env.get("CONNECTOR_SECRET") || Netlify.env.get("CONNECTOR_SECRET")!.length < MIN_SECRET_LENGTH) {
    return json({ error: `CONNECTOR_SECRET ontbreekt in Netlify of is korter dan ${MIN_SECRET_LENGTH} tekens.` }, 500);
  }
  if (!checkSecret(body.secret)) {
    console.warn("login: wrong secret from", context.ip);
    return json({ error: "Onjuiste connector-sleutel" }, 401);
  }

  const s = store();
  try {
    switch (body.action) {
      // Can Netlify reach Picnic at all? Without a login Picnic's API answers with a JSON error
      // (e.g. 401 or 422) — that means it is reachable. A blocking layer answers with an HTML page.
      case "check": {
        try {
          await newClient().sendRequest("GET", "/user");
          return json({ reachable: true, detail: "Picnic is bereikbaar vanaf Netlify." });
        } catch (err: any) {
          const html = typeof err?.body === "string" && err.body.trimStart().startsWith("<");
          const reachable = typeof err?.status === "number" && !html;
          return json({
            reachable,
            detail: reachable
              ? `Picnic is bereikbaar vanaf Netlify ✓ (de API antwoordde met status ${err.status}, zoals verwacht zonder login).`
              : `Picnic gaf status ${err?.status ?? "?"}${html ? " met een HTML-blokkadepagina" : ""}: ${describeError(err)}`,
          });
        }
      }

      case "login": {
        if (!body.email || !body.password) return json({ error: "E-mail en wachtwoord zijn nodig" }, 400);
        const client = newClient();
        const result = await client.auth.login(body.email, body.password);
        if (result.secondFactorAuthenticationRequired) {
          await s.set(PENDING_KEY, result.authKey);
          await client.auth.generate2FACode("SMS");
          return json({ needs2fa: true, message: "Picnic heeft een sms-code gestuurd." });
        }
        await s.set(AUTH_KEY, result.authKey);
        await s.delete(PENDING_KEY);
        return json({ loggedIn: true });
      }

      case "verify": {
        const pending = await s.get(PENDING_KEY, { type: "text" });
        if (!pending) return json({ error: "Start eerst opnieuw met inloggen" }, 400);
        if (!body.code) return json({ error: "Vul de sms-code in" }, 400);
        const result = await newClient(pending).auth.verify2FACode(body.code.trim());
        await s.set(AUTH_KEY, result.authKey);
        await s.delete(PENDING_KEY);
        return json({ loggedIn: true });
      }

      case "status": {
        const key = await s.get(AUTH_KEY, { type: "text" });
        if (!key) return json({ loggedIn: false });
        const user = await newClient(key).user.getUser();
        return json({ loggedIn: true, name: (user as any).firstname ?? null });
      }

      case "logout": {
        const key = await s.get(AUTH_KEY, { type: "text" });
        if (key) await newClient(key).auth.logout().catch(() => undefined);
        await s.delete(AUTH_KEY);
        await s.delete(PENDING_KEY);
        return json({ loggedIn: false });
      }

      // Progress of the order-history copy to Notion.
      case "history": {
        const h = await loadState();
        if (!notionConfigured()) return json({ history: "Nog niet ingesteld: NOTION_TOKEN ontbreekt in Netlify." });
        const total = h.totalCompleted ?? 0;
        return json({
          history:
            `${h.note ?? "Nog niet gestart (start binnen een minuut)."} ` +
            `${h.done.length} van ${total || "?"} bezorgingen gekopieerd, ${h.linesWritten ?? 0} bestelregels.` +
            (h.failed && Object.keys(h.failed).length ? ` ${Object.keys(h.failed).length} overgeslagen door fouten.` : ""),
        });
      }

      default:
        return json({ error: "Onbekende actie" }, 400);
    }
  } catch (err) {
    console.error("login action failed:", body.action, err);
    return json({ error: describeError(err) }, 502);
  }
};

export const config: Config = {
  path: "/api/login",
  rateLimit: { windowSize: 60, windowLimit: 10, aggregateBy: ["ip", "domain"] },
};
