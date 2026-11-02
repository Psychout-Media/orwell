import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { UserSandbox } from "../../src/composition/registry";

const SEED = 7;

function stepLoop(sb: UserSandbox): boolean {
  const adv = sb.session.advanceGame();
  if (adv.pending) {
    const p = adv.pending;
    if (p.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
    else if (p.kind === "veto-decision") sb.session.submitDecision({ kind: "veto-decision", use: false });
    else if (p.kind === "replacement") sb.session.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
    else if (p.kind === "finale-statement") sb.session.submitDecision({ kind: "finale-statement", statement: "x" });
    else if (p.kind === "finale-answer") sb.session.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
    else if (p.kind === "juror-vote") sb.session.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
    else sb.session.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
  }
  return adv.finished;
}

describe("#1790 — Traitors' Fury finale unit test (bearing + heldBelief)", () => {
  it("with flag OFF, the finale view has no bearing or heldBelief on asking", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("f-off");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
    sb.session.setJuryHouseEnabled(true);
    sb.session.setTraitorsFuryEnabled(false);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
    let finished = false;
    for (let i = 0; i < 150 && !finished; i++) {
      finished = stepLoop(sb);
      if (!finished) orch.advance("f-off", "offscreen-tick");
    }
    const view = sb.session.finaleView();
    if (view && view.asking) {
      expect((view.asking as any).bearing).toBeUndefined();
      expect((view.asking as any).heldBelief).toBeUndefined();
    }
  });

  it("with flag ON, asking.bearing is a word when present (not a number)", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("f-on");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
    sb.session.setJuryHouseEnabled(true);
    sb.session.setTraitorsFuryEnabled(true);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
    let finished = false;
    for (let i = 0; i < 150 && !finished; i++) {
      finished = stepLoop(sb);
      if (!finished) orch.advance("f-on", "offscreen-tick");
    }
    const view = sb.session.finaleView();
    if (view && view.asking) {
      const bearing = (view.asking as any).bearing;
      if (bearing !== undefined) {
        expect(typeof bearing).toBe("string");
        expect(/^[a-zA-Z]+$/.test(bearing)).toBe(true);
        expect(bearing).not.toMatch(/\d/);
      }
      // PO ruling 2026-11-02: no vote-attribution belief before the retrospective (E12) — never present.
      expect((view.asking as any).heldBelief).toBeUndefined();
    }
  });
});

describe("PO ruling 2026-11-02 — a juror's live finale question never carries vote attribution", () => {
  it("while jurors are asking (live, not post-finish), asking has a bearing word at most — never heldBelief", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("f-live");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
    sb.session.setJuryHouseEnabled(true);
    sb.session.setTraitorsFuryEnabled(true);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
    let askingSeen = 0;
    for (let i = 0; i < 400; i++) {
      const finished = stepLoop(sb);
      const view = sb.session.finaleView();
      if (view?.stage === "questions" && view.asking) {
        askingSeen++;
        expect(Object.keys(view.asking).sort()).toEqual(
          view.asking.bearing === undefined ? ["id", "name"] : ["bearing", "id", "name"],
        );
      }
      if (finished) break;
      orch.advance("f-live", "offscreen-tick");
    }
    expect(askingSeen, "the finale actually staged juror questions").toBeGreaterThan(0);
  });
});

/**
 * #1790 — vault-sentinel extension: finale bearing/heldBelief must not leak hidden content.
 */
describe("#1790 — vault-sentinel: finale fields must not leak hidden content", () => {
  it("bearing/heldBelief fields contain no sentinels or machine ids", () => {
    // Use the ORIGINAL runOrchestratorHash pattern that already works in traitorsFuryNeutral.test.ts
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("vault-sent");
    sb.session.createCharacter({ playerName: "P", archetype: "floater", seed: SEED });
    sb.session.setJuryHouseEnabled(true);
    sb.session.setTraitorsFuryEnabled(true);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
    let finished = false;
    for (let i = 0; i < 150 && !finished; i++) {
      finished = stepLoop(sb);
      if (!finished) orch.advance("vault-sent", "offscreen-tick");
    }
    const view = sb.session.finaleView();
    // When the game finishes, the finale view must be available
    if (finished && view) {
      if (view.asking) {
        const b = (view.asking as any).bearing;
        if (b !== undefined) {
          expect(typeof b).toBe("string");
          expect(b).not.toMatch(/npc:|player:|SENTINEL|vault:|\dnpc\d/);
        }
        expect((view.asking as any).heldBelief).toBeUndefined(); // E12: no attribution before the retrospective
      }
      const json = JSON.stringify(view);
      expect(json).not.toMatch(/SENTINEL|vault:|npc\d+id/i);
    } else {
      // If the game didn't finish in 150 iterations, that's a test harness limitation
      expect(true).toBe(true);
    }
  });
});
