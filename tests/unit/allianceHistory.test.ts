import { describe, it, expect } from "vitest";
import { AllianceStore } from "../../src/engine/alliances";
import { sessionCoreSupersetViolation, type SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { npc, PLAYER } from "../../src/domain/ids";

/** ORW-544 / 0161 - the alliance history is append-only, survives a save / load, and never lets an id be reused. Roles only. */
const A = npc(1), B = npc(2), C = npc(3);

describe("alliance history append", () => {
  it("records form, join, leave, betray, fade and dissolve, and keeps the ended roster", () => {
    const s = new AllianceStore();
    s.stamp(5, 2);
    const a = s.add("x", A, [A, B], 5);
    s.join(a.id, C);
    s.removeMember(a.id, C, "left");
    s.removeMember(a.id, B); // betrayal: down to one member, dissolves
    expect(s.all()).toHaveLength(0);
    expect(s.history().map((e) => e.kind)).toEqual(["formed", "joined", "left", "betrayed", "dissolved"]);
    expect(s.history().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(s.history()[4]!.members.sort()).toEqual([A, B]);
    expect(s.history()[0]).toMatchObject({ beat: 5, day: 2, playerKnew: false });
  });
  it("prune records each exit and the dissolve; fade records the ended alliance", () => {
    const s = new AllianceStore();
    const a = s.add("x", A, [A, B, C], 1);
    s.prune(new Set([A, B]));
    expect(s.byId(a.id)?.members).toEqual([A, B]);
    s.prune(new Set([A]));
    expect(s.all()).toHaveLength(0);
    expect(s.history().filter((e) => e.kind === "left").map((e) => e.who)).toEqual([C, B]);
    expect(s.history().at(-1)).toMatchObject({ kind: "dissolved", why: "evicted-out" });
    const f = new AllianceStore();
    f.add("y", A, [A, B], 1);
    for (let d = 1; d <= 3; d++) f.fade(d, () => 0, () => false);
    expect(f.all()).toHaveLength(0);
    expect(f.history().at(-1)).toMatchObject({ kind: "faded", why: "cohesion", members: [A, B] });
  });
  it("a pitched player makes the unrecorded entries known to the player; a recorded one is never rewritten", () => {
    const s = new AllianceStore();
    const a = s.add("x", A, [A, B], 1);
    expect(s.history()[0]!.playerKnew).toBe(false);
    s.reveal(a.id, PLAYER);
    expect(s.history()[0]!.playerKnew).toBe(true);
    s.markRecorded(1, "ev:1");
    s.markRecorded(1, "ev:2");
    expect(s.history()[0]!.eventId).toBe("ev:1");
    expect(s.unrecorded()).toHaveLength(0);
  });
});

describe("alliance history save / load", () => {
  it("round-trips whole and resumes ids after the highest id EVER used (a dissolved top id is not reused)", () => {
    const s = new AllianceStore();
    s.add("one", A, [A, B], 1);
    const two = s.add("two", A, [A, C], 1);
    s.removeMember(two.id, C); // alliance:2 dissolves
    const copy = new AllianceStore();
    copy.load(s.serialize(), s.serializeHistory());
    expect(copy.history()).toEqual(s.history());
    expect(copy.add("three", B, [B, C], 2).id).toBe("alliance:3");
    expect(copy.history().at(-1)!.seq).toBe(s.history().length + 1);
  });
  it("a save missing an earlier entry is a degradation; a longer one is not", () => {
    const s = new AllianceStore();
    const a = s.add("x", A, [A, B], 1);
    s.removeMember(a.id, B);
    const full = { allianceHistory: s.serializeHistory() } as unknown as SessionSnapshot;
    const thin = { allianceHistory: s.serializeHistory().slice(1) } as unknown as SessionSnapshot;
    expect(sessionCoreSupersetViolation(thin, full)).toBe("allianceHistory");
    expect(sessionCoreSupersetViolation(full, thin)).toBeNull();
    expect(sessionCoreSupersetViolation(full, full)).toBeNull();
  });
});
