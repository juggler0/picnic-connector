/**
 * Scheduled every minute by Netlify: copies the Picnic order history into Notion bit by bit
 * (see netlify/lib/history.mts). Does nothing until NOTION_TOKEN is set in Netlify.
 */
import type { Config } from "@netlify/functions";
import { runHistorySync } from "../lib/history.mts";

export default async () => {
  const s = await runHistorySync();
  console.info("history sync:", s.note, `done=${s.done.length}`, `queue=${s.queue.length}`, `lines=${s.linesWritten}`);
};

export const config: Config = { schedule: "* * * * *" };
