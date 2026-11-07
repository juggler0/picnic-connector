/**
 * MCP tools for the family menu website, so Claude's scheduled tasks can publish the menu, plan the standard
 * groceries and read the family's reactions. The data lives in the Notion databases on the page "Weekmenu"
 * (see menu.mts); these tools do not need the Picnic login.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as M from "./menu.mts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }] });
const fail = (message: string): Result => ({ content: [{ type: "text", text: message }], isError: true });

async function run(tool: string, args: unknown, fn: () => Promise<unknown>): Promise<Result> {
  console.info("tool call:", tool, JSON.stringify(args).slice(0, 300));
  try {
    return ok(await fn());
  } catch (err) {
    console.error("tool failed:", tool, err);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const weekId = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Week-id = de vrijdag waarmee de week begint, JJJJ-MM-DD");
const consumer = z
  .enum(["menu", "ratings"])
  .default("ratings")
  .describe("'menu' = het uurlijkse verwerken van reacties in het voorstel; 'ratings' = cijfers verwerken in het gerechtenoverzicht. Elk heeft een eigen markering.");
// Tool calls must finish well within Netlify's function time limit; longer work is reported as not done.
const deadline = () => Date.now() + 7000;

export function registerMenuTools(server: McpServer) {
  server.tool(
    "menu_list_weeks",
    "Lijst van de weken in de Notion-database Weekmenu (id = vrijdag, titel, status, aantal dagen). Alleen lezen.",
    { from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Vanaf deze datum (standaard 10 weken terug)") },
    async ({ from }) => run("menu_list_weeks", { from }, async () => {
      const weeks = await M.loadWeeks({ from: from ?? M.addDays(M.today(), -70) });
      return { today: M.today(), weeks: weeks.map((w) => ({ id: w.week.id, title: w.week.title, status: w.week.status, days: w.week.days.length, updatedAt: w.week.updatedAt })) };
    }),
  );

  server.tool(
    "menu_get_week",
    "Eén week met alle dagen, per persoon de cijfers en reacties per dag (sleutel 'week' = reactie op het hele menu), gastcijfers en de standaard boodschappen (status gepland/voorstel/goedgekeurd/afgewezen). editedBy='owner' = de eigenaar (Johan) heeft die dag zelf aangepast: dat is leidend. Bestellen: boodschappen met status gepland of goedgekeurd; voorstel = nog niet goedgekeurd, afgewezen = niet bestellen. Alleen lezen.",
    { week_id: weekId },
    async ({ week_id }) => run("menu_get_week", { week_id }, async () => ({ owner: M.owner(), today: M.today(), ...(await M.getWeek(week_id)) })),
  );

  server.tool(
    "menu_put_week",
    "Zet een week (voorstel of bijgewerkt menu) in de Notion-database en dus op de gezinsmenu-website. Dagen die de eigenaar zelf heeft aangepast worden NIET overschreven (alleen hun Picnic-producten, status en Claude-notitie mogen worden bijgewerkt); het antwoord noemt die dagen in keptOwnerDays. notSaved = dagen die nog niet zijn opgeslagen (roep dan opnieuw aan met alleen die dagen).",
    {
      week_id: weekId,
      title: z.string().max(120).optional().describe("Bijv. 'Week 47-48 (vr 20 – do 26 nov)'"),
      status: z.enum(["voorstel", "in winkelmand", "gegeten"]).optional(),
      delivery: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Bezorgdatum (donderdag)"),
      note: z.string().max(2000).optional().describe("Claude-notitie bij de hele week"),
      days: z
        .array(
          z.object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            dish: z.string().max(200).default(""),
            ingredients: z.string().max(2000).default("").describe("Algemene ingrediënten (kolom Boodschappen)"),
            picnic: z.string().max(4000).default("").describe("Exacte Picnic-producten"),
            notes: z.string().max(500).default("").describe("Bijzonderheden"),
            recipeUrl: z.string().max(500).default(""),
            away: z.boolean().default(false).describe("true = niet thuis eten"),
            claudeNote: z.string().max(1000).optional().describe("Korte uitleg voor het gezin als je iets hebt aangepast na een reactie, bijv. 'Zalm in plaats van kabeljauw (reactie Laura)'. Leeg = notitie weghalen."),
            ratings: z
              .record(z.object({ rating: z.coerce.number().int().min(1).max(10).nullable().default(null), comment: z.string().max(1000).default("") }))
              .optional()
              .describe("Alleen bij het overzetten van oude weken: bestaande cijfers per persoon. Vult alleen lege cellen."),
          }),
        )
        .min(1)
        .max(7),
    },
    async (args) => run("menu_put_week", { week_id: args.week_id, days: args.days.length }, () =>
      M.putWeekFromClaude({ id: args.week_id, title: args.title, status: args.status, delivery: args.delivery, note: args.note, days: args.days, deadline: deadline() }),
    ),
  );

  server.tool(
    "menu_put_groceries",
    "Zet de geplande standaard boodschappen van een week (onder het menu op de website, status 'gepland'). Bestaande regels met dezelfde productnaam worden bijgewerkt; een product dat de eigenaar heeft afgewezen blijft afgewezen. Met replace=true verdwijnen jouw eerder geplande producten die niet meer in de lijst staan. Suggesties van het gezin worden nooit aangeraakt. notDone > 0: roep opnieuw aan.",
    {
      week_id: weekId,
      items: z
        .array(z.object({ product: z.string().min(1).max(120).describe("Korte naam, bijv. 'Halfvolle melk'"), amount: z.coerce.number().int().min(1).max(50).nullable().default(null), picnic: z.string().max(500).default("").describe("Exact Picnic-product") }))
        .max(80),
      replace: z.boolean().default(true),
    },
    async ({ week_id, items, replace }) => run("menu_put_groceries", { week_id, items: items.length }, () => M.putGroceriesFromClaude(week_id, items, replace, deadline())),
  );

  server.tool(
    "menu_get_updates",
    "Alles wat het gezin (en gasten, person 'Gast') op de website heeft ingevuld of gewijzigd na de laatst verwerkte keer voor deze verwerker: cijfers, reacties per dag of op het hele menu (day 'hele menu'), suggesties voor boodschappen en aanpassingen door de eigenaar (kind 'owner-edit'). Leeg = niets nieuws. Sluit af met menu_mark_updates_processed met 'now'. Alleen lezen.",
    { consumer, since: z.string().optional().describe("ISO-tijdstip; standaard het moment van de vorige verwerking") },
    async ({ consumer, since }) => run("menu_get_updates", { consumer, since }, () => M.getUpdates(consumer, since)),
  );

  server.tool(
    "menu_mark_updates_processed",
    "Legt vast tot welk moment de updates voor deze verwerker zijn verwerkt (gebruik 'now' uit menu_get_updates).",
    { consumer, until: z.string().min(10).describe("ISO-tijdstip") },
    async ({ consumer, until }) => run("menu_mark_updates_processed", { consumer, until }, () => M.markProcessed(consumer, until)),
  );
}
