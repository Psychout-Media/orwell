#!/usr/bin/env node
// ORW-218: regenerate ci/test-durations.json from the logs of a green CI run of the sharded `test-unit` legs.
//   (pass the legs of SEVERAL green runs to get per-file medians.)
//   for each test-unit leg job id:  gh api repos/<owner>/<repo>/actions/jobs/<id>/logs > leg-<n>.log
//   node ci/refresh-test-durations.mjs leg-1.log leg-2.log leg-3.log leg-4.log
// Reads vitest's default reporter lines for PASSED files only (failed or interrupted files carry a misleading time and are skipped) ("✓ tests/unit/foo.test.ts (12 tests) 1234ms") and merges them over the existing table (files not seen keep their old value).
// The table is only a balancing hint: a stale entry can make a leg slower, never skip or duplicate a test (see vitest.sequencer.ts).
// ORW-367: also accepts a vitest JSON report (`--json report.json`; `--reporter=json --outputFile=report.json` gives a per-file wall time) and `--replace`, which rebuilds the table from the inputs alone
// (files not seen are dropped, so renamed/deleted tests do not linger). A file seen in several inputs is recorded at its MEDIAN. Best source: the test-unit leg logs of 2-3 green CI runs (the coverage-shard legs print no
// per-file lines: blob reporter). Local alternative: `npm run ci:refresh-durations` (a 4-worker run like a CI runner, then --json --replace; keep the box lightly loaded or the times inflate).
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

// ORWELL_DURATIONS_TABLE points the script at another table file (the unit test runs it on a temp copy, never the tracked table).
const table = process.env.ORWELL_DURATIONS_TABLE ? resolve(process.env.ORWELL_DURATIONS_TABLE) : resolve(import.meta.dirname, "test-durations.json");
const args = process.argv.slice(2);
const replace = args.includes("--replace");
const durations = replace ? {} : JSON.parse(readFileSync(table, "utf8"));
// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;]*m/g;
let seen = 0;
// Every input is a sample; a file seen in several inputs (several CI runs, or log + report) is recorded at the MEDIAN, so one contended run cannot skew the split.
const samples = new Map();
const sample = (file, ms) => {
  samples.set(file, [...(samples.get(file) ?? []), ms]);
  seen++;
};
const root = resolve(import.meta.dirname, "..");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--replace") continue;
  if (args[i] === "--json") {
    const report = JSON.parse(readFileSync(args[++i], "utf8"));
    // --replace rebuilds the table from this report alone, so a partial one (a failed or interrupted run) would silently drop every file it lacks: refuse it.
    if (replace && (report.success === false || !Array.isArray(report.testResults) || report.testResults.length === 0 || report.testResults.some((r) => r.status !== "passed"))) {
      console.error(`refusing --replace: ${args[i]} is not a fully green run with results (the table is left untouched)`);
      process.exit(1);
    }
    for (const r of report.testResults) {
      if (r.status !== "passed") continue; // a failed/interrupted file carries a misleading time
      sample(relative(root, r.name).split("\\").join("/"), Math.max(0, Math.round(r.endTime - r.startTime)));
    }
    continue;
  }
  const log = args[i];
  for (const raw of readFileSync(log, "utf8").split("\n")) {
    // vitest 2.1.9 (pinned) prints whole milliseconds even for long files ("836526ms"); a seconds suffix ("1.23s") is accepted too, so a reporter
    // change on a vitest upgrade cannot silently leave the slow files' weights stale.
    const m = raw.replace(ansi, "").match(/✓ (tests\/\S+\.test\.ts)(?: \(\d+ tests?(?: \| \d+ \w+)*\))?(?: (\d+(?:\.\d+)?)(ms|s))?\s*$/);
    if (m) {
      sample(m[1], m[2] === undefined ? 0 : Math.round(Number(m[2]) * (m[3] === "s" ? 1000 : 1)));
    }
  }
}
for (const [file, ms] of samples) {
  const s = [...ms].sort((a, b) => a - b);
  durations[file] = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}
const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(table, JSON.stringify(sorted, null, 1) + "\n");
console.log(`updated ${seen} entries; ${Object.keys(sorted).length} in the table`);
