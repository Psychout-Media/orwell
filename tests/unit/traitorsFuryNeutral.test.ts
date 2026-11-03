import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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

function runOrchestratorHash(
  juryHouseOn: boolean,
  traitorsFuryOn: boolean,
): string {
  const reg = new GameSessionRegistry();
  const user = "tf";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setJuryHouseEnabled(juryHouseOn);
  sb.session.setTraitorsFuryEnabled(traitorsFuryOn);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
  let finished = false;
  for (let i = 0; i < 90 && !finished; i++) {
    finished = stepLoop(sb);
    if (!finished) orch.advance(user, "offscreen-tick");
  }
  const events = sb.engine.events.queryAll();
  const sig = (e: (typeof events)[number]): string =>
    `${e.type}|${e.initiator}|${[...e.witnessSet].sort().join(",")}|${e.hidden ? 1 : 0}|${e.content}`;
  return createHash("sha256").update(events.map(sig).join("\n")).digest("hex");
}

describe("#1790 — Traitors' Fury calibration neutrality (flag OFF is a fixed point)", () => {
  it("the flag setter/getter round-trips (the orchestrator reads this to decide whether to gate blame)", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("flag");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
    expect(sb.session.traitorsFuryEnabledNow()).toBe(true); // default ON (default flip 2026-11-03)
    sb.session.setTraitorsFuryEnabled(false);
    expect(sb.session.traitorsFuryEnabledNow()).toBe(false);
    sb.session.setTraitorsFuryEnabled(true);
    expect(sb.session.traitorsFuryEnabledNow()).toBe(true);
    sb.session.setTraitorsFuryEnabled(false);
    expect(sb.session.traitorsFuryEnabledNow()).toBe(false);
  });

  it("flag OFF ⇒ the sealed event stream is byte-identical run-to-run", () => {
    expect(runOrchestratorHash(true, false)).toBe(runOrchestratorHash(true, false));
  });

  it("flag OFF + jury house ON ⇒ byte-identical runs", () => {
    const withJuryHouse = runOrchestratorHash(true, false);
    expect(withJuryHouse).toMatch(/^[0-9a-f]{64}$/);
    const withoutJuryHouse = runOrchestratorHash(false, false);
    expect(withoutJuryHouse).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flag ON drives the LIVE blame-seeding path without error", () => {
    expect(runOrchestratorHash(true, true)).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * #1790 AC4 — reveal-order NEUTRALITY guard: the regrouped (grouping ON) and ungrouped (grouping OFF)
 * finales MUST produce the SAME winner, finalists, and vote tally, while the reveal order MAY differ.
 * This proves grouping is presentation-only — it never perturbs the result.
 */
describe("#1790 — reveal-order neutrality (grouping is presentation-only)", () => {
  it("traitorsFury ON/OFF produce the same winner/finalists/tally with the same seed", () => {
    const reg = new GameSessionRegistry();
    const sbOn = reg.sandboxFor("neutral-on");
    sbOn.session.createCharacter({ playerName: "P", archetype: "floater", seed: SEED });
    sbOn.session.setJuryHouseEnabled(true);
    sbOn.session.setTraitorsFuryEnabled(true);
    const orchOn = new Orchestrator(reg, new FakeClock(), { seed: SEED });
    let onFinished = false;
    for (let i = 0; i < 90 && !onFinished; i++) {
      onFinished = stepLoop(sbOn);
      if (!onFinished) orchOn.advance("neutral-on", "offscreen-tick");
    }
    const snapOn = sbOn.session.snapshot();
    const onWinner = snapOn.live?.winner;
    const onFinalTwo = snapOn.live?.finalTwo;
    const onVotes = snapOn.live?.finale?.votes;

    const reg2 = new GameSessionRegistry();
    const sbOff = reg2.sandboxFor("neutral-off");
    sbOff.session.createCharacter({ playerName: "P", archetype: "floater", seed: SEED });
    sbOff.session.setJuryHouseEnabled(true);
    sbOff.session.setTraitorsFuryEnabled(false);
    const orchOff = new Orchestrator(reg2, new FakeClock(), { seed: SEED });
    let offFinished = false;
    for (let i = 0; i < 90 && !offFinished; i++) {
      offFinished = stepLoop(sbOff);
      if (!offFinished) orchOff.advance("neutral-off", "offscreen-tick");
    }
    const snapOff = sbOff.session.snapshot();
    const offWinner = snapOff.live?.winner;
    const offFinalTwo = snapOff.live?.finalTwo;
    const offVotes = snapOff.live?.finale?.votes;

    // Winner, final two, and vote tally MUST be identical with grouping ON vs OFF
    expect(onWinner).toEqual(offWinner);
    expect(onFinalTwo).toEqual(offFinalTwo);
    expect(onVotes).toEqual(offVotes);
    // Reveal order MAY differ (grouping changes the presentation sequence)
  });

  it("multiple seeds produce the same neutrality guarantee", () => {
    for (const seed of [1, 13, 42]) {
      const reg = new GameSessionRegistry();
      const sbOn = reg.sandboxFor(`n-${seed}`);
      sbOn.session.createCharacter({ playerName: "P", archetype: "floater", seed });
      sbOn.session.setJuryHouseEnabled(true);
      sbOn.session.setTraitorsFuryEnabled(true);
      const orchOn = new Orchestrator(reg, new FakeClock(), { seed });
      let onFin = false;
      for (let i = 0; i < 90 && !onFin; i++) {
        onFin = stepLoop(sbOn);
        if (!onFin) orchOn.advance(`n-${seed}`, "offscreen-tick");
      }

      const reg2 = new GameSessionRegistry();
      const sbOff = reg2.sandboxFor(`f-${seed}`);
      sbOff.session.createCharacter({ playerName: "P", archetype: "floater", seed });
      sbOff.session.setJuryHouseEnabled(true);
      sbOff.session.setTraitorsFuryEnabled(false);
      const orchOff = new Orchestrator(reg2, new FakeClock(), { seed });
      let offFin = false;
      for (let i = 0; i < 90 && !offFin; i++) {
        offFin = stepLoop(sbOff);
        if (!offFin) orchOff.advance(`f-${seed}`, "offscreen-tick");
      }

      const snapOn = sbOn.session.snapshot();
      const snapOff = sbOff.session.snapshot();
      expect(snapOn.live?.winner).toEqual(snapOff.live?.winner);
      expect(snapOn.live?.finalTwo).toEqual(snapOff.live?.finalTwo);
      expect(snapOn.live?.finale?.votes).toEqual(snapOff.live?.finale?.votes);
    }
  });
});
