import { describe, it, expect } from "vitest";
import { buildSandbox } from "../support/sandbox";
import { spreadBetween, SPIN, LIE_COST, type SpreadDeps } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";

/**
 * B34 - a SHARE can arrive spun or as a lie, decided by the engine and bounded: cunning below the spin line => truthful; a spin lowers confidence and adds distortion; a lie (cunning reaching the lie
 * line) is recorded as "lied" in the told ledger, arrives with strong distortion/low confidence, and there is NO hard cap (card 24): repeated lying costs credibility (LIE_COST). Content is never authored.
 * Roles only.
 */
const H = npc(1), L = npc(2);
function run(cunning: number, seed: number, told = new ToldLedger(), factId = "f1") {
  const sb = buildSandbox(7);
  const k = sb.engine.knowledge;
  k.seedBelief(H, { content: `fact ${factId}`, originalContent: `fact ${factId}`, factId, confidence: 1, hops: 0, distortion: 0, source: H }, "origin");
  const deps: SpreadDeps = {
    knowledge: k, told, rngFor: () => new SeededRandom(seed),
    trust: () => 0.95, affinity: () => 0.95, threat: () => 0, style: () => "strategic", volatility: () => 0.1, audienceOf: () => 0,
    cunning: () => cunning,
  };
  const r = spreadBetween(H, L, deps)[0]!;
  const got = k.knownTo(L).find((f) => (f.factId ?? f.id) === factId);
  return { r, got, told };
}
/** The first seed (from `from`) where the holder deliberately SHARES. */
const sharingSeed = (cunning: number, from = 1): number => {
  for (let s = from; s < 400; s++) { const x = run(cunning, s); if (x.r.transmitted && x.r.decision !== "slipped") return s; }
  throw new Error("no sharing seed");
};

describe("spin on a share", () => {
  it("low cunning: truthful - full decayed confidence, no extra distortion", () => {
    const { got } = run(0.2, sharingSeed(0.2));
    expect(got!.distortion ?? 0).toBe(0);
  });
  it("spin-level cunning: arrives with less confidence and some distortion than a truthful one", () => {
    const seed = sharingSeed(0.6);
    const spun = run(0.6, seed).got!, truthful = run(0.2, seed).got!;
    expect(spun.confidence!).toBeCloseTo(truthful.confidence! * SPIN.spunConfidence, 9);
    expect(spun.distortion!).toBeCloseTo(SPIN.spunDistortion, 9);
  });
  it("lie-level cunning: recorded as lied, strong distortion, low confidence", () => {
    const seed = sharingSeed(0.9);
    const x = run(0.9, seed);
    expect(x.r.decision).toBe("lied");
    expect(x.told.outcome(H, "f1", L)).toBe("lied");
    expect(x.got!.distortion!).toBeCloseTo(SPIN.lieDistortion, 9);
    expect(x.got!.confidence!).toBeLessThan(run(0.2, seed).got!.confidence!);
  });
  it("no hard cap on lying: a repeat liar still lies, but each prior lie makes the next land weaker (credibility cost), floored", () => {
    const seed = sharingSeed(0.9);
    const fresh = run(0.9, seed).got!.confidence!;
    const told = new ToldLedger();
    for (let i = 0; i < 10; i++) told.record(H, `old${i}`, npc(9), "lied"); // ten prior lies, to OTHER listeners
    const x = run(0.9, seed, told);
    expect(x.r.decision, "still a lie - no cap").toBe("lied");
    expect(x.got!.distortion!).toBeCloseTo(SPIN.lieDistortion, 9);
    expect(x.got!.confidence!).toBeCloseTo(fresh * Math.pow(LIE_COST.perPriorLie, 10), 9);
  });
  it("repeating to the SAME ear costs more than the same number of lies to strangers", () => {
    const seed = sharingSeed(0.9);
    const other = new ToldLedger(), same = new ToldLedger();
    for (let i = 0; i < 3; i++) { other.record(H, `o${i}`, npc(9), "lied"); same.record(H, `o${i}`, L, "lied"); }
    expect(run(0.9, seed, same).got!.confidence!).toBeLessThan(run(0.9, seed, other).got!.confidence!);
  });
  it("the cost never drops below the floor, and only the technical safety valve demotes a lie to a spin", () => {
    const seed = sharingSeed(0.9);
    const heavy = new ToldLedger();
    for (let i = 0; i < 200; i++) heavy.record(H, `h${i}`, npc(9), "lied");
    const fresh = run(0.9, seed).got!.confidence!;
    expect(run(0.9, seed, heavy).got!.confidence!).toBeCloseTo(fresh * LIE_COST.floor, 9);
    const valve = new ToldLedger();
    for (let i = 0; i < LIE_COST.safetyValve; i++) valve.record(H, `v${i}`, npc(9), "lied");
    expect(run(0.9, seed, valve).r.decision).toBe("shared");
  });
  it("a hold or a slip is never spun (nothing to spin)", () => {
    for (let s = 1; s < 400; s++) {
      const x = run(0.9, s);
      if (x.r.decision === "slipped") { expect(x.got!.distortion ?? 0).toBe(0); return; }
    }
    throw new Error("no slip");
  });
  it("is deterministic and counts lies per holder from the ledger", () => {
    const seed = sharingSeed(0.9);
    expect(run(0.9, seed).r).toEqual(run(0.9, seed).r);
    expect(run(0.9, seed).told.count(H, "lied")).toBe(1);
  });
});
