/**
 * Scheduled every 2 minutes by Netlify: copies the Picnic order history into Notion bit by bit
 * (see netlify/lib/history.mts). Does nothing until NOTION_TOKEN is set in Netlify.
 * First run(s) after the menu moved to Notion: copies the old menu data from Blobs into Notion.
 */
import type { Config } from "@netlify/functions";
import { runHistorySync } from "../lib/history.mts";
import { migrationPending, migrateFromBlobs } from "../lib/menu.mts";
import { notionConfigured } from "../lib/notion.mts";

export default async () => {
  // One-time: move the family menu that was kept in Blobs into the Notion databases (takes priority).
  if (notionConfigured() && (await migrationPending())) {
    try {
      const m = await migrateFromBlobs(Date.now() + 22_000);
      console.info("menu migration:", m.finished ? "finished" : "in progress", `weeks=${m.done.length}`);
      return;
    } catch (err) {
      console.error("menu migration failed (history sync continues):", err);
    }
  }
  const s = await runHistorySync();
  console.info("history sync:", s.note, `done=${s.done.length}`, `queue=${s.queue.length}`, `lines=${s.linesWritten}`);
};

// Every 2 minutes: fast enough for the one-time copy, cheap when there is nothing to do.
export const config: Config = { schedule: "*/2 * * * *" };
