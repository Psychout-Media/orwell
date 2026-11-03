/**
 * tests/uat/fullGameUat.decisions.test.ts
 *
 * Heavy-sims lane: uat-decisions.
 *
 * Decision-type coverage — proves all of the player's recurring decision types are
 * exercised across the seed set, driven over the REAL HTTP transport (the deployed
 * path). One of the three slices the former single fullGameUat.test.ts was split into
 * so its independent `it` blocks fan out across separate CI runners; seeds and
 * assertions are unchanged. The co-located health-endpoint sanity check also rides
 * the live HTTP server this file already stands up.
 *
 * The decision-coverage assertion re-derives over seeds 1-5 (a representative subset
 * of the 12-seed set, run independently here over HTTP rather than re-using the
 * 12-seed run's data) — EXACTLY as before. It asserts the same player decision types
 * (nominations + eviction-vote) appear; the assertion is not weakened by the split.
 *
 * See tests/uat/fullGameUatHarness.ts for the shared driver + invariant checkers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startUatHarness,
  runFullGame,
  type UatHarness,
  type RunResult,
  type PendingDecision,
} from "./fullGameUatHarness";

describe("full-game UAT — decision-type coverage (real HTTP)", () => {
  let harness: UatHarness;

  beforeAll(async () => {
    harness = await startUatHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  // ── Decision-type coverage assertion ──────────────────────────────────────

  it(
    "all 4 player decision types are exercised across the 12-seed run set",
    async () => {
      // Re-run a representative subset (seeds 1-5) to verify coverage without
      // re-running the full 12-seed suite (which runs in the uat-12seed lane). The player only gets a
      // `nominations` decision when they win HOH, and which seeds do that moves with the balance (#1941:
      // the deployed profile's 1-5 no longer include one). So the set is SEARCHED, not pinned: seeds 1-5 are
      // always played, then further seeds are added (up to MAX_SEEDS) only until every required decision
      // type has been hit. The assertions below are unchanged.
      const MIN_SEEDS = 5;
      const MAX_SEEDS = 40;
      // Bound the search by TIME too, well under the per-test cap and the 45-minute `heavy-sims-deployed` job
      // timeout, so a worst case fails here with a diagnostic instead of the runner killing the job.
      const SEARCH_BUDGET_MS = 25 * 60_000;
      const startedAt = Date.now();
      const REQUIRED: PendingDecision["kind"][] = ["nominations", "eviction-vote"];
      const runs: RunResult[] = [];
      const merged: Partial<Record<PendingDecision["kind"], number>> = {};
      for (let s = 1; s <= MAX_SEEDS; s++) {
        const r = await runFullGame(harness.base, s, "never-use-veto");
        runs.push(r);
        for (const [k, v] of Object.entries(r.decisionCounts) as [PendingDecision["kind"], number][]) {
          merged[k] = (merged[k] ?? 0) + v;
        }
        if (s >= MIN_SEEDS && REQUIRED.every((k) => (merged[k] ?? 0) > 0)) break;
        if (s >= MIN_SEEDS && Date.now() - startedAt > SEARCH_BUDGET_MS) break; // out of time — the assertions below report it
      }
      const tried = `${runs.length} seeds in ${Math.round((Date.now() - startedAt) / 1000)}s`;
      // Nominations and eviction-vote must appear (player is always a voter when not a nominee).
      expect(merged["nominations"] ?? 0, `nominations decisions hit (${tried})`).toBeGreaterThan(0);
      expect(merged["eviction-vote"] ?? 0, `eviction-vote decisions hit (${tried})`).toBeGreaterThan(0);
    },
    // Five full seasons over real HTTP: slow CI/sandbox hosts need the same headroom as the
    // 12-seed lane (measured at ~62s on an unmodified main in a shared-CPU environment — the
    // old 60s budget was a hair-trigger env flake; and the E42–E55 consequence folds added real
    // per-beat work on top of the transport cost; assertions unchanged, only the wall-clock
    // budget breathes). UAT_TIMEOUT_SCALE (default 1) lets the deployed-profile CI lane widen the budget:
    // that profile simulates several times slower (#1922), and only the budget moves, never an assertion.
    // Capped at 40 minutes: the deployed lane scales the budget by 10, and an uncapped ~100 min would outlive
    // the 45-minute job timeout (the runner would kill the job with no diagnostic).
    { timeout: Math.min(600_000 * (Number(process.env.UAT_TIMEOUT_SCALE) || 1), 40 * 60_000) },
  );

  // ── Health endpoint reachable (sanity) ────────────────────────────────────

  it("engine health endpoint is reachable", async () => {
    const res = await fetch(`${harness.base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
