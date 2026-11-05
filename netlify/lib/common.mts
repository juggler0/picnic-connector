import { timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import PicnicClient from "picnic-api";

/** Site-wide store for the Picnic login. Strong consistency so a fresh login is seen at once. */
export const store = () => getStore({ name: "picnic", consistency: "strong" });

export const AUTH_KEY = "authKey"; // the Picnic auth key after a completed login
export const PENDING_KEY = "pendingAuthKey"; // the auth key between login and 2FA verification

/** Minimum length of CONNECTOR_SECRET; shorter secrets are refused so a weak key can't be used by accident. */
export const MIN_SECRET_LENGTH = 32;

/** Constant-time comparison of a supplied secret with the CONNECTOR_SECRET env var. */
export function checkSecret(supplied: string | null | undefined): boolean {
  const expected = Netlify.env.get("CONNECTOR_SECRET");
  if (!expected || expected.length < MIN_SECRET_LENGTH) {
    console.error(`CONNECTOR_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters — all requests are refused.`);
    return false;
  }
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Optional second gate: when ALLOWED_IP_PREFIXES is set (comma-separated, e.g. "160.79.,153.61."),
 * only requests from those address prefixes are served. Empty = no IP restriction.
 */
export function checkIp(ip: string | undefined): boolean {
  const raw = Netlify.env.get("ALLOWED_IP_PREFIXES")?.trim();
  if (!raw) return true;
  if (!ip) return false;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).some((p) => ip.startsWith(p));
}

/** Picnic country: NL (default), DE or FR, via the optional PICNIC_COUNTRY env var. */
const country = () => (Netlify.env.get("PICNIC_COUNTRY")?.toUpperCase() ?? "NL") as "NL" | "DE" | "FR";

export function newClient(authKey?: string | null) {
  return new PicnicClient({ countryCode: country(), authKey: authKey ?? undefined });
}

/** A client with the stored login, or null when nobody has logged in yet. */
export async function loggedInClient() {
  const key = await store().get(AUTH_KEY, { type: "text" });
  return key ? newClient(key) : null;
}

/** Human-readable explanation of an error coming back from Picnic. */
export function describeError(err: unknown): string {
  if (PicnicClient.isPicnicApiError(err)) {
    const html = err.body?.trimStart().startsWith("<");
    if (err.status === 401) return "Picnic login is verlopen of ongeldig — log opnieuw in via de inlogpagina.";
    if (err.status === 403 && html)
      return "Picnic weigert het verzoek (403 van de beveiligingslaag) — mogelijk worden verzoeken vanaf Netlify geblokkeerd of afgeremd.";
    return `Picnic gaf fout ${err.status}${err.code ? ` (${err.code})` : ""}.`;
  }
  return err instanceof Error ? err.message : String(err);
}

export const euro = (cents: number | null | undefined) =>
  cents == null ? null : `€${(cents / 100).toFixed(2).replace(".", ",")}`;
