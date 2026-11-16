/**
 * ORW-508 Layer 1 sampler: draw from a world-sized table at real-world frequency.
 *
 * A table is a cumulative weight array built once. A draw is ONE `rng.next()` plus a binary search, so the
 * stream consumption is fixed per attempt and a caller that deals on its own side stream moves no other
 * value. Constraints (already used, recently used on this install, group caps) are applied by re-drawing,
 * never by filtering the table, so the frequencies stay the world's and a constraint only removes outcomes.
 * Same table, same rng, same constraints: same result.
 */
import type { RandomnessSource } from "../../ports/RandomnessSource";

export interface WeightedTable<T> {
  readonly rows: readonly T[];
  /** cumulative[i] = sum of weights of rows 0..i. */
  readonly cumulative: readonly number[];
  readonly total: number;
}

/**
 * `flatten` is an exponent on the weight: 1 is the world's own frequency, below 1 lifts small rows a little
 * (a person from a town of 3,000 is real, and a table of 8.8 million New Yorkers would otherwise dominate).
 */
export function buildTable<T>(rows: readonly T[], weightOf: (row: T) => number, flatten = 1): WeightedTable<T> {
  const cumulative: number[] = [];
  let total = 0;
  for (const r of rows) {
    const w = Math.max(0, weightOf(r));
    total += flatten === 1 ? w : Math.pow(w, flatten);
    cumulative.push(total);
  }
  return { rows, cumulative, total };
}

/** One weighted draw: one `rng.next()`. */
export function drawOne<T>(rng: RandomnessSource, table: WeightedTable<T>): T {
  if (table.rows.length === 0 || table.total <= 0) throw new Error("worldSampler: empty table");
  const x = rng.next() * table.total;
  let lo = 0, hi = table.cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table.cumulative[mid]! > x) hi = mid; else lo = mid + 1;
  }
  return table.rows[lo]!;
}

/**
 * Draw with ordered constraint levels. `levels[0]` is the strictest predicate (all constraints), the last is
 * the loosest; each level gets `triesPerLevel` attempts, then the next, then the last draw is taken as is.
 * Bounded (never spins), deterministic.
 */
export function drawConstrained<T>(
  rng: RandomnessSource, table: WeightedTable<T>, levels: ReadonlyArray<(row: T) => boolean>, triesPerLevel = 60,
): T {
  let last: T | undefined;
  for (const ok of levels) {
    for (let i = 0; i < triesPerLevel; i++) {
      const row = drawOne(rng, table);
      last = row;
      if (ok(row)) return row;
    }
  }
  return last ?? drawOne(rng, table);
}
