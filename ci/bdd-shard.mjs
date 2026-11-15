#!/usr/bin/env node
// ORW-413: run one slice of the BDD gate. `node ci/bdd-shard.mjs <i>/<n>` runs the feature files of leg i of n; no argument runs all of them (what `npm run test:bdd` does).
// The feature list is the `paths` of cucumber.cjs (the executable features), split by MEASURED seconds (ci/bdd-durations.json: feature path -> seconds) with the same
// deterministic greedy "heaviest file onto the lightest leg" rule as the unit shards (vitest.sequencer.ts). Every feature runs in exactly one leg (tests/unit/ciBddShard.test.ts
// proves it on the real list), a feature missing from the table weighs the median, and the table is only a balancing hint: a stale entry changes the time of a leg, never what runs.
// Refresh the table from a green run: every leg prints one "[bdd-shard] <feature> <seconds>" line per feature.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
export const MIN_WEIGHT_S = 1;

export function featurePaths() {
  const require = createRequire(import.meta.url);
  return require(resolve(root, "cucumber.cjs")).default.paths;
}

export function loadDurations() {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "bdd-durations.json"), "utf8"));
}

export function assignBddShards(files, durations, count) {
  const known = Object.values(durations).sort((a, b) => a - b);
  const unknown = Math.max(MIN_WEIGHT_S, known[Math.floor(known.length / 2)] ?? MIN_WEIGHT_S);
  const weight = (f) => Math.max(MIN_WEIGHT_S, durations[f] ?? unknown);
  const ordered = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const legs = Array.from({ length: count }, () => ({ load: 0, files: [] }));
  for (const f of ordered) {
    let best = legs[0];
    for (const leg of legs) if (leg.load < best.load) best = leg;
    best.files.push(f);
    best.load += weight(f);
  }
  return legs.map((l) => l.files);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  let files = featurePaths();
  if (arg) {
    const m = /^(\d+)\/(\d+)$/.exec(arg);
    if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error(`usage: bdd-shard.mjs <i>/<n>, got ${arg}`);
    files = assignBddShards(files, loadDurations(), +m[2])[+m[1] - 1];
    console.log(`[bdd-shard] leg ${arg}: ${files.length} of ${featurePaths().length} features`);
  }
  const r = spawnSync("npx", ["cucumber-js", "--format", "progress", "--format", "json:.bdd-report.json"], {
    stdio: "inherit",
    // The slice goes in through ORWELL_BDD_FEATURES (cucumber.cjs): positional paths would be added to the config's list, not replace it.
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import tsx`.trim(), ...(arg ? { ORWELL_BDD_FEATURES: files.join("\n") } : {}) },
  });
  try {
    const rep = JSON.parse(readFileSync(resolve(root, ".bdd-report.json"), "utf8"));
    for (const f of rep) {
      const ns = f.elements.flatMap((e) => e.steps ?? []).reduce((n, s) => n + (s.result?.duration ?? 0), 0);
      console.log(`[bdd-shard] ${f.uri} ${(ns / 1e9).toFixed(1)}`);
    }
  } catch {
    /* the report is a timing aid only */
  }
  process.exit(r.status ?? 1);
}
