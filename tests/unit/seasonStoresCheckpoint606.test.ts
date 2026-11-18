import { describe, it, expect } from "vitest";
import { sessionCoreSupersetViolation, type SessionSnapshot } from "../../src/engine/sessionSnapshot";

/** ORW-606 - the season-long Theme 3 stores (bonds, grudges, group identity) sit inside the fail-closed "nothing was lost" check. Roles only. */
const snap = (live: Record<string, unknown>): SessionSnapshot => ({ live } as unknown as SessionSnapshot);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const bond = { warmth: 0.4, debt: 0, resentment: 0.1, strain: 0, history: 3, romance: 0, peakResentment: 0.2, commitment: "none" };
const grudge = { kind: "lied-to", week: 2, day: 9, severity: 0.4, peak: 0.5, eased: 0.1, refKey: "k" };

describe("ORW-606 season stores in the save check", () => {
  const earlier = snap({
    bonds: { "npc:a|npc:b": bond },
    grudges: { "npc:a|npc:b": grudge },
    groupIdentity: { "npc:a|npc:b": { kind: "debrief", since: 1 } },
  });
  it("an unchanged or deepened save passes", () => {
    expect(sessionCoreSupersetViolation(earlier, earlier)).toBeNull();
    const later = clone(earlier.live as Record<string, any>);
    later.bonds["npc:a|npc:b"].history = 4; later.grudges["npc:a|npc:b"].eased = 0.2;
    later.grudges["npc:c|npc:d"] = grudge;
    expect(sessionCoreSupersetViolation(snap(later), earlier)).toBeNull();
  });
  it("a lost or thinned bond, grudge or group is named", () => {
    const l = (f: (x: any) => void): SessionSnapshot => { const c = clone(earlier.live as Record<string, any>); f(c); return snap(c); };
    expect(sessionCoreSupersetViolation(l((c) => delete c.bonds["npc:a|npc:b"]), earlier)).toBe("bonds");
    expect(sessionCoreSupersetViolation(l((c) => { c.bonds["npc:a|npc:b"].history = 2; }), earlier)).toBe("bonds");
    expect(sessionCoreSupersetViolation(l((c) => delete c.grudges["npc:a|npc:b"]), earlier)).toBe("grudges");
    expect(sessionCoreSupersetViolation(l((c) => { c.grudges["npc:a|npc:b"].peak = 0.1; }), earlier)).toBe("grudges");
    expect(sessionCoreSupersetViolation(l((c) => delete c.groupIdentity["npc:a|npc:b"]), earlier)).toBe("groupIdentity");
  });
});
