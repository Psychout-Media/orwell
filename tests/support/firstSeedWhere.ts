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
  /** The last seed known to qualify: tried first, so the usual run plays one game. When another seed is picked, a note says so. */
  hint?: number;
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

const isNotReached = (e: unknown): boolean => e instanceof NotReached || (typeof e === "object" && e !== null && (e as { notReached?: unknown }).notReached === true);

/** The order seeds are tried in: the hint (if any), then from..to ascending, each once. */
export function seedOrder(scan: Pick<SeedScan, "from" | "to" | "hint">): number[] {
  if (!Number.isInteger(scan.from) || !Number.isInteger(scan.to) || scan.to < scan.from) throw new Error(`firstSeedWhere: bad seed range ${scan.from}..${scan.to}`);
  const out: number[] = [];
  if (scan.hint !== undefined) out.push(scan.hint);
  for (let s = scan.from; s <= scan.to; s++) if (s !== scan.hint) out.push(s);
  return out;
}

function noSeed(scan: SeedScan, tried: number[], why: string[]): Error {
  const hint = scan.hint !== undefined && (scan.hint < scan.from || scan.hint > scan.to) ? ` (and the hint ${scan.hint})` : "";
  return new Error(`firstSeedWhere: no seed in ${scan.from}..${scan.to}${hint} reached ${scan.what ?? "the precondition"} (tried ${tried.length}: ${why.join("; ")})`);
}

function note(scan: SeedScan, seed: number): void {
  if (scan.hint !== undefined && seed !== scan.hint) console.warn(`firstSeedWhere: the hint seed ${scan.hint} no longer reaches ${scan.what ?? "the precondition"}; seed ${seed} does (update the hint)`);
}

/** Play seeds in order until one reaches the precondition: `reach` returns the stopped game, or undefined (or throws NotReached) when this seed does not get there. */
export async function firstSeedWhere<T>(reach: (seed: number, sandbox: string) => Promise<T | undefined> | T | undefined, scan: SeedScan): Promise<Found<T>> {
  const tried: number[] = [], why: string[] = [];
  for (const seed of seedOrder(scan)) {
    const sandbox = scan.sandbox(seed);
    tried.push(seed);
    try {
      const at = await reach(seed, sandbox);
      if (at !== undefined) { note(scan, seed); return { seed, sandbox, at }; }
      why.push(`${seed}: reached, precondition false`);
    } catch (e) {
      if (!isNotReached(e)) throw e;
      why.push(`${seed}: ${(e as Error).message}`);
    }
  }
  throw noSeed(scan, tried, why);
}

/** The same scan for a synchronous driver (`playedGame`). */
export function firstSeedWhereSync<T>(reach: (seed: number, sandbox: string) => T | undefined, scan: SeedScan): Found<T> {
  const tried: number[] = [], why: string[] = [];
  for (const seed of seedOrder(scan)) {
    const sandbox = scan.sandbox(seed);
    tried.push(seed);
    try {
      const at = reach(seed, sandbox);
      if (at !== undefined) { note(scan, seed); return { seed, sandbox, at }; }
      why.push(`${seed}: reached, precondition false`);
    } catch (e) {
      if (!isNotReached(e)) throw e;
      why.push(`${seed}: ${(e as Error).message}`);
    }
  }
  throw noSeed(scan, tried, why);
}
