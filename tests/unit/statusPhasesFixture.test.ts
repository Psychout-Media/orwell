import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";

/**
 * P4 phase-drivability guard, ENGINE half. `frontend/tests/fixtures/engine_status_phases.json` lists every public status phase the live engine can sit in; the FE test
 * (`test_phase_drivability_guard.py`) proves the front-end drives each one (or it waits on a player card). This test keeps that list HONEST against the engine, so a
 * newly added phase can't slip past the FE guard: (1) every phase observed over twist-heavy seasons is in the fixture; (2) every structural `s.beat = "…"` the engine
 * source assigns is in the fixture. Roles only.
 */
const FIX = JSON.parse(readFileSync("frontend/tests/fixtures/engine_status_phases.json", "utf8")) as { phases: string[] };
const declared = new Set(FIX.phases);

describe("the shared engine-phase fixture matches the engine", () => {
  it("every structural beat the engine assigns (s.beat = \"…\") is declared", () => {
    const src = readFileSync("src/engine/liveSeason.ts", "utf8");
    const assigned = new Set([...src.matchAll(/\bs\.beat = "([a-z-]+)"/g)].map((m) => m[1]!));
    for (const b of assigned) expect(declared.has(b), `engine assigns beat '${b}' but the fixture does not list it`).toBe(true);
    expect(assigned.size).toBeGreaterThan(5);
  });

  it("every status phase observed across twist-heavy seasons (double eviction, battle-back, secret veto, Final 3, finale) is declared", () => {
    const seen = new Set<string>();
    for (const seed of [4, 5, 8, 9, 10, 12, 13, 16, 32]) {
      const s = new GameSessionRegistry().sandboxFor(`ph-${seed}`).session;
      s.createCharacter({ playerName: "P", seed });
      for (let i = 0; i < 9000; i++) {
        seen.add(s.gameStatus().phase);
        const v = s.advanceGame();
        if (v.pending) resolvePending(v.pending, (r) => void s.submitDecision(r));
        if (v.finished) break;
      }
      seen.add(s.gameStatus().phase);
    }
    for (const p of seen) expect(declared.has(p), `the engine reached phase '${p}' that the fixture does not declare`).toBe(true);
    // the sample must actually exercise the twist phases, or the guard is vacuous
    for (const p of ["twist-reveal", "battle-back", "final-eviction", "finale"]) expect(seen.has(p), `sample never reached ${p}`).toBe(true);
  }, 300_000);
});
