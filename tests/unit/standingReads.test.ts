import { describe, it, expect } from "vitest";
import { pitchTilt, type Pitch } from "../../src/engine/lobbying";
import { nominationTermVals, nominationPlan, NOMINATION_TERM_NAMES } from "../../src/engine/season";
import { HOH_COURT } from "../../src/engine/hohCourt";
import { RelationshipModel } from "../../src/engine/relationships";
import { npc } from "../../src/domain/ids";

/**
 * ORW-694 / bug scan B1-9 (Ryne 2026-11-26: "standing in the house should matter ... it would also create like a bigger target as a leader ... We can play with that a bit."). The hidden
 * pecking order (0173, `live.status`) was written every day and read only for a leader's power vacuum. Two first-pass reads, small weights in `HOH_COURT.standing`:
 *  (B) a leader's or lieutenant's pitch to the HOH carries more (a weight on the pitch, inside the existing bounded tilt);
 *  (C) the house's informal leader is a bigger nomination target (a named nomination term, `standing`, appended last).
 * Played games with the HOH court on only (the status exists nowhere else), so the headless calibration is untouched. Roles only.
 */
const HOH = npc(1), LEADER = npc(2), OTHER = npc(3), SUBJECT = npc(4);

describe("(B) a leader's pitch carries more", () => {
  const pitches: Pitch[] = [{ from: LEADER, targets: SUBJECT, kind: "info", strength: 1 } as Pitch];
  const same: Pitch[] = [{ from: OTHER, targets: SUBJECT, kind: "info", strength: 1 } as Pitch];
  it("weighted by the pitcher's standing; no weight is the old tilt exactly", () => {
    const cred = () => 0.6;
    expect(pitchTilt(SUBJECT, pitches, cred)).toBe(pitchTilt(SUBJECT, same, cred));
    const w = (p: string) => (p === LEADER ? HOH_COURT.standing.pitchWeight.leader : 1);
    expect(pitchTilt(SUBJECT, pitches, cred, w)).toBeGreaterThan(pitchTilt(SUBJECT, same, cred, w));
    expect(pitchTilt(SUBJECT, pitches, cred, w)).toBeCloseTo(pitchTilt(SUBJECT, pitches, cred) * HOH_COURT.standing.pitchWeight.leader, 10);
  });
  it("small weights: a leader above a lieutenant above everyone else, all modest", () => {
    const { leader, lieutenant } = HOH_COURT.standing.pitchWeight;
    expect(leader).toBeGreaterThan(lieutenant);
    expect(lieutenant).toBeGreaterThan(1);
    expect(leader).toBeLessThanOrEqual(1.5);
  });
});

describe("(C) the informal leader is a bigger nomination target", () => {
  const ids = [HOH, LEADER, OTHER, SUBJECT, npc(5), npc(6)];
  const rel = (): RelationshipModel => {
    const r = new RelationshipModel(0.5);
    for (const a of ids) for (const b of ids) if (a !== b) { const e = r.edge(a, b); e.trust = 0.5; e.affinity = 0.5; e.threat = 0.3; }
    return r;
  };
  it("is a named term, last; absent it is exactly zero and the plan is unchanged", () => {
    expect(NOMINATION_TERM_NAMES[NOMINATION_TERM_NAMES.length - 1]).toBe("standing");
    const r = rel();
    expect(nominationTermVals(HOH, LEADER, r, 0.5, [], { standingPush: () => 0 })).toEqual(nominationTermVals(HOH, LEADER, r, 0.5, [], {}));
    expect(nominationPlan(HOH, ids, r, { standingPush: () => 0 })).toEqual(nominationPlan(HOH, ids, r, {}));
  });
  it("the leader becomes the HOH's target over a slightly scarier houseguest once standing counts", () => {
    const r = rel();
    r.edge(HOH, OTHER).threat = 0.32; // a small gap above the field (0.3): the target on threat alone
    const push = (t: string) => (t === LEADER ? HOH_COURT.standing.leaderTargetPush : 0);
    expect(nominationPlan(HOH, ids, r, {}).target, "setup: on threat alone the scarier houseguest is the target").toBe(OTHER);
    expect(nominationPlan(HOH, ids, r, { standingPush: push }).target).toBe(LEADER);
  });
  it("a small push: well under a clear threat gap", () => {
    expect(HOH_COURT.standing.leaderTargetPush).toBeGreaterThan(0);
    expect(HOH_COURT.standing.leaderTargetPush).toBeLessThanOrEqual(0.1);
  });
});

describe("wired in the live house (played games, court on)", () => {
  it("the status the house derived weighs the leader's and lieutenants' pitches; court off or no status = no weight (byte-identical)", async () => {
    const { played } = await import("../../features/support/hohCourtHelpers");
    const on = played(13, true) as unknown as { session: Record<string, any> };
    const s = on.session;
    const living: string[] = s.livingIds().filter((x: string) => x !== "player");
    expect(s.standingPitchWeight(), "no status yet: no weight").toBeUndefined();
    s.live.status = { day: 1, tiers: {}, leader: living[0], lieutenants: [living[1]], count: 1, history: [] };
    const w = s.standingPitchWeight()!;
    expect(w(living[0])).toBe(HOH_COURT.standing.pitchWeight.leader);
    expect(w(living[1])).toBe(HOH_COURT.standing.pitchWeight.lieutenant);
    expect(w(living[2])).toBe(1);
    const off = played(13, false) as unknown as { session: Record<string, any> };
    off.session.live.status = s.live.status;
    expect(off.session.standingPitchWeight(), "court off: no weight").toBeUndefined();
  });
});
