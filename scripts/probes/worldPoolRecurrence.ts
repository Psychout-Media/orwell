/**
 * ORW-509 measurement: how often the non-character world lists repeat, inside one season and across 200 seeded seasons.
 *
 *   NODE_OPTIONS='--import tsx' node scripts/probes/worldPoolRecurrence.ts [--json] [--seasons 200]
 *
 * For each list: `within` = share of draws in a season that repeat an earlier draw of the same season; `across` = distinct values over all seasons;
 * `next` = mean share of a season's distinct values that the NEXT season (the following seed) also has (the "shared with the previous season" rate).
 * It uses only public engine exports and no private data, so the same file runs on any commit (the before/after numbers in the ORW-509 PR come from running it on the
 * base commit and on the branch). Closed mechanic ids (finale appeals, goodbye tones, exit stances, tie natures) report size only.
 */
import { GOODBYE_TONES, EXIT_STANCES } from "../../src/engine/liveSeason";
import { FINALE_APPEALS } from "../../src/engine/jury";

import { buildRows } from "./worldPoolMeasure";
import { GOODBYE_TONES, EXIT_STANCES } from "../../src/engine/liveSeason";
import { FINALE_APPEALS } from "../../src/engine/jury";

const args = process.argv.slice(2);
const SEASONS = Number(args[args.indexOf("--seasons") + 1]) || 200;
const rows = buildRows(SEASONS);

console.log(JSON.stringify({ seasons: SEASONS, closedByDesign: { finaleAppeals: FINALE_APPEALS.length, goodbyeTones: GOODBYE_TONES.length, exitStances: EXIT_STANCES.length }, rows }, null, args.includes("--json") ? 2 : 0));
if (!args.includes("--json")) {
  console.log("\nlist | draws/season | within-season repeat | distinct across seasons | next-season share");
  for (const r of rows) console.log(`${r.list} | ${r.drawsPerSeason} | ${(r.within * 100).toFixed(1)}% | ${r.across} | ${(r.next * 100).toFixed(1)}%`);
}
