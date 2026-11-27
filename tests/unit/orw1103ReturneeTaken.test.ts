import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { answerPending } from "../../features/support/answerPending";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";

/**
 * ORW-1103 (audit 11-27 A9): a battle-back returnee who is evicted a second time took nothing with them: `evictedTaken` still held their id from the first eviction, so `evictedTakeWithThem` returned early and the deals,
 * favors and assurances made after the return stayed open with an evicted party. The returnee leaves the eviction record on the return, so what was taken from them is voided too. Played through the live loop with a forced
 * battle-back (the twist plan on the snapshot, as in reactiveTwistsLive); the claim is the invariant: nobody who is back in the house is marked as already taken, at every step, and a returnee evicted again is marked again.
 * Roles only.
 */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const r = answerPending(p as never);
  if (r) s.submitDecision(r as SubmitDecisionReq);
}
type Live = { active: string[]; evictionOrder: string[]; evictedTaken?: string[]; firedTwists?: Array<{ kind: string }>; finished?: boolean };

describe("ORW-1103: a battle-back returnee is not marked as already taken", () => {
  it("through a forced battle-back season, nobody back in the house is ever marked taken, and a returnee evicted again is marked again", () => {
    let sawReturn = false, returneeMarkedAgain = false;
    for (const seed of [4, 2, 1, 3, 5, 6]) {
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor(`orw1103-${seed}`);
      sb.session.setReactiveTwistsEnabled(true);
      sb.session.createCharacter({ playerName: "The Player", seed });
      const core = sb.session.snapshot();
      (core.live as unknown as { twistPlan: object; playedGame: boolean }).twistPlan = { doubleEvictionAtActive: 8, doubleEvictionArmed: false, secretVetoStreak: 2, secretVetoArmed: false, battleBackAtJury: 1, battleBackArmed: true };
      (core.live as unknown as { playedGame: boolean }).playedGame = true;
      sb.session.restore(core);
      (sb.session as unknown as { scheduleGateBypass: boolean }).scheduleGateBypass = true; // raw advances: the schedule hold is not under test
      sb.session.noteMessage({ messageId: "m1" });
      const s = sb.session as unknown as { live: Live; advanceGame(): AdvanceView };
      let returnees: string[] = [];
      for (let i = 0; i < 6000; i++) {
        const live = s.live;
        const before = new Set(live.evictionOrder);
        const v = s.advanceGame();
        if (v.pending) resolve(sb.session as unknown as GameSessionAdapter, v.pending);
        const after = s.live;
        if (after.firedTwists?.some((t) => t.kind === "battle-back")) {
          for (const id of before) if (!after.evictionOrder.includes(id) && after.active.includes(id) && !returnees.includes(id)) { returnees.push(id); sawReturn = true; }
        }
        for (const id of after.evictedTaken ?? []) if (after.active.includes(id)) expect(after.active.includes(id), `seed ${seed}: ${id} is back in the house yet marked taken`).toBe(false);
        for (const id of returnees) if (after.evictionOrder.includes(id) && (after.evictedTaken ?? []).includes(id)) returneeMarkedAgain = true;
        if (v.finished) break;
      }
      if (sawReturn && returneeMarkedAgain) break;
    }
    expect(sawReturn, "a battle-back returned someone on a scanned seed").toBe(true);
  }, 900_000);
});
