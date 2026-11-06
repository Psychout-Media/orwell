import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { BaseSequencer } from "vitest/node";

/**
 * ORW-218 - duration-aware `--shard` split for the sharded unit (`test-unit`) and coverage (`coverage-shard`) legs.
 *
 * Vitest's own split sorts the files by a hash of the path and cuts the list into equal-COUNT slices, so a handful of slow files can land in one leg
 * (leg 4 ran 800 s next to 130 s for the others). This sequencer keeps `--shard=i/n` exactly as it was on the command line but assigns the files by
 * measured duration: a committed table (`ci/test-durations.json`, relative path -> ms) plus a deterministic greedy "heaviest file to the lightest leg" pass.
 *
 * Properties the CI relies on (tests/unit/ciShardAssignment.test.ts proves them on the real file list):
 *  - a partition: every file goes to exactly one leg, none is dropped or duplicated (`assertPartition` below throws otherwise, and a leg fails loudly);
 *  - deterministic: same file list + same table -> same split on every runner;
 *  - a file missing from the table (new test) gets the median known duration, so it still lands somewhere sensible;
 *  - the table is a hint only: a stale or missing entry changes the balance, never what runs.
 * Regenerate the table with `node ci/refresh-test-durations.mjs <ci log files>` (see that script).
 */

export const DURATIONS_RELATIVE_PATH = "ci/test-durations.json";
/** Floor (ms) so a 0-50 ms file still costs its worker start-up + transform. */
export const MIN_WEIGHT_MS = 250;

export function loadDurations(path: string): Record<string, number> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
}

function median(values: number[]): number {
  if (values.length === 0) return MIN_WEIGHT_MS;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Split `files` (root-relative, slash separated) into `count` legs by duration; returns one array per leg, in leg order. */
export function assignShards(files: readonly string[], durations: Record<string, number>, count: number): string[][] {
  const unknownWeight = Math.max(MIN_WEIGHT_MS, median(Object.values(durations)));
  const weight = (f: string): number => Math.max(MIN_WEIGHT_MS, durations[f] ?? unknownWeight);
  // Heaviest first; ties broken by path so the result never depends on the incoming order.
  const ordered = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const legs: { load: number; files: string[] }[] = Array.from({ length: count }, () => ({ load: 0, files: [] }));
  for (const f of ordered) {
    let best = legs[0]!;
    for (const leg of legs) if (leg.load < best.load) best = leg; // first (lowest index) leg wins ties
    best.files.push(f);
    best.load += weight(f);
  }
  return legs.map((l) => l.files);
}

/** Throws unless `legs` is an exact partition of `files` (nothing dropped, nothing run twice). */
export function assertPartition(files: readonly string[], legs: readonly (readonly string[])[]): void {
  const want = new Set(files);
  const seen = new Map<string, number>();
  for (const leg of legs) for (const f of leg) seen.set(f, (seen.get(f) ?? 0) + 1);
  const dropped = [...want].filter((f) => !seen.has(f));
  const duplicated = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
  const invented = [...seen.keys()].filter((f) => !want.has(f));
  if (dropped.length || duplicated.length || invented.length) {
    throw new Error(`shard assignment is not a partition: dropped=${JSON.stringify(dropped)} duplicated=${JSON.stringify(duplicated)} invented=${JSON.stringify(invented)}`);
  }
}

export default class DurationShardSequencer extends BaseSequencer {
  // vitest 2.x hands over `[project, absoluteFile]` pairs.
  async shard(specs: Parameters<BaseSequencer["shard"]>[0]): ReturnType<BaseSequencer["shard"]> {
    const { index, count } = this.ctx.config.shard!;
    const root = this.ctx.config.root;
    const rel = (spec: (typeof specs)[number]): string => relative(root, spec[1]).split(sep).join("/");
    const byRel = new Map(specs.map((s) => [rel(s), s] as const));
    const durations = loadDurations(resolve(root, DURATIONS_RELATIVE_PATH));
    const legs = assignShards([...byRel.keys()], durations, count);
    assertPartition([...byRel.keys()], legs);
    const mine = legs[index - 1] ?? [];
    console.log(`[shard ${index}/${count}] ${mine.length} of ${byRel.size} files, est. ${Math.round(mine.reduce((n, f) => n + Math.max(MIN_WEIGHT_MS, durations[f] ?? 0), 0) / 1000)} s of test time`);
    return mine.map((f) => byRel.get(f)!);
  }
}
