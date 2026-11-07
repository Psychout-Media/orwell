import { beforeEach, onTestFailed } from "vitest";
import fc from "fast-check";

/**
 * ORW-229 review (MEDIUM): CI retries a failed engine test once (`--retry=1`). fast-check normally draws a NEW random seed for every `fc.assert`,
 * so a real counterexample found on the first attempt (say, hidden information reaching a player in one rare season) could pass on the retry
 * with fresh seeds, and the job would go green with only a "flaky" warning. Here every test's fast-check seed is a pure function of the run's
 * base seed and the test's id: the retry replays exactly the first attempt's cases, so a real counterexample fails again. The base seed is new
 * on every run (pin it with ORWELL_FC_SEED), so runs still explore new cases. A failing test prints both seeds for an exact local replay.
 * Loaded for every test file via vitest.config.ts `setupFiles`; a test that passes its own `seed` to fc.assert keeps it. Pinned by
 * tests/unit/fastCheckSeedReplay.test.ts.
 */
export const FC_BASE_SEED: number = (() => {
  const raw = process.env.ORWELL_FC_SEED;
  const n = raw ? Number(raw) : NaN; // unset or empty: a fresh base seed for this run
  return Number.isInteger(n) ? n : Math.floor(Math.random() * 2 ** 31);
})();

/** The fast-check seed for one test: FNV-1a of its id, mixed with the run's base seed. Same test + same base => same seed, on every attempt. */
export function seedFor(taskId: string, base: number = FC_BASE_SEED): number {
  let h = 2166136261;
  for (let i = 0; i < taskId.length; i++) h = Math.imul(h ^ taskId.charCodeAt(i), 16777619);
  return (h ^ base) | 0;
}

beforeEach((ctx) => {
  const seed = seedFor(ctx.task.id);
  fc.configureGlobal({ ...fc.readConfigureGlobal(), seed });
  onTestFailed(() => {
    console.log(`[fast-check] "${ctx.task.name}" ran with seed ${seed}; replay this run's cases with ORWELL_FC_SEED=${FC_BASE_SEED}`);
  });
});

/** The same fast-check instance the hook configures (for tests that import it from here). */
export { fc };
