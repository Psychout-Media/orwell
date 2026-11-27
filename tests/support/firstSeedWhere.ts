import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { expect } from "vitest";

/**
 * ORW-880: a real-path test picks its seed instead of hard-pinning one.
 *
 * A played-season test needs a game that reaches some state (a jealous night, a week-2 house with a close and a distant friend, a quiet room of two). Pinning the
 * one seed that happened to reach it breaks on every gameplay change (ORW-853 re-pinned three). `firstSeedWhere` scans seeds in a FIXED order (the `hint` first, then
 * `from`..`to` ascending) and returns the first whose played game reaches the precondition. So it stays deterministic (the same code picks the same seed every run),
 * and it fails loudly, naming the range, when no seed in range gets there.
 *
 * The precondition is checked here, apart from the test's assertions: `reach` says only whether the game GOT to the state, and the test then asserts on what
 * happened there. A behaviour change can make the scan pick another seed, never make an assertion pass by having nothing to check.
 *
 * The sandbox name is part of a played game (ORW-852): `sandbox` maps each seed to its fixed name, and `reach` must play under that name.
 */
export interface SeedScan {
  /** First seed of the range (inclusive). */
  from: number;
  /** Last seed of the range (inclusive). */
  to: number;
  /** The fixed sandbox name for a seed (e.g. (s) => `wf-${s}`): never random, time-based or a counter. */
  sandbox: (seed: number) => string;
  /** The last seed(s) known to qualify: tried first, in this order, so the usual run plays only those games. When another seed is picked, a note says so. */
  hint?: number | number[];
  /** What the precondition is, for the failure message. */
  what?: string;
  /**
   * ORW-967: more than the default bound (`SCAN_BOUND`: a few seasons, a few minutes). A scan that needs more says so here, with why; without it a scan stops at the bound and
   * fails naming what it needed and the seeds it tried, never runs a shard into its time limit.
   */
  wide?: { maxSeasons: number; budgetMs?: number; reason: string };
}

/**
 * ORW-967 (Coordinator 2026-11-26: three unbounded scans hung CI shards when a gameplay change moved their hints): the default bound on a scan. At most `maxSeasons` seeds are
 * played (`n + extraSeasons` when n seeds are needed), and no new season starts once `budgetMs` has passed. `ORWELL_SEED_SCAN_UNCAPPED=1` lifts both, for finding new hints
 * locally only (never set in CI).
 */
export const SCAN_BOUND = { maxSeasons: 5, extraSeasons: 4, budgetMs: 600_000 } as const;

const uncapped = (): boolean => process.env.ORWELL_SEED_SCAN_UNCAPPED === "1";

/** The bound a scan runs under: the default, or its `wide` override (which must say why). */
export function scanBound(scan: Pick<SeedScan, "wide" | "what">, n = 1): { maxSeasons: number; budgetMs: number } {
  if (uncapped()) return { maxSeasons: Number.POSITIVE_INFINITY, budgetMs: Number.POSITIVE_INFINITY };
  const base = { maxSeasons: n === 1 ? SCAN_BOUND.maxSeasons : n + SCAN_BOUND.extraSeasons, budgetMs: SCAN_BOUND.budgetMs };
  if (!scan.wide) return base;
  if (!scan.wide.reason?.trim()) throw new Error(`firstSeedWhere: a wider scan for ${scan.what ?? "the precondition"} must give its reason`);
  return { maxSeasons: Math.max(base.maxSeasons, scan.wide.maxSeasons), budgetMs: Math.max(base.budgetMs, scan.wide.budgetMs ?? base.budgetMs) };
}

/** Why a scan stopped before trying every seed in range, or undefined to go on. */
function stopReason(bound: { maxSeasons: number; budgetMs: number }, tried: number, startedAt: number): string | undefined {
  if (tried >= bound.maxSeasons) return `stopped at the bound: ${bound.maxSeasons} seasons tried (ORW-967; a scan that needs more passes \`wide\` with a reason, or re-hint it: ORWELL_SEED_SCAN_UNCAPPED=1 finds the seed locally)`;
  if (Date.now() - startedAt > bound.budgetMs) return `stopped at the bound: ${Math.round(bound.budgetMs / 1000)} s of scanning (ORW-967; a scan that needs more passes \`wide\` with a reason, or re-hint it: ORWELL_SEED_SCAN_UNCAPPED=1 finds the seed locally)`;
  return undefined;
}

export interface Found<T> {
  seed: number;
  sandbox: string;
  /** What `reach` returned for that seed (the played game stopped at the precondition). */
  at: T;
}

/**
 * A played-season driver throws this when its season never reaches the stop (the season ended, or the cap ran out). `firstSeedWhere` treats it as "this seed does
 * not qualify" and moves on; every other error is a real failure and is thrown.
 */
export class NotReached extends Error {
  readonly notReached = true;
}

const hints = (scan: Pick<SeedScan, "hint">): number[] => (scan.hint === undefined ? [] : Array.isArray(scan.hint) ? scan.hint : [scan.hint]);

const isNotReached = (e: unknown): boolean => e instanceof NotReached || (typeof e === "object" && e !== null && (e as { notReached?: unknown }).notReached === true);

/** The order seeds are tried in: the hint (if any), then from..to ascending, each once. */
/**
 * ORW-1013 - THE NIGHTLY SEED CATALOG (Ryne: "speed it up without lowering standards"). A nightly job on main records, for every scan, the first few seeds that reach its precondition
 * (`ORWELL_SEED_CATALOG_RECORD=<dir>`; .github/workflows/seed-catalog-nightly.yml: the normal scan, which goes on for up to RECORD_SEEDS qualifiers inside its normal bound) and publishes them; CI hands the latest catalog to the tests (`ORWELL_SEED_CATALOG=<file>`). A scan then tries
 * the catalog's seeds first, then its own hints, then the range: main's CURRENT qualifiers, so a fix that shifts seasons usually still finds one at once instead of costing a re-hint round.
 * Same preconditions, same assertions, same bound (ORW-967); only catalog seeds inside the scan's own range are used. No catalog, or no entry: the order is exactly as before.
 * The key is the test (file and name), the precondition's words and the scan's sandbox naming (the sandbox name is part of the game's identity; two tests can share the words).
 */
export const RECORD_SEEDS = 3;
/** The test running the scan (file and full name): two tests in one file can share a precondition's words but want different moments, so each keeps its own entry. */
function currentTest(): string {
  try { const st = expect.getState(); return `${st.testPath ? relative(process.cwd(), st.testPath) : ""}>${st.currentTestName ?? ""}`; } catch { return ""; }
}
export const catalogKey = (scan: Pick<SeedScan, "what" | "sandbox">, test: string = currentTest()): string => `${test}::${scan.what ?? ""}::${scan.sandbox(0)}`;
let catalogCache: { path: string; table: Record<string, number[]> } | undefined;
function catalogTable(): Record<string, number[]> {
  const path = process.env.ORWELL_SEED_CATALOG;
  if (!path) return {};
  if (catalogCache?.path === path) return catalogCache.table;
  let table: Record<string, number[]> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { scans?: Record<string, number[]> };
    table = raw.scans && typeof raw.scans === "object" ? raw.scans : {};
  } catch { table = {}; } // an unreadable catalog is no catalog: the old order
  catalogCache = { path, table };
  return table;
}
/** The catalog's seeds for this scan, inside its own range (none without a catalog, an entry, or a precondition name). */
export function catalogSeeds(scan: Pick<SeedScan, "from" | "to" | "what" | "sandbox">): number[] {
  if (!scan.what || typeof scan.sandbox !== "function") return [];
  const seeds = catalogTable()[catalogKey(scan)] ?? [];
  return seeds.filter((s) => Number.isInteger(s) && s >= scan.from && s <= scan.to);
}
const recordDir = (): string | undefined => process.env.ORWELL_SEED_CATALOG_RECORD || undefined;
/** Nightly: append what this scan found (`<dir>/catalog-<pid>.jsonl`, one line per scan); the job merges the lines into the catalog. */
function recordFound(scan: SeedScan, seeds: number[]): void {
  const dir = recordDir();
  if (!dir || !scan.what) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `catalog-${process.pid}.jsonl`), JSON.stringify({ key: catalogKey(scan), seeds: seeds.slice(0, RECORD_SEEDS) }) + "\n");
}

export function seedOrder(scan: Pick<SeedScan, "from" | "to" | "hint"> & Partial<Pick<SeedScan, "what" | "sandbox">>): number[] {
  if (!Number.isInteger(scan.from) || !Number.isInteger(scan.to) || scan.to < scan.from) throw new Error(`firstSeedWhere: bad seed range ${scan.from}..${scan.to}`);
  const out: number[] = [];
  for (const c of scan.sandbox ? catalogSeeds(scan as SeedScan) : []) if (!out.includes(c)) out.push(c);
  for (const h of hints(scan)) if (!out.includes(h)) out.push(h);
  for (let s = scan.from; s <= scan.to; s++) if (!out.includes(s)) out.push(s);
  return out;
}

function noSeed(scan: SeedScan, n: number, got: number, tried: number[], why: string[], stopped?: string): Error {
  const outside = hints(scan).filter((h) => h < scan.from || h > scan.to);
  const hint = outside.length ? ` (and the hint ${outside.join(", ")})` : "";
  const need = n === 1 ? "" : ` (${got} of the ${n} needed)`;
  return new Error(`firstSeedWhere: no${n === 1 ? "" : "t enough"} seed${n === 1 ? "" : "s"} in ${scan.from}..${scan.to}${hint} reached ${scan.what ?? "the precondition"}${need} (tried ${tried.length}: ${why.join("; ")})${stopped ? `; ${stopped}` : ""}`);
}

function note(scan: SeedScan, found: number[]): void {
  const h = hints(scan);
  const missed = h.filter((x) => !found.includes(x));
  const cat = catalogSeeds(scan); // ORW-1013: a seed main's catalog names is expected, not a stale hint
  if (h.length > 0 && found.some((x) => !h.includes(x) && !cat.includes(x))) console.warn(`firstSeedWhere: the hint seed${missed.length === 1 ? "" : "s"} ${missed.join(", ")} no longer reach${missed.length === 1 ? "es" : ""} ${scan.what ?? "the precondition"}; seed${found.length === 1 ? "" : "s"} ${found.join(", ")} ${found.length === 1 ? "does" : "do"} (update the hint)`);
}

/** The first `n` distinct seeds, in scan order, whose game reaches the precondition (for a test that checks a claim on several different games). */
export async function firstSeedsWhere<T>(n: number, reach: (seed: number, sandbox: string) => Promise<T | undefined> | T | undefined, scan: SeedScan): Promise<Array<Found<T>>> {
  const out: Array<Found<T>> = [], tried: number[] = [], why: string[] = [];
  const recording = recordDir() !== undefined && !!scan.what;
  const want = recording ? Math.max(n, RECORD_SEEDS) : n; // ORW-1013: the nightly records a few qualifiers per scan
  const bound = scanBound(scan, n), startedAt = Date.now(); // ORW-1013: recording keeps the normal order and bound (lean): only the extra qualifiers inside it are recorded
  let stopped: string | undefined;
  for (const seed of seedOrder(scan)) {
    if (out.length >= want) break;
    if ((stopped = stopReason(bound, tried.length, startedAt))) break;
    const sandbox = scan.sandbox(seed);
    tried.push(seed);
    try {
      const at = await reach(seed, sandbox);
      if (at !== undefined) out.push({ seed, sandbox, at });
      else why.push(`${seed}: reached, precondition false`);
    } catch (e) {
      if (!isNotReached(e)) throw e;
      why.push(`${seed}: ${(e as Error).message}`);
    }
  }
  if (recording) recordFound(scan, out.map((f) => f.seed));
  if (out.length < n) throw noSeed(scan, n, out.length, tried, why, stopped);
  note(scan, out.map((f) => f.seed).slice(0, n));
  return out.slice(0, n);
}

/** The same scan for a synchronous driver (`playedGame`). */
export function firstSeedsWhereSync<T>(n: number, reach: (seed: number, sandbox: string) => T | undefined, scan: SeedScan): Array<Found<T>> {
  const out: Array<Found<T>> = [], tried: number[] = [], why: string[] = [];
  const recording = recordDir() !== undefined && !!scan.what;
  const want = recording ? Math.max(n, RECORD_SEEDS) : n; // ORW-1013: the nightly records a few qualifiers per scan
  const bound = scanBound(scan, n), startedAt = Date.now(); // ORW-1013: recording keeps the normal order and bound (lean): only the extra qualifiers inside it are recorded
  let stopped: string | undefined;
  for (const seed of seedOrder(scan)) {
    if (out.length >= want) break;
    if ((stopped = stopReason(bound, tried.length, startedAt))) break;
    const sandbox = scan.sandbox(seed);
    tried.push(seed);
    try {
      const at = reach(seed, sandbox);
      if (at !== undefined) out.push({ seed, sandbox, at });
      else why.push(`${seed}: reached, precondition false`);
    } catch (e) {
      if (!isNotReached(e)) throw e;
      why.push(`${seed}: ${(e as Error).message}`);
    }
  }
  if (recording) recordFound(scan, out.map((f) => f.seed));
  if (out.length < n) throw noSeed(scan, n, out.length, tried, why, stopped);
  note(scan, out.map((f) => f.seed).slice(0, n));
  return out.slice(0, n);
}

/** Play seeds in order until one reaches the precondition: `reach` returns the stopped game, or undefined (or throws NotReached) when this seed does not get there. */
export async function firstSeedWhere<T>(reach: (seed: number, sandbox: string) => Promise<T | undefined> | T | undefined, scan: SeedScan): Promise<Found<T>> {
  return (await firstSeedsWhere(1, reach, scan))[0]!;
}

/** The same scan for a synchronous driver (`playedGame`). */
export function firstSeedWhereSync<T>(reach: (seed: number, sandbox: string) => T | undefined, scan: SeedScan): Found<T> {
  return firstSeedsWhereSync(1, reach, scan)[0]!;
}
