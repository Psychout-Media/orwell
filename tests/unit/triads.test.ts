import { describe, it, expect } from "vitest";
import { commonFriendNudges, kingmakerOf, priceTier, sharedEnemyNudges, strainedTriads, swingRead, type TriadView } from "../../src/engine/triads";
import { SWING } from "../../src/engine/triadsConstants";

/** Feature 0174 - the pure rules. Roles only (ids are opaque). */
const view = (living: string[], enemies: Record<string, string[]>, friends: Record<string, string[]>, ties: Record<string, number> = {}): TriadView => ({
  living, enemiesOf: (h) => enemies[h] ?? [], friendsOf: (h) => friends[h] ?? [], tie: (a, b) => ties[[a, b].sort().join("|")] ?? 0,
});

describe("structural balance", () => {
  it("two holders who share an enemy are a nudge pair; two who are enemies of each other are not", () => {
    const v = view(["a", "b", "c", "d"], { a: ["e1"], b: ["e1"], c: ["e1", "a"], d: [] }, {});
    const pairs = sharedEnemyNudges(v).map((n) => `${n.a}|${n.b}`);
    expect(pairs).toContain("a|b");
    expect(pairs).toContain("b|c");
    expect(pairs).not.toContain("a|c"); // c holds a as an enemy
  });
  it("two friends of one person who barely know each other drift; ones who are close or enemies do not", () => {
    const v = view(["p", "a", "b", "c"], { a: ["c"] }, { p: ["a", "b", "c"] }, { "a|b": 0.1, "a|c": 0.05, "b|c": 0.5 });
    const pairs = commonFriendNudges(v).map((n) => `${n.a}|${n.b}`);
    expect(pairs).toEqual(["a|b"]);
  });
  it("an unbalanced triad names the center and the friend they like less", () => {
    const v = view(["p", "a", "b"], { a: ["b"] }, { p: ["a", "b"] });
    expect(strainedTriads(v, (_c, o) => (o === "a" ? 0.9 : 0.4))).toEqual([{ center: "p", weaker: "b", other: "a" }]);
    expect(strainedTriads(view(["p", "a", "b"], {}, { p: ["a", "b"] }), () => 1)).toEqual([]);
  });
  it("the output does not depend on input order", () => {
    const a = view(["a", "b", "c"], { a: ["z"], b: ["z"], c: ["z"] }, {});
    const b = view(["c", "b", "a"], { c: ["z"], b: ["z"], a: ["z"] }, {});
    expect(sharedEnemyNudges(a)).toEqual(sharedEnemyNudges(b));
  });
});

describe("swing reads", () => {
  const nominees = ["x", "y"] as const;
  const pv = (rows: Array<[string, string, number]>) => rows.map(([voter, pick, gap]) => ({ voter, pick, gap }));
  it("a vote the others leave close names the softest ballots on the leading side", () => {
    const r = swingRead(pv([["a", "x", 0.9], ["b", "x", 0.1], ["c", "x", 0.5], ["d", "y", 0.8], ["e", "y", 0.2]]), nominees, false);
    expect(r.swings).toEqual(["b", "c"].slice(0, SWING.maxCourted));
    expect(r.playerSwing).toBe(false);
  });
  it("a lopsided vote has no swing", () => {
    expect(swingRead(pv([["a", "x", 0.1], ["b", "x", 0.1], ["c", "x", 0.1], ["d", "x", 0.1], ["e", "y", 0.1]]), nominees, true)).toEqual({ swings: [], playerSwing: false });
  });
  it("the player is a possible swing only when they vote and the others leave it within one", () => {
    const even = pv([["a", "x", 0.5], ["b", "y", 0.5]]);
    expect(swingRead(even, nominees, true).playerSwing).toBe(true);
    expect(swingRead(even, nominees, false).playerSwing).toBe(false);
    expect(swingRead(pv([["a", "x", 0.5], ["b", "x", 0.5], ["c", "y", 0.5], ["d", "x", 0.5]]), nominees, true).playerSwing).toBe(false);
  });
  it("a tie among the others courts the softest ballots on both sides", () => {
    const r = swingRead(pv([["a", "x", 0.9], ["b", "y", 0.05], ["c", "x", 0.4], ["d", "y", 0.6]]), nominees, false);
    expect(r.swings).toEqual(["b", "c"]);
  });
});

describe("kingmaker and price", () => {
  it("a close win names the softest winning ballot, a tie names the HOH, a rout names no one", () => {
    const voteOf = { a: "x", b: "x", c: "x", d: "y", e: "y" };
    expect(kingmakerOf(voteOf, "x", (v) => ({ a: 0.9, b: 0.1, c: 0.5 } as Record<string, number>)[v], "h")).toBe("b");
    expect(kingmakerOf({ a: "x", b: "y" }, "x", () => 0, "h")).toBe("h");
    expect(kingmakerOf({ a: "x", b: "x", c: "x", d: "x", e: "y" }, "x", () => 0, "h")).toBeUndefined();
  });
  it("the price tier rises with each rival bidder and is capped", () => {
    expect(priceTier(0)).toBe(1);
    expect(priceTier(1)).toBeGreaterThan(priceTier(0));
    expect(priceTier(99)).toBe(SWING.priceCap);
  });
});
