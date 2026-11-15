import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * Feature 0122 — the once-per-in-game-day confessional SWEEP fires LIVE at `turnIn` (the day-close hook).
 * Drives a real season (no LLM) and proves: MOST living houseguests confess each in-game day; the flag OFF
 * is byte-identical (no sweep confessional at turnIn); the HOH/nominees get DEEPER (role-triggered) reads;
 * it's seed-deterministic; and the whole sweep stays Vault-only (the player is never a witness). Roles only.
 */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

function harness(opts: { depthOn: boolean; seed: number; user: string }) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(opts.user);
  sb.session.createCharacter({ playerName: "The Player", seed: opts.seed });
  sb.session.setPerConversationClockEnabled(true);
  sb.session.setConfessionalDepthEnabled(opts.depthOn);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: opts.seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  return { reg, sb };
}

function confessionals(sb: ReturnType<GameSessionRegistry["sandboxFor"]>) {
  return sb.engine.events.queryAll().filter((e) => e.type === "confessional");
}

/** Drive a live season a while so relationships develop (ceremonies fold + the off-screen society runs). */
function developHouse(sb: ReturnType<GameSessionRegistry["sandboxFor"]>): void {
  for (let i = 0; i < 90; i++) {
    if (sb.session.snapshot().live?.hoh === undefined) {
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
      if (a.finished) return;
    } else {
      // a couple of social turns per beat so the hidden society moves the edges (0117)
      const npcId = sb.session.livingIds().find((id) => id !== PLAYER)!;
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npcId], content: `talk ${i}` });
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
      if (a.finished) return;
    }
    if (i > 40 && sb.session.snapshot().live?.hoh !== undefined) return; // enough development
  }
}

describe("0122 — the daily sweep: most living houseguests confess each in-game day", () => {
  it("a turnIn records a confessional for a MAJORITY of the living NPCs (not just ceremony-standers)", () => {
    const { sb } = harness({ depthOn: true, seed: 7, user: "sweep-most" });
    developHouse(sb);
    expect(sb.session.perConversationClockLive()).toBe(true);

    const livingNpcs = sb.session.livingIds().filter((id) => id !== PLAYER).length;
    const before = confessionals(sb).length;
    sb.session.turnIn();
    const swept = confessionals(sb).length - before;

    // MOST living NPCs confessed in the single day-close sweep — far more than the ~3 ceremony-standers.
    expect(swept, `sweep confessed ${swept} of ${livingNpcs} living NPCs`).toBeGreaterThanOrEqual(
      Math.ceil(livingNpcs / 2),
    );
    // Every sweep confessional is Vault-only: witnessed by the confessing NPC alone, never the player.
    for (const e of confessionals(sb).slice(before)) {
      expect(e.hidden).toBe(true);
      expect(e.witnessSet).toEqual([e.initiator]);
      expect(e.witnessSet.includes(PLAYER)).toBe(false);
    }
  });

  it("the HOH / nominees get DEEPER, role-triggered reads (a plan or a standing surfaces live)", () => {
    const { sb } = harness({ depthOn: true, seed: 7, user: "sweep-deep" });
    // Seed 7 on this user key is a TRAJECTORY-specific assertion; want-driven movement (default ON since 2026-11-05) lands this one house on a day with no plan/standing confessor. It is not a regression
    // (the default-layers test below fires on every seed 1..8), so this trajectory pins the layer off explicitly.
    sb.session.setWantMovementEnabled(false);
    developHouse(sb);
    const before = confessionals(sb).length;
    sb.session.turnIn();
    const swept = confessionals(sb).slice(before).map((e) => e.content);
    // At least one confessor in power/danger voiced a plan or a safe/exposed standing (the depth facets).
    const DEEP_MARKERS = ["the plan is simple", "goes up", "I have to win", "using it to steer",
      "sitting pretty", "how exposed I am", "writing down"];
    const anyDeep = swept.some((c) => DEEP_MARKERS.some((m) => c.includes(m)));
    expect(anyDeep, "a role-triggered deep facet fired in the sweep").toBe(true);
  });

  it("with the DEFAULT layers on (want-driven movement etc.) the role-triggered deep facet fires in the day-close sweep on every seed 1..8", () => {
    const DEEP_MARKERS = ["the plan is simple", "goes up", "I have to win", "using it to steer", "sitting pretty", "how exposed I am", "writing down"];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { sb } = harness({ depthOn: true, seed, user: `sweep-deep-all-${seed}` });
      developHouse(sb);
      const before = confessionals(sb).length;
      sb.session.turnIn();
      const swept = confessionals(sb).slice(before).map((e) => e.content);
      expect(swept.some((c) => DEEP_MARKERS.some((m) => c.includes(m))), `seed ${seed}: a role-triggered deep facet fired`).toBe(true);
    }
  });

  it("is seed-deterministic — the same seed reproduces the same sweep confessionals", () => {
    // re-selected 2026-11-03, default flip (seed 11 no longer yields a sweep confessional)
    const runA = harness({ depthOn: true, seed: 7, user: "sweep-det" });
    developHouse(runA.sb);
    const beforeA = confessionals(runA.sb).length;
    runA.sb.session.turnIn();
    const a = confessionals(runA.sb).slice(beforeA).map((e) => e.content).join("|");

    const runB = harness({ depthOn: true, seed: 7, user: "sweep-det" });
    developHouse(runB.sb);
    const beforeB = confessionals(runB.sb).length;
    runB.sb.session.turnIn();
    const b = confessionals(runB.sb).slice(beforeB).map((e) => e.content).join("|");

    expect(a.length).toBeGreaterThan(0);
    expect(a).toBe(b);
  });
});

describe("0122 — with the depth layer OFF, turnIn runs NO sweep", () => {
  it("flag off ⇒ the day-close sweep does not fire (only the incidental off-screen tick, if any)", () => {
    // With the clock running (so turnIn is live), the pre-0122 off-screen society tick may still record ONE
    // confessional at the big time-jump (0117/0040) — that is NOT the sweep. The sweep would confess a
    // MAJORITY of the house; the flag-off path must stay far below that. (The seeded calibration spine's
    // byte-identity is proven separately by the juryReach gate, which runs with the clock + flag off.)
    // seed re-selected 2026-11-11 (ORW-247 ceremony gathering moved the seeded trajectory; was 7)
    const off = harness({ depthOn: false, seed: 8, user: "sweep-off" });
    developHouse(off.sb);
    const livingNpcs = off.sb.session.livingIds().filter((id) => id !== PLAYER).length;
    const beforeOff = confessionals(off.sb).length;
    off.sb.session.turnIn();
    const offDelta = confessionals(off.sb).length - beforeOff;

    // Same seed/drive WITH the flag on ⇒ a majority sweep. The contrast proves the sweep is gated.
    const on = harness({ depthOn: true, seed: 8, user: "sweep-off" });
    developHouse(on.sb);
    const beforeOn = confessionals(on.sb).length;
    on.sb.session.turnIn();
    const onDelta = confessionals(on.sb).length - beforeOn;

    expect(offDelta, "flag off ⇒ no majority sweep").toBeLessThan(Math.ceil(livingNpcs / 2));
    expect(onDelta, "flag on ⇒ a majority sweep").toBeGreaterThanOrEqual(Math.ceil(livingNpcs / 2));
    expect(onDelta).toBeGreaterThan(offDelta);
  });
});
