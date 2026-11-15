import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { mannerForVote, newLiveSeason, type FinaleProgress, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import { juryLean } from "../../src/engine/jury";
import { npc } from "../../src/domain/ids";

/**
 * A62 (#2017 13.2.4, behind ORWELL_JUROR_PROFILES, default OFF): a juror's grievance can rest on a WRONG belief (0110 deduction error); a `mend` appeal corrects exactly that mistake and never a true
 * grievance. Flag-off is byte-identical. Roles only. (ORW-129, Ryne: a mend FADES a mistaken grievance but leaves a trace - see mendLeavesTrace.test.ts.)
 */
const JA = npc(1), JB = npc(2), FIN = npc(3), OTHER = npc(4);
const grievance = { betrayed: true, intensity: 1 } as const;
function board(): LiveSeasonState {
  const s = newLiveSeason([JA, JB, FIN, OTHER]);
  s.mannerByEvictee = { [JA]: { [FIN]: { ...grievance } }, [JB]: { [FIN]: { ...grievance } } };
  s.mistakenBlame = { [JA]: [FIN] }; // JA WRONGLY blames FIN; JB's grievance is TRUE
  return s;
}
const fp = (appeal?: "mend"): FinaleProgress => ({ appeals: appeal ? { [FIN]: { [JA]: appeal, [JB]: appeal } } : {} } as unknown as FinaleProgress);
const ctx = (on: boolean) => ({ jurorProfiles: on }) as unknown as SeasonCtx;

describe("A62 - mistaken blame and the mend appeal", () => {
  it("flag OFF: exactly the recorded manner, even with a mistaken-blame record present (byte-identical)", () => {
    const s = board();
    expect(mannerForVote(s, ctx(false), fp("mend"), JA, FIN)).toEqual(s.mannerByEvictee![JA]![FIN]);
    expect(mannerForVote(s, ctx(false), fp(), JA, FIN)).toEqual(s.mannerByEvictee![JA]![FIN]);
  });
  it("flag ON, no mend: the mistaken grievance is carried (flagged mistaken), a true one is untouched", () => {
    const s = board();
    expect(mannerForVote(s, ctx(true), fp(), JA, FIN)).toEqual({ ...grievance, mistaken: true });
    expect(mannerForVote(s, ctx(true), fp(), JB, FIN)).toEqual({ ...grievance });
  });
  it("flag ON + mend: the MISTAKEN grievance is faded to a trace (not erased, ORW-129); the TRUE one is untouched", () => {
    const s = board();
    const a = mannerForVote(s, ctx(true), fp("mend"), JA, FIN);
    expect(a.mistaken).toBeUndefined();
    expect(a.betrayed, "the grievance stays, faded").toBe(true);
    expect(a.intensity!).toBeGreaterThan(0); expect(a.intensity!).toBeLessThan(1);
    expect(mannerForVote(s, ctx(true), fp("mend"), JB, FIN).betrayed).toBe(true);
  });
  it("the same board, two jurors holding different beliefs, lean differently once the finalist mends", () => {
    const s = board();
    const rel = { trust: 0.5, affinity: 0.5, threat: 0, reliability: 0 };
    const leanA = juryLean(rel, mannerForVote(s, ctx(true), fp("mend"), JA, FIN));
    const leanB = juryLean(rel, mannerForVote(s, ctx(true), fp("mend"), JB, FIN));
    expect(leanA).toBeGreaterThan(leanB);
  });
  it("end to end: with deduction + profiles ON some eviction records a WRONG blame; with the flag OFF none is ever recorded", () => {
    let wrongOn = 0, wrongOff = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const on of [true, false]) {
        const s = new GameSessionRegistry().sandboxFor(`mb-${on}-${seed}`).session;
        s.createCharacter({ playerName: "P", seed });
        s.setVoteDeductionEnabled(true);
        s.setJurorProfilesEnabled(on);
        s.advanceToFinale();
        const blame = (s.snapshot().live as unknown as LiveSeasonState).mistakenBlame ?? {};
        const n = Object.values(blame).reduce((a, v) => a + v.length, 0);
        if (on) wrongOn += n; else wrongOff += n;
      }
    }
    expect(wrongOff).toBe(0);
    expect(wrongOn, "deduction errors happen on some seeds, and are recorded").toBeGreaterThan(0);
  });
});
