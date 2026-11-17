import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { AllianceStore } from "../../src/engine/alliances";
import { GROUP_LIFE, assignRoles, innerCircle, purposeAt, cutOrderOf, agreedTarget, collision, spyGap, spyTurn, bumpOnce, dominance, foldEvictions, threatenedBy, plannerOf, planClaim, type MemberRead } from "../../src/engine/groupLife";

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
  it("an alliance the player belongs to gets roles for its NPC members only, never a role or a cut order for the player", () => {
    const w = world(true);
    w.p.alliances.add("Mine", PLAYER, [PLAYER, w.ids[5]!, w.ids[6]!], 1);
    w.p.live.dayNumber = 3; w.p.groupLifeTick();
    const life = w.p.live.groupLife as Record<string, { roles: Record<string, string>; cutOrder?: Record<string, string[]>; agreed?: string }>;
    const mine = life[w.p.alliances.all().find((a) => a.name === "Mine")!.id]!;
    expect(Object.keys(mine.roles).sort()).toEqual([w.ids[5]!, w.ids[6]!].sort());
    expect(Object.values(mine.cutOrder ?? {}).flat()).not.toContain(PLAYER); // no member's goal is the player's exit
    expect(mine.agreed).not.toBe(PLAYER);
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

describe("a spy who turns loyal", () => {
  const read = (gap: number, candor: number, cunning: number) => ({ gap, candor, cunning });
  it("never turns while the bond to the one they work for is the stronger", () => {
    expect(spyGap([0.4, 0.5], 0.6)).toBeLessThan(0);
    for (const r of [0, 0.3, 0.99]) expect(spyTurn(read(-0.1, 1, 1), r, r)).toBe("stay");
    expect(spyTurn(read(0, 1, 1), 0, 0)).toBe("stay");
  });
  it("turns on a roll that grows with the margin, and the margin is bounded", () => {
    expect(spyTurn(read(0.1, 0.5, 0.5), 0.15, 0.99)).toBe("quiet");
    expect(spyTurn(read(0.1, 0.5, 0.5), 0.25, 0.99)).toBe("stay");
    expect(spyTurn(read(0.4, 0.5, 0.5), 0.45, 0.99)).toBe("quiet");
    expect(spyTurn(read(5, 0.5, 0.5), 0.61, 0.99)).toBe("stay"); // never above turnMax
  });
  it("the candid confess, the cunning and less candid double-cross, the rest just stop", () => {
    expect(spyTurn(read(0.5, 1, 0), 0, 0.1)).toBe("confess");
    expect(spyTurn(read(0.5, 0, 1), 0, 0.1)).toBe("double-cross");
    expect(spyTurn(read(0.5, 0, 0), 0, 0.1)).toBe("quiet");
    expect(spyTurn(read(0.5, 0.2, 0.2), 0, 0.99)).toBe("quiet");
  });
});

describe("the cut-order threat step is taken once per target", () => {
  it("a flip-flop back to a target already weighed takes no second step", () => {
    let b = bumpOnce(undefined, "x"); expect(b.bump).toBe(true);
    b = bumpOnce(b.bumped, "y"); expect(b.bump).toBe(true);
    b = bumpOnce(b.bumped, "x"); expect(b.bump).toBe(false);
    expect(b.bumped).toEqual(["x", "y"]);
  });
});

describe("one group dominates", () => {
  it("by the crown, by a voting majority of those left, or by two evictions carried in a row", () => {
    expect(dominance({ holdsCrown: true, members: 3, living: 12, won: [] })).toBe("crown");
    expect(dominance({ holdsCrown: false, members: 5, living: 9, won: [] })).toBe("majority");
    expect(dominance({ holdsCrown: false, members: 4, living: 8, won: [] })).toBeUndefined(); // exactly half is not a majority
    expect(dominance({ holdsCrown: false, members: 3, living: 12, won: [false, true, true] })).toBe("streak");
    expect(dominance({ holdsCrown: false, members: 3, living: 12, won: [true, false] })).toBeUndefined();
    expect(dominance({ holdsCrown: false, members: 3, living: 12, won: [true] })).toBeUndefined();
  });
  it("an eviction counts as carried when it was the group's agreed target; the last two are kept", () => {
    let f = foldEvictions(2, [], ["a", "b", "x"], "x"); expect(f).toEqual({ seen: 3, won: [true] });
    f = foldEvictions(f.seen, f.won, ["a", "b", "x", "y", "z"], "q"); expect(f).toEqual({ seen: 5, won: [false, false] });
    expect(foldEvictions(1, [], ["a"], "x")).toEqual({ seen: 1, won: [] });
  });
  it("those who feel threatened are the ones whose own read of the group is high, the most threatened first", () => {
    expect(threatenedBy([{ id: "a", threat: 0.1 }, { id: "c", threat: 0.5 }, { id: "b", threat: 0.5 }, { id: "d", threat: 0.9 }])).toEqual(["d", "b", "c"]);
  });
});

describe("a plan told as a claim", () => {
  const orders = { l: ["x", "y"], m: ["x", "z"], n: ["q", "x"] };
  const roles = { l: "leader", m: "glue", n: "swing" } as const;
  it("the planner is the leader when their own first cut is the target, else the member whose first cut it is", () => {
    expect(plannerOf("x", orders, roles, ["l", "m", "n"])).toBe("l");
    expect(plannerOf("x", orders, roles, ["l", "m", "n"], ["l"])).toBe("m");
    expect(plannerOf("q", orders, roles, ["l", "m", "n"])).toBe("n");
    expect(plannerOf("zz", orders, roles, ["l", "m", "n"])).toBe("l");
  });
  it("one claim: targets-you for the target, going-after for anyone else; true only for the agreed target; mislead when lying", () => {
    expect(planClaim({ speaker: "s", listener: "x", planner: "l", told: "x", agreed: "x", mislead: false })).toEqual({ speaker: "s", listener: "x", kind: "targets-you", subject: "l", isTrue: true, intent: "inform" });
    expect(planClaim({ speaker: "s", listener: "p", planner: "l", told: "x", agreed: "x", mislead: false })).toEqual({ speaker: "s", listener: "p", kind: "going-after", subject: "l", object: "x", isTrue: true, intent: "inform" });
    expect(planClaim({ speaker: "s", listener: "p", planner: "l", told: "w", agreed: "x", mislead: true })).toMatchObject({ kind: "going-after", object: "w", isTrue: false, intent: "mislead" });
    expect(planClaim({ speaker: "s", listener: "p", planner: undefined, told: "x", agreed: "x", mislead: false })).toBeUndefined();
    expect(planClaim({ speaker: "s", listener: "l", planner: "l", told: "x", agreed: "x", mislead: false })).toBeUndefined();
  });
});

describe("ORW-616: the player's alliance lives by the same rules (parity)", () => {
  type P = { alliances: AllianceStore; live: { dayNumber?: number; week: number; agendas?: Record<string, { goals: unknown[] }> }; rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } }; fadeAlliances(): void };
  function pair(seed: number, slotIsPlayer: boolean, flag = true) {
    const sb = new GameSessionRegistry().sandboxFor(`parity616-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    sb.session.setGroupRolesEnabled(flag);
    sb.session.noteMessage({ messageId: "m" });
    const p = sb.session as unknown as P;
    const ids = sb.session.livingIds().filter((i) => i !== PLAYER);
    const slot = slotIsPlayer ? PLAYER : ids[3]!;
    const set = (a: string, b: string, v: number, t = 0.1) => { const e = p.rel.edge(a, b); e.trust = v; e.affinity = v; e.threat = t; };
    for (const a of [ids[0]!, ids[1]!, slot]) for (const b of [ids[0]!, ids[1]!, slot]) if (a !== b) set(a, b, a === slot || b === slot ? 0.1 : 0.9);
    p.alliances.add("Pact", ids[0]!, [ids[0]!, ids[1]!, slot], 1);
    return { sb, p, ids, slot };
  }
  const goneOn = (seed: number, slotIsPlayer: boolean, flag = true): number => {
    const w = pair(seed, slotIsPlayer, flag);
    for (let d = 1; d <= 40; d++) {
      w.p.live.dayNumber = d; w.p.fadeAlliances();
      if (!w.p.alliances.all().some((a) => a.name === "Pact")) return d;
    }
    return -1;
  };
  it("the same alliance fades on the same day with the player in a slot as with an NPC there", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const npc = goneOn(seed, false), player = goneOn(seed, true);
      expect(npc).toBeGreaterThan(0);
      expect(player).toBe(npc);
    }
  });
  it("with group life off the player's pact still never fades silently", () => {
    expect(goneOn(1, true, false)).toBe(-1);
  });
  it("a member's hot goal against a fellow member breaks the alliance on the same keyed draw, whether that member is the player or an NPC", () => {
    const run = (seed: number, slotIsPlayer: boolean): number => {
      const w = pair(seed, slotIsPlayer);
      for (const a of w.p.alliances.all()) a.lowDays = 0;
      const holder = w.ids[0]!;
      w.p.live.agendas![holder]!.goals.push({ id: `${holder}:g`, owner: holder, horizon: "week", kind: "get-them-out", target: w.slot, why: [{ kind: "character", weight: 1 }], test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: 1 });
      for (let d = 1; d <= 400; d++) {
        w.p.live.dayNumber = d;
        for (const a of w.p.alliances.all()) { a.lowDays = 0; a.checkedDay = d; }
        w.p.fadeAlliances();
        if (!w.p.alliances.byId("alliance:1")?.members.includes(holder)) return d;
      }
      return -1;
    };
    for (const seed of [1, 2, 3]) { const n = run(seed, false); expect(n).toBeGreaterThan(0); expect(run(seed, true)).toBe(n); }
  });
});
