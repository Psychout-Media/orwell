import { describe, it, expect } from "vitest";
import { DESIRE, desireFor, urgency, mostUrgent } from "../../src/engine/desireClock";

/** A8: the desire clock. Pure, monotone, hours-keyed, role-aware. Roles only. */
const base = { desire: "campaign" as const, drive: 0.5, hoursSinceApproach: undefined };
describe("desireFor", () => {
  it("the HOH never approaches (they are approached)", () => {
    for (const m of ["nominations", "veto-competition", "eviction", "hoh-competition"] as const) expect(desireFor(m, { isHoh: true, isNominee: false })).toBeNull();
  });
  it("campaign before nominations; plea for a nominee before the veto/vote; probe for the rest; check-in otherwise", () => {
    expect(desireFor("nominations", { isHoh: false, isNominee: false })).toBe("campaign");
    expect(desireFor("veto-ceremony", { isHoh: false, isNominee: true })).toBe("plea");
    expect(desireFor("eviction", { isHoh: false, isNominee: true })).toBe("plea");
    expect(desireFor("eviction", { isHoh: false, isNominee: false })).toBe("probe");
    expect(desireFor("hoh-competition", { isHoh: false, isNominee: false })).toBe("check-in");
    expect(desireFor(undefined, { isHoh: false, isNominee: false })).toBe("check-in");
  });
});
describe("urgency", () => {
  it("rises monotonically as the event nears", () => {
    const u = [6, 4, 2, 1, 0].map((h) => urgency({ ...base, hoursUntil: h }));
    for (let i = 1; i < u.length; i++) expect(u[i]!).toBeGreaterThan(u[i - 1]!);
  });
  it("is flat at the baseline beyond the horizon or with nothing scheduled", () => {
    expect(urgency({ ...base, hoursUntil: 99 })).toBeCloseTo(urgency({ ...base, hoursUntil: null }), 12);
  });
  it("a plea is more urgent than a campaign, which beats a probe, which beats a check-in (same drive/time)", () => {
    const at = (desire: "plea" | "campaign" | "probe" | "check-in") => urgency({ ...base, desire, hoursUntil: 1 });
    expect(at("plea")).toBeGreaterThan(at("campaign")); expect(at("campaign")).toBeGreaterThan(at("probe")); expect(at("probe")).toBeGreaterThan(at("check-in"));
  });
  it("stronger ties approach more", () => {
    expect(urgency({ ...base, hoursUntil: 2, drive: 0.9 })).toBeGreaterThan(urgency({ ...base, hoursUntil: 2, drive: 0.2 }));
  });
  it("an approach spends the urge, and it rebuilds over the cooldown (hours-keyed)", () => {
    const fresh = urgency({ ...base, hoursUntil: 1, hoursSinceApproach: 0 });
    const mid = urgency({ ...base, hoursUntil: 1, hoursSinceApproach: DESIRE.cooldownHours / 2 });
    const full = urgency({ ...base, hoursUntil: 1, hoursSinceApproach: DESIRE.cooldownHours });
    expect(fresh).toBe(0); expect(mid).toBeGreaterThan(fresh); expect(full).toBeGreaterThan(mid);
    expect(full).toBeCloseTo(urgency({ ...base, hoursUntil: 1, hoursSinceApproach: undefined }), 12);
  });
});
describe("mostUrgent", () => {
  const c = (npc: string, drive: number, since?: number) => ({ npc, desire: "campaign" as const, drive, hoursSinceApproach: since });
  it("null when nobody is over the threshold (far from the event, weak ties)", () => {
    expect(mostUrgent([c("a", 0.3), c("b", 0.3)], 20)).toBeNull();
  });
  it("picks the most urgent over the threshold; rested beats just-approached; ties break on id", () => {
    expect(mostUrgent([c("a", 0.5), c("b", 0.9)], 0.5)?.npc).toBe("b");
    expect(mostUrgent([c("a", 0.9, 0), c("b", 0.5)], 0.5)?.npc).toBe("b");
    expect(mostUrgent([c("b", 0.7), c("a", 0.7)], 0.5)?.npc).toBe("a");
  });
  it("is pure: same input, same answer", () => {
    const cs = [c("a", 0.6), c("b", 0.8)];
    expect(mostUrgent(cs, 1)).toEqual(mostUrgent(cs, 1));
  });
});
