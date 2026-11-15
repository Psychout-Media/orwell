import { endHeldNightSync } from "../support/heldNight";
import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { liveRichnessMetrics } from "../../src/engine/richness";
import { RICHNESS } from "../../src/engine/richnessConfig";
import type { AdvanceView } from "../../src/ports/GameSession";

/**
 * B54 / audit D3 — richness measured on the PRODUCTION path. The 0003 property test drives
 * `simulateSeason`, which has no production callers — the live game could drop to zero off-screen
 * life with every gate green. This gate drives the REAL spine — `Orchestrator.advance`
 * (offscreen ticks) + `advanceGame`/`submitDecision` (the season) — and computes the metrics from
 * the sandbox's real EventStore. If `defaultApply` stops recording typed scenes, this FAILS.
 * Roles only — no fixture names.
 */

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const WEEKS = 3;

function resolve(s: ReturnType<GameSessionRegistry["sandboxFor"]>["session"], p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" }); // 0006 staged-rounds
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}

/**
 * Play the live spine wired EXACTLY like production (`composeRuntime` in pure turn-driven mode):
 * the orchestrator is the registry's commit delegate, so every player mutation runs the
 * fail-closed checkpoint AND one bounded off-screen tick — the house lives between turns.
 */
function playLiveStretch(seed: number) {
  const reg = new GameSessionRegistry();
  const user = `rich-${seed}`;
  const orch = new Orchestrator(reg, { now: () => seed }, { seed, turnDriven: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const edgesBefore = JSON.stringify(sb.engine.relationships.serialize());

  for (let i = 0; i < 600; i++) {
    const v = sb.session.advanceGame();
    if (v.held) endHeldNightSync(sb.session, { direct: true }); // ORW-116: a held night is the player's: time passes, then they turn in
    if (v.pending) resolve(sb.session, v.pending);
    if (v.status.week > WEEKS || v.finished) break;
  }
  return { sb, edgesBefore };
}

describe("behavioral fidelity on the PRODUCTION path (B54)", () => {
  it("offscreen share, type diversity, alliance life, and bounded reveals hold across 20 seeds", () => {
    let revealsAcrossSeeds = 0;
    for (const seed of SEEDS) {
      const { sb, edgesBefore } = playLiveStretch(seed);
      const m = liveRichnessMetrics(sb.engine.events.queryAll());
      const ctx = `seed ${seed}: ${JSON.stringify({ ...m, types: m.types.slice(0, 12) })}`;

      // The off-screen society EXISTS on the live path, and it dominates (0003 mandate #1).
      expect(m.typedScenes, ctx).toBeGreaterThanOrEqual(6);
      expect(m.offscreenShare, ctx).toBeGreaterThanOrEqual(RICHNESS.MIN_OFFSCREEN_SHARE);
      // The house lives in MORE than one way (0038): real type variety, not one verb on repeat.
      expect(m.typeDiversity, ctx).toBeGreaterThanOrEqual(RICHNESS.MIN_TYPE_DIVERSITY);
      // Alliance life: bonds form AND churn (conflict/betrayal pressure) on the live path.
      expect(m.allianceScenes + m.churnScenes, ctx).toBeGreaterThanOrEqual(1);
      // Hidden elements surface RARELY — never a dump (B50's gate, measured from the store).
      expect(m.revealShare, ctx).toBeLessThanOrEqual(RICHNESS.MAX_SURFACING_RATE * 2);
      revealsAcrossSeeds += m.totalReveals;

      // The hidden relationship layer genuinely moved (consequence, 0023).
      expect(JSON.stringify(sb.engine.relationships.serialize()), ctx).not.toBe(edgesBefore);
    }
    // The rare-reveal loop is ALIVE in aggregate (deleting the sim's reveals=1 back-stop, B54):
    // across 20 seeds of live play, at least one hidden element genuinely surfaced.
    expect(revealsAcrossSeeds).toBeGreaterThan(0);
  });
});
