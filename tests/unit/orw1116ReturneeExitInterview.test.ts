import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { answerPending } from "../../features/support/answerPending";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";

/** ORW-1116 (audit 11-27 A9): a battle-back returnee evicted a second time had two exit interviews; the first records an exit the return undid. One per houseguest, the latest. */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const r = answerPending(p as never);
  if (r) s.submitDecision(r as SubmitDecisionReq);
}
type Live = { active: string[]; evictionOrder: string[]; evictedTaken?: string[]; firedTwists?: Array<{ kind: string }>; finished?: boolean };


describe("ORW-1116: one exit interview per houseguest across a battle-back", () => {
  it("no houseguest has two exit interviews, and nobody back in the house has one", () => {
    let sawReturn = false, returneeLeftAgain = false;
    for (const seed of [2, 5, 6, 4, 1, 3]) {
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor(`orw1116-${seed}`);
      sb.session.setReactiveTwistsEnabled(true);
      sb.session.createCharacter({ playerName: "The Player", seed });
      const core = sb.session.snapshot();
      (core.live as unknown as { twistPlan: object; playedGame: boolean }).twistPlan = { doubleEvictionAtActive: 8, doubleEvictionArmed: false, secretVetoStreak: 2, secretVetoArmed: false, battleBackAtJury: 1, battleBackArmed: true };
      (core.live as unknown as { playedGame: boolean }).playedGame = true;
      sb.session.restore(core);
      (sb.session as unknown as { scheduleGateBypass: boolean }).scheduleGateBypass = true;
      sb.session.noteMessage({ messageId: "m1" });
      const s = sb.session as unknown as { live: Live & { exitInterviews?: Array<{ evictee: string }> }; advanceGame(): AdvanceView };
      const returnees: string[] = [];
      for (let i = 0; i < 6000; i++) {
        const before = new Set(s.live.evictionOrder);
        const v = s.advanceGame();
        if (v.pending) resolve(sb.session as unknown as GameSessionAdapter, v.pending);
        const after = s.live;
        if (after.firedTwists?.some((t) => t.kind === "battle-back")) {
          for (const id of before) if (!after.evictionOrder.includes(id) && after.active.includes(id) && !returnees.includes(id)) { returnees.push(id); sawReturn = true; }
        }
        const ids = (after.exitInterviews ?? []).map((x) => x.evictee);
        expect(new Set(ids).size, `seed ${seed}: an exit interview is duplicated`).toBe(ids.length);
        for (const id of returnees) if (after.active.includes(id)) expect(ids.includes(id), `seed ${seed}: ${id} is back in the house with an exit interview`).toBe(false);
        for (const id of returnees) if (ids.includes(id)) returneeLeftAgain = true;
        if (v.finished) break;
      }
      if (sawReturn && returneeLeftAgain) break;
    }
    expect(sawReturn, "a battle-back returned someone on a scanned seed").toBe(true);
  }, 900_000);
});
