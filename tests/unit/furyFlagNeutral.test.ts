import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/**
 * ORW-325 / 0135 - the Traitors' Fury flag must not change the season. The same seed played with the flag ON and OFF must crown the same winner with the same finalists and the same jury tally.
 * Two leaks used to break this on about 1 seed in 4 (BDD 0135 lines 13 and 20): the blame beliefs (and their diffused copies) were candidates of the generic co-presence gossip spread, and the blame
 * diffusion's own hidden events shifted the event-count the co-presence rolls are keyed on. Seed 16 diverged before the fix; 1, 2, 3 and 16 are neutral now. NOT neutral yet under this (shipping-like) profile: seeds 7 and 8, which ORW-325 keeps open (the BDD config pins philosophies and calm presence off, which hides seed 7). Roles only.
 */
function playSeason(fury: boolean, seed: number) {
  const reg = new GameSessionRegistry();
  const user = `fury-neutral-${seed}`;
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.setJuryHouseEnabled(true);
  sb.session.setTraitorsFuryEnabled(fury);
  const orch = new Orchestrator(reg, new FakeClock(), { seed });
  let finished = false;
  for (let i = 0; i < 500 && !finished; i++) {
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
    finished = adv.finished;
    if (!finished) orch.advance(user, "offscreen-tick");
  }
  expect(finished, `seed ${seed} fury=${fury}: the season finished within the budget`).toBe(true);
  return sb.session;
}

describe("ORW-325 - the Traitors' Fury flag is outcome-neutral", () => {
  for (const seed of [1, 2, 3, 16]) {
    it(`seed ${seed}: the same winner, finalists and jury tally with the flag on and off`, () => {
      const on = playSeason(true, seed).snapshot().live!;
      const off = playSeason(false, seed).snapshot().live!;
      expect(on.winner).toEqual(off.winner);
      expect(on.finalTwo).toEqual(off.finalTwo);
      expect(on.finale?.votes).toEqual(off.finale?.votes);
      expect(on.evictionOrder).toEqual(off.evictionOrder);
    }, 120_000);
  }

  it("with the flag off the event tally stays absent (byte-identical, nothing subtracted from the seed key)", () => {
    const s = playSeason(false, 3);
    expect((s as unknown as { furyEventCountNow(): number }).furyEventCountNow()).toBe(0);
    expect((s.snapshot().live as unknown as { furyEvents?: number }).furyEvents).toBeUndefined();
  }, 120_000);
});
