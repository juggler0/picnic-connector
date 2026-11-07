/**
 * The connector: the address Claude talks to.
 * 1. Checks the secret key in the URL (and optionally the caller's IP address).
 * 2. Hands the request to the MCP library, which calls the right tool from tools.mts.
 */
import type { Config, Context } from "@netlify/functions";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { checkIp, checkSecret } from "../lib/common.mts";
import { registerTools } from "../lib/tools.mts";
import { registerMenuTools } from "../lib/menu-tools.mts";

const INSTRUCTIONS =
  "Persoonlijke Picnic-connector van de gebruiker, met de gezinsmenu-website (tools menu_*). Je kunt producten zoeken, aanbiedingen en bestelgeschiedenis bekijken en de winkelmand vullen of aanpassen. " +
  "Bestellen en afrekenen kan hier bewust niet: dat doet de gebruiker zelf in de Picnic-app. Een bezorgmoment kiezen mag wel. " +
  "Eerder gekochte producten (boughtBefore=true) zijn een hint, geen vaste voorkeur; vergelijk acties per kilo/liter met het huismerk.";

export default async (req: Request, context: Context) => {
  // Wrong or missing key → pretend nothing is here.
  if (!checkSecret(context.params.secret) || !checkIp(context.ip)) {
    console.warn("mcp: rejected request from", context.ip);
    return new Response("Not found", { status: 404 });
  }
  console.info("mcp: request from", context.ip);
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // A fresh server per request: nothing is kept in memory between calls.
  const server = new McpServer({ name: "picnic-connector", version: "1.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server);
  registerMenuTools(server);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
};

export const config: Config = {
  path: "/mcp/:secret",
  rateLimit: { windowSize: 60, windowLimit: 120, aggregateBy: ["ip", "domain"] },
};
