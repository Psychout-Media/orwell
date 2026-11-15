import { describe, it, expect } from "vitest";
import { mannerForVote, newLiveSeason, type FinaleProgress, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import { juryLean, mannerLeanOf } from "../../src/engine/jury";
import { MEND_TRACE } from "../../src/engine/juryConstants";
import { npc } from "../../src/domain/ids";

/**
 * ORW-129 (Ryne: "fades, leaves a trace"): a `mend` appeal used to erase a juror's MISTAKEN grievance. Now most of it clears and a small lingering doubt remains: the grievance is much weaker but above
 * zero, and it still shapes the juror's lean slightly. A TRUE grievance is untouched by a mend. Roles only.
 */
const JA = npc(1), JB = npc(2), FIN = npc(3), OTHER = npc(4);
function board(): LiveSeasonState {
  const s = newLiveSeason([JA, JB, FIN, OTHER]);
  s.mannerByEvictee = { [JA]: { [FIN]: { betrayed: true, intensity: 1 } }, [JB]: { [FIN]: { betrayed: true, intensity: 1 } } };
  s.mistakenBlame = { [JA]: [FIN] }; // JA WRONGLY blames FIN; JB's grievance is TRUE
  return s;
}
const fp = (appeal?: "mend"): FinaleProgress => ({ appeals: appeal ? { [FIN]: { [JA]: appeal, [JB]: appeal } } : {} } as unknown as FinaleProgress);
const ctx = { jurorProfiles: true } as unknown as SeasonCtx;
const rel = { trust: 0.5, affinity: 0.5, threat: 0, reliability: 0 };

describe("ORW-129 - a mend fades a mistaken grievance but leaves a trace", () => {
  it("after a mend the grievance is much weaker than before and strictly above zero", () => {
    const s = board();
    const before = Math.abs(mannerLeanOf(mannerForVote(s, ctx, fp(), JA, FIN)));
    const after = Math.abs(mannerLeanOf(mannerForVote(s, ctx, fp("mend"), JA, FIN)));
    expect(after, "a trace remains").toBeGreaterThan(0);
    expect(after, "much weaker").toBeLessThan(before * 0.3);
    expect(after).toBeCloseTo(before * MEND_TRACE.residual, 9);
  });
  it("it still shapes the decision slightly: the mended juror leans warmer than the unmended one but cooler than a juror who never held the grievance", () => {
    const s = board();
    const unmended = juryLean(rel, mannerForVote(s, ctx, fp(), JA, FIN));
    const mended = juryLean(rel, mannerForVote(s, ctx, fp("mend"), JA, FIN));
    const never = juryLean(rel, {});
    expect(mended).toBeGreaterThan(unmended);
    expect(mended, "the lingering doubt still costs the finalist a little").toBeLessThan(never);
  });
  it("a TRUE grievance is not touched by a mend", () => {
    const s = board();
    expect(mannerForVote(s, ctx, fp("mend"), JB, FIN)).toEqual({ betrayed: true, intensity: 1 });
  });
  it("the mistaken flag is cleared (the juror no longer holds a wrong belief) and the read is deterministic", () => {
    const s = board();
    const a = mannerForVote(s, ctx, fp("mend"), JA, FIN);
    expect(a.mistaken).toBeUndefined();
    expect(mannerForVote(s, ctx, fp("mend"), JA, FIN)).toEqual(a);
  });
  it("a mend is idempotent: repeating the read never drives the trace to zero or negative", () => {
    const s = board();
    const once = mannerLeanOf(mannerForVote(s, ctx, fp("mend"), JA, FIN));
    const twice = mannerLeanOf(mannerForVote(s, ctx, fp("mend"), JA, FIN));
    expect(twice).toBe(once);
    expect(once).toBeLessThan(0);
  });
  it("the residual is a single named constant between 0 and 1 (exclusive)", () => {
    expect(MEND_TRACE.residual).toBeGreaterThan(0);
    expect(MEND_TRACE.residual).toBeLessThan(0.5);
  });
});
