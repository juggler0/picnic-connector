/**
 * MCP tools for the family menu website, so Claude's scheduled tasks can publish the menu
 * and read the family's feedback and ratings. These do not need the Picnic login.
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
const PROCESSED_KEY = "meta/ratingsProcessedAt";

export function registerMenuTools(server: McpServer) {
  server.tool(
    "menu_list_weeks",
    "Lijst van de weken op de gezinsmenu-website (id = vrijdag, titel, status). Alleen lezen.",
    {},
    async () => run("menu_list_weeks", {}, async () => {
      const ids = await M.listWeekIds();
      const weeks = await Promise.all(ids.slice(-20).map((id) => M.getWeek(id)));
      return { today: M.today(), weeks: weeks.filter(Boolean).map((w) => ({ id: w!.id, title: w!.title, status: w!.status, updatedAt: w!.updatedAt })) };
    }),
  );

  server.tool(
    "menu_get_week",
    "Eén week van de gezinsmenu-website met alle dagen en per persoon de feedback, cijfers en extra boodschappen (feedback[naam].extras, één product per regel; neem die mee in de winkelmand). editedBy='owner' betekent dat de eigenaar (Johan) die dag zelf heeft aangepast: dat is leidend. Alleen lezen.",
    { week_id: weekId },
    async ({ week_id }) => run("menu_get_week", { week_id }, async () => ({
      owner: M.owner(),
      week: await M.getWeek(week_id),
      feedback: await M.getFeedback(week_id),
    })),
  );

  server.tool(
    "menu_put_week",
    "Zet een week (voorstel of bijgewerkt menu) op de gezinsmenu-website. Dagen die de eigenaar zelf op de website heeft aangepast worden NIET overschreven (alleen hun Picnic-producten mogen worden bijgewerkt); het antwoord noemt die dagen in keptOwnerDays.",
    {
      week_id: weekId,
      title: z.string().max(120).describe("Bijv. 'Week 47-48 (vr 20 – do 26 nov)'"),
      status: z.string().max(40).optional().describe("Bijv. 'voorstel' of 'in winkelmand'"),
      days: z
        .array(
          z.object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            dish: z.string().max(200).default(""),
            ingredients: z.string().max(2000).default("").describe("Algemene ingrediënten (kolom Boodschappen)"),
            picnic: z.string().max(3000).default("").describe("Exacte Picnic-producten"),
            notes: z.string().max(500).default("").describe("Bijzonderheden"),
            recipeUrl: z.string().max(500).default(""),
            away: z.boolean().default(false).describe("true = niet thuis eten"),
          }),
        )
        .min(1)
        .max(7),
    },
    async (args) => run("menu_put_week", { week_id: args.week_id, days: args.days.length }, async () => {
      const { week, keptOwnerDays } = await M.putWeekFromClaude({ id: args.week_id, title: args.title, status: args.status, days: args.days });
      return { saved: week.id, days: week.days.length, keptOwnerDays };
    }),
  );

  server.tool(
    "menu_get_new_ratings",
    "Alle cijfers en opmerkingen van het gezin die zijn ingevuld of gewijzigd na de laatst verwerkte keer (of na 'since'), met week, dag, gerecht en persoon. Gebruik daarna menu_mark_ratings_processed. Alleen lezen.",
    { since: z.string().optional().describe("ISO-tijdstip; standaard het moment van de vorige verwerking") },
    async ({ since }) => run("menu_get_new_ratings", { since }, async () => {
      const from = since ?? ((await M.menuStore().get(PROCESSED_KEY, { type: "text" })) || "1970-01-01T00:00:00Z");
      const out: any[] = [];
      for (const id of await M.listWeekIds()) {
        const week = await M.getWeek(id);
        const fb = await M.getFeedback(id);
        for (const [person, f] of Object.entries(fb)) {
          for (const [date, item] of Object.entries(f.items)) {
            if (item.updatedAt > from) {
              const day = week?.days.find((d) => d.date === date);
              out.push({ week: id, date, day: M.dayName(date), dish: day?.dish ?? "", person, rating: item.rating, comment: item.comment, updatedAt: item.updatedAt });
            }
          }
        }
      }
      return { since: from, now: new Date().toISOString(), items: out.sort((a, b) => a.date.localeCompare(b.date)) };
    }),
  );

  server.tool(
    "menu_mark_ratings_processed",
    "Legt vast tot welk moment de cijfers en opmerkingen in Notion zijn verwerkt (gebruik 'now' uit menu_get_new_ratings).",
    { until: z.string().min(10).describe("ISO-tijdstip") },
    async ({ until }) => run("menu_mark_ratings_processed", { until }, async () => {
      await M.menuStore().set(PROCESSED_KEY, until);
      return { processedUntil: until };
    }),
  );
}
