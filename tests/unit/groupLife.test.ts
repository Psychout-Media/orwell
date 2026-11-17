import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { AllianceStore } from "../../src/engine/alliances";
import { GROUP_LIFE, assignRoles, innerCircle, purposeAt, cutOrderOf, agreedTarget, collision, type MemberRead } from "../../src/engine/groupLife";

/** 0172 - the pure parts of group life, and the store's history extensions. Roles only (member, outsider). */
const read = (id: string, o: Partial<MemberRead> = {}): MemberRead => ({ id, stats: { physical: 0.5, mental: 0.5, social: 0.5 }, inner: 0.5, weakest: 0.5, outside: 0.5, hub: false, broker: false, ...o });
const flat = (): number => 0.5;
const roll = (): number => 0.5;

describe("roles", () => {
  it("every member holds a role, and with six or fewer members no role is held twice", () => {
    for (const n of [3, 4, 5, 6]) {
      const reads = Array.from({ length: n }, (_, i) => read(`m${i}`));
      const roles = assignRoles(reads, flat, roll);
      expect(Object.keys(roles)).toHaveLength(n);
      expect(new Set(Object.values(roles)).size).toBe(n);
    }
  });
  it("a bigger alliance fills the six roles and the rest are glue", () => {
    const roles = assignRoles(Array.from({ length: 8 }, (_, i) => read(`m${i}`)), flat, roll);
    expect(new Set(Object.values(roles)).size).toBe(6);
    expect(Object.values(roles).filter((r) => r === "glue").length).toBe(3);
  });
  it("the role goes to the member the score favours; a member who keeps a role keeps it", () => {
    const reads = [read("a"), read("b", { stats: { physical: 0.2, mental: 0.95, social: 0.5 } }), read("c")];
    expect(assignRoles(reads, flat, roll)["b"]).toBe("strategist");
    expect(assignRoles(reads, flat, roll, { c: "strategist" })["c"]).toBe("strategist");
  });
  it("is deterministic and order-independent", () => {
    const reads = Array.from({ length: 5 }, (_, i) => read(`m${i}`));
    expect(assignRoles([...reads].reverse(), flat, roll)).toEqual(assignRoles(reads, flat, roll));
  });
});

describe("inner circle", () => {
  const tie = (close: string[]) => (a: string, b: string): number => (close.includes(a) && close.includes(b) ? 0.95 : 0.5);
  it("three members closer to each other than to the rest nest as an inner circle", () => {
    expect(innerCircle(["a", "b", "c", "d", "e"], tie(["b", "c", "e"]))).toEqual(["b", "c", "e"]);
  });
  it("no circle when nobody stands out, or the alliance is too small", () => {
    expect(innerCircle(["a", "b", "c", "d"], flat)).toBeUndefined();
    expect(innerCircle(["a", "b", "c"], tie(["a", "b", "c"]))).toBeUndefined();
  });
});

describe("purpose, cut orders and collision", () => {
  it("the purpose shifts with how much of the cast is left", () => {
    expect([16, 9, 4].map((n) => purposeAt(n, 16))).toEqual(["survival", "power", "endgame"]);
  });
  it("members are off the cut order in survival and on it later; the worst for my game goes first", () => {
    const r = (o: string) => ({ threat: o === "x" ? 0.9 : 0.1, comp: 0.3, tie: o === "m2" ? 0.9 : 0.2 });
    expect(cutOrderOf("m1", ["m1", "m2", "x", "y"], ["m1", "m2"], "survival", r)).toEqual(["x", "y"]);
    expect(cutOrderOf("m1", ["m1", "m2", "x", "y"], ["m1", "m2"], "endgame", r)[0]).toBe("x");
  });
  it("the majority agrees the outsider most orders name; a collision needs the purpose to have moved on", () => {
    const orders = { a: ["x", "b"], b: ["x", "y"], c: ["b", "x"] };
    expect(agreedTarget(orders, ["a", "b", "c"])).toBe("x");
    expect(collision(orders, ["a", "b", "c"], "survival")).toBeUndefined();
    expect(collision(orders, ["a", "b", "c"], "power")).toEqual({ cut: "b", cutters: ["c"] });
  });
});

describe("the history extensions", () => {
  it("a crack keeps the whole record and founds the breakaway; one leaver just leaves", () => {
    const s = new AllianceStore();
    const a = s.add("Stock", "a", ["a", "b", "c", "d"], 1);
    const born = s.crack(a.id, ["a", "c"], "Offshoot", 2)!;
    expect(born.members).toEqual(["a", "c"]);
    expect(s.byId(a.id)!.members).toEqual(["b", "d"]);
    expect(s.history().map((e) => e.kind)).toEqual(["formed", "cracked", "left", "left", "formed"]);
    expect(s.crack(a.id, ["b"], "Solo", 3)).toBeUndefined();
    expect(s.byId(a.id)).toBeUndefined(); // fell under two: dissolved, not deleted from the history
    expect(s.history().some((e) => e.kind === "dissolved" && e.allianceId === a.id)).toBe(true);
  });
  it("a pitch is withdrawn once, and never from a member", () => {
    const s = new AllianceStore();
    const a = s.add("Stock", "a", ["a", "b"], 1);
    s.reveal(a.id, PLAYER, ["a", "b"]);
    expect(s.byId(a.id)!.toldRoster).toEqual(["a", "b"]);
    expect(s.withdrawPitch(a.id, PLAYER)).toBe(true);
    expect(s.withdrawPitch(a.id, PLAYER)).toBe(false);
    expect(s.pitchesFor(PLAYER)).toHaveLength(0);
    expect(s.history().at(-1)!.kind).toBe("pitch-withdrawn");
  });
  it("annotate appends a hidden entry for a live or an ended alliance and refuses a stranger", () => {
    const s = new AllianceStore();
    const a = s.add("Stock", "a", ["a", "b"], 1);
    expect(s.annotate(a.id, "roles", { detail: "a=leader" })).toBe(true);
    expect(s.annotate("alliance:99", "roles")).toBe(false);
  });
});

describe("the live pass", () => {
  function world(flag: boolean) {
    const sb = new GameSessionRegistry().sandboxFor(`grouplife-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 5 });
    sb.session.setGroupRolesEnabled(flag);
    sb.session.noteMessage({ messageId: "m" });
    const p = sb.session as unknown as { alliances: AllianceStore; live: { dayNumber?: number; week: number; groupLife?: unknown; groupLifeDay?: number }; groupLifeTick(): void };
    const ids = sb.session.livingIds().filter((i) => i !== PLAYER);
    p.alliances.add("Stock", ids[0]!, ids.slice(0, 4), 1);
    return { p, ids, s: sb.session };
  }
  it("runs once per in-game day, and not at all with the switch off", () => {
    const on = world(true);
    on.p.live.dayNumber = 3; on.p.groupLifeTick();
    const first = JSON.stringify(on.p.live.groupLife);
    on.p.groupLifeTick();
    expect(JSON.stringify(on.p.live.groupLife)).toBe(first);
    expect(on.p.alliances.history().some((e) => e.kind === "roles")).toBe(true);
    const off = world(false);
    off.p.live.dayNumber = 3; off.p.groupLifeTick();
    expect(off.p.live.groupLife).toBeUndefined();
  });
  it("never touches an alliance the player belongs to", () => {
    const w = world(true);
    w.p.alliances.add("Mine", PLAYER, [PLAYER, w.ids[5]!, w.ids[6]!], 1);
    w.p.live.dayNumber = 3; w.p.groupLifeTick();
    const ids = Object.keys(w.p.live.groupLife as object);
    expect(ids).toHaveLength(1);
    expect(w.p.alliances.all().find((a) => a.name === "Mine")!.members).toEqual([PLAYER, w.ids[5]!, w.ids[6]!]);
  });
  it("with the switch off, a pitch shows the live roster as before", () => {
    const w = world(false);
    const a = w.p.alliances.all()[0]!;
    w.p.alliances.reveal(a.id, PLAYER);
    w.p.alliances.join(a.id, w.ids[6]!);
    expect(w.s.gameStatus().alliancePitches![0]!.members).toHaveLength(5);
    expect(GROUP_LIFE.cutDepth).toBeGreaterThan(0);
  });
});
