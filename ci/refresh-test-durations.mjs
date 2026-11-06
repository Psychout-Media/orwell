#!/usr/bin/env node
// ORW-218: regenerate ci/test-durations.json from the logs of a green CI run of the sharded `test-unit` legs.
//   for each test-unit leg job id:  gh api repos/<owner>/<repo>/actions/jobs/<id>/logs > leg-<n>.log
//   node ci/refresh-test-durations.mjs leg-1.log leg-2.log leg-3.log leg-4.log
// Reads vitest's default reporter lines for PASSED files only (failed or interrupted files carry a misleading time and are skipped) ("✓ tests/unit/foo.test.ts (12 tests) 1234ms") and merges them over the existing table (files not seen keep their old value).
// The table is only a balancing hint: a stale entry can make a leg slower, never skip or duplicate a test (see vitest.sequencer.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const table = resolve(import.meta.dirname, "test-durations.json");
const durations = JSON.parse(readFileSync(table, "utf8"));
// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;]*m/g;
let seen = 0;
for (const log of process.argv.slice(2)) {
  for (const raw of readFileSync(log, "utf8").split("\n")) {
    const m = raw.replace(ansi, "").match(/✓ (tests\/\S+\.test\.ts)(?: \(\d+ tests?(?: \| \d+ \w+)*\))?(?: (\d+)ms)?\s*$/);
    if (m) {
      durations[m[1]] = Number(m[2] ?? 0);
      seen++;
    }
  }
}
const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(table, JSON.stringify(sorted, null, 1) + "\n");
console.log(`updated ${seen} entries; ${Object.keys(sorted).length} in the table`);
