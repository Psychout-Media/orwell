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
export function seedOrder(scan: Pick<SeedScan, "from" | "to" | "hint">): number[] {
  if (!Number.isInteger(scan.from) || !Number.isInteger(scan.to) || scan.to < scan.from) throw new Error(`firstSeedWhere: bad seed range ${scan.from}..${scan.to}`);
  const out: number[] = [];
  for (const h of hints(scan)) if (!out.includes(h)) out.push(h);
  for (let s = scan.from; s <= scan.to; s++) if (!out.includes(s)) out.push(s);
  return out;
}

function noSeed(scan: SeedScan, n: number, got: number, tried: number[], why: string[]): Error {
  const outside = hints(scan).filter((h) => h < scan.from || h > scan.to);
  const hint = outside.length ? ` (and the hint ${outside.join(", ")})` : "";
  const need = n === 1 ? "" : ` (${got} of the ${n} needed)`;
  return new Error(`firstSeedWhere: no${n === 1 ? "" : "t enough"} seed${n === 1 ? "" : "s"} in ${scan.from}..${scan.to}${hint} reached ${scan.what ?? "the precondition"}${need} (tried ${tried.length}: ${why.join("; ")})`);
}

function note(scan: SeedScan, found: number[]): void {
  const h = hints(scan);
  const missed = h.filter((x) => !found.includes(x));
  if (h.length > 0 && found.some((x) => !h.includes(x))) console.warn(`firstSeedWhere: the hint seed${missed.length === 1 ? "" : "s"} ${missed.join(", ")} no longer reach${missed.length === 1 ? "es" : ""} ${scan.what ?? "the precondition"}; seed${found.length === 1 ? "" : "s"} ${found.join(", ")} ${found.length === 1 ? "does" : "do"} (update the hint)`);
}

/** The first `n` distinct seeds, in scan order, whose game reaches the precondition (for a test that checks a claim on several different games). */
export async function firstSeedsWhere<T>(n: number, reach: (seed: number, sandbox: string) => Promise<T | undefined> | T | undefined, scan: SeedScan): Promise<Array<Found<T>>> {
  const out: Array<Found<T>> = [], tried: number[] = [], why: string[] = [];
  for (const seed of seedOrder(scan)) {
    if (out.length >= n) break;
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
  if (out.length < n) throw noSeed(scan, n, out.length, tried, why);
  note(scan, out.map((f) => f.seed));
  return out;
}

/** The same scan for a synchronous driver (`playedGame`). */
export function firstSeedsWhereSync<T>(n: number, reach: (seed: number, sandbox: string) => T | undefined, scan: SeedScan): Array<Found<T>> {
  const out: Array<Found<T>> = [], tried: number[] = [], why: string[] = [];
  for (const seed of seedOrder(scan)) {
    if (out.length >= n) break;
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
  if (out.length < n) throw noSeed(scan, n, out.length, tried, why);
  note(scan, out.map((f) => f.seed));
  return out;
}

/** Play seeds in order until one reaches the precondition: `reach` returns the stopped game, or undefined (or throws NotReached) when this seed does not get there. */
export async function firstSeedWhere<T>(reach: (seed: number, sandbox: string) => Promise<T | undefined> | T | undefined, scan: SeedScan): Promise<Found<T>> {
  return (await firstSeedsWhere(1, reach, scan))[0]!;
}

/** The same scan for a synchronous driver (`playedGame`). */
export function firstSeedWhereSync<T>(reach: (seed: number, sandbox: string) => T | undefined, scan: SeedScan): Found<T> {
  return firstSeedsWhereSync(1, reach, scan)[0]!;
}
