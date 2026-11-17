import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { counterStreamKey, negotiate, weighCounter, type CounterSide } from "../../src/engine/favorCounters";
import { FAVOR } from "../../src/engine/favorConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";

/** 0171: counters (pure). Roles only. */
const side = (id: string, goalTarget: string | undefined, goalPull: number, protects: string[] = [], bond = 0.5): CounterSide =>
  ({ id, ...(goalTarget ? { goalTarget } : {}), goalPull, bond, pullOn: (t) => (protects.includes(t) ? -0.5 : 0.3) });
const rollsFor = (seed: number) => (round: number) => { const g = new SeededRandom(hashSeed(counterStreamKey(seed, "deal:1", 1, round))); return { counter: g.next(), settle: g.next() }; };

describe("weighCounter", () => {
  it("a goal-driven houseguest asks for the rival they want gone, and a houseguest with no goal never counters", () => {
    const r = weighCounter({ round: 1, side: side("a", "rival", 0.8), rolls: { counter: 0, settle: 0 } });
    expect(r).toEqual({ round: 1, by: "a", verdict: "counter", ask: { kind: "target", target: "rival" } });
    for (let c = 0; c < 1; c += 0.1) expect(weighCounter({ round: 1, side: side("a", undefined, 0), rolls: { counter: c, settle: 0 } }).verdict).not.toBe("counter");
    expect(weighCounter({ round: 1, side: side("a", "rival", FAVOR.askFloor), rolls: { counter: 0, settle: 0 } }).verdict).not.toBe("counter");
  });
  it("a stronger goal counters more often (the ask is goal-driven)", () => {
    const share = (pull: number) => { let n = 0; for (let i = 0; i < 400; i++) { const g = new SeededRandom(i + 1); if (weighCounter({ round: 1, side: side("a", "r", pull), rolls: { counter: g.next(), settle: g.next() } }).verdict === "counter") n++; } return n / 400; };
    expect(share(0.9)).toBeGreaterThan(share(0.3));
  });
  it("never counters at or past the round cap", () => {
    for (let c = 0; c < 1; c += 0.05) expect(weighCounter({ round: FAVOR.maxCounterRounds, side: side("a", "r", 1), rolls: { counter: c, settle: 0.5 } }).verdict).not.toBe("counter");
  });
  it("concedes an ask for someone they would not mind putting up, and turns down one for someone they protect", () => {
    expect(weighCounter({ round: 2, side: side("a", undefined, 0), incoming: { kind: "target", target: "x" }, rolls: { counter: 1, settle: 1 } }).verdict).toBe("accept");
    expect(weighCounter({ round: 2, side: side("a", undefined, 0, ["x"]), incoming: { kind: "target", target: "x" }, rolls: { counter: 1, settle: 0 } }).verdict).toBe("refuse");
  });
  it("a bond makes a bare offer likelier to be taken", () => {
    const taken = (bond: number) => { let n = 0; for (let i = 0; i < 400; i++) if (weighCounter({ round: 1, side: side("a", undefined, 0, [], bond), rolls: { counter: 1, settle: new SeededRandom(i + 1).next() } }).verdict === "accept") n++; return n; };
    expect(taken(1)).toBeGreaterThan(taken(0));
  });
});

describe("protect counters", () => {
  it("a houseguest whose strongest goal is keeping someone safe asks for that, and concedes a protect ask for someone they do not want out", () => {
    const keeper: CounterSide = { ...side("a", undefined, 0), protectTarget: "friend", protectPull: 0.8 };
    expect(weighCounter({ round: 1, side: keeper, rolls: { counter: 0, settle: 0 } }).ask).toEqual({ kind: "protect", target: "friend" });
    expect(weighCounter({ round: 2, side: { ...side("b", undefined, 0), pullOn: () => -0.2 }, incoming: { kind: "protect", target: "x" }, rolls: { counter: 1, settle: 1 } }).verdict).toBe("accept");
    expect(weighCounter({ round: 2, side: { ...side("b", undefined, 0), pullOn: () => 0.5 }, incoming: { kind: "protect", target: "x" }, rolls: { counter: 1, settle: 1 } }).verdict).toBe("refuse");
  });
  it("asks the stronger goal first, and never asks the same target twice", () => {
    const both: CounterSide = { ...side("a", "rival", 0.5), protectTarget: "friend", protectPull: 0.9 };
    expect(weighCounter({ round: 1, side: both, rolls: { counter: 0, settle: 0 } }).ask).toEqual({ kind: "protect", target: "friend" });
    expect(weighCounter({ round: 2, side: both, asked: ["friend"], rolls: { counter: 0, settle: 0 } }).ask).toEqual({ kind: "target", target: "rival" });
  });
});

describe("negotiate", () => {
  it("trades several counters between two goal-driven sides and never passes the cap", () => {
    const n = negotiate(side("o", "b", 0.8, ["a"]), side("r", "a", 0.8, ["b"]), () => ({ counter: 0, settle: 0 }));
    expect(n.rounds.filter((r) => r.verdict === "counter").length).toBeGreaterThanOrEqual(2);
    expect(n.rounds.length).toBeLessThanOrEqual(FAVOR.maxCounterRounds);
    expect(n.rounds.at(-1)!.verdict).not.toBe("counter");
    expect(n.rounds.map((r) => r.round)).toEqual(n.rounds.map((_, i) => i + 1));
  });
  it("never asks for the same target twice", () => {
    for (let seed = 0; seed < 200; seed++) {
      const asks = negotiate(side("o", "b", 0.9, ["a"]), side("r", "a", 0.9, ["b"]), rollsFor(seed)).rounds.flatMap((r) => (r.ask?.kind === "target" ? [r.ask.target] : []));
      expect(new Set(asks).size).toBe(asks.length);
    }
  });
  it("is deterministic from the seeded stream and its key never names a shared stream", () => {
    const run = (seed: number) => JSON.stringify(negotiate(side("o", "b", 0.7, ["a"]), side("r", "a", 0.7, ["b"]), rollsFor(seed)));
    for (let seed = 0; seed < 50; seed++) expect(run(seed)).toBe(run(seed));
    expect(counterStreamKey(7, "deal:3", 2, 1)).toBe("7:favors:deal:3:2:1");
    expect(counterStreamKey(7, "deal:3", 2, 1)).not.toBe(counterStreamKey(7, "deal:3", 2, 2));
  });
});

describe("no short lists, no prompt text", () => {
  it("the new modules carry no example line, no sample list and no prompt text", () => {
    for (const f of ["favors", "favorCounters", "favorConstants"]) {
      const src = readFileSync(`src/engine/${f}.ts`, "utf8");
      expect(src).not.toMatch(/e\.g\.|for example|such as/i);
      expect(src).not.toMatch(/\[\s*"[^"]+"\s*,\s*"[^"]+"/); // no inline string list
    }
  });
});
