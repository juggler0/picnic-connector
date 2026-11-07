/**
 * Scheduled every 2 minutes by Netlify: keeps the weekly price list of all products ever ordered up to date
 * in Notion (see netlify/lib/prices.mts). Stops right away when this week's prices are done.
 */
import type { Config } from "@netlify/functions";
import { runPriceSync } from "../lib/prices.mts";

export default async () => {
  await runPriceSync();
};

export const config: Config = { schedule: "1-59/2 * * * *" }; // odd minutes, so it doesn't run together with history-sync
