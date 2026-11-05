import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { credibility, type CaughtLie } from "../../src/engine/credibility";
import { CREDIBILITY } from "../../src/engine/credibilityConstants";
import { spreadBetween, type SpreadDeps } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { buildSandbox } from "../support/sandbox";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";

/** B48 - credibility memory: pure, monotone, bounded, decaying, repetition-scaled, Vault-free, and wired in place of the B34 lie-cost stand-in. Roles only. */
const SPEAKER = npc(1), LISTENER = npc(2);
const lie = (week: number, severity = 1): CaughtLie => ({ speaker: SPEAKER, week, severity });

describe("credibility (pure)", () => {
  it("no caught lies and no repeats => fully believed", () => { expect(credibility([], 0, 5)).toBe(1); });
  it("is deterministic", () => { expect(credibility([lie(1), lie(2)], 2, 6)).toBe(credibility([lie(1), lie(2)], 2, 6)); });
  it("monotone: every additional caught lie lowers it, never raises it", () => {
    let prev = 1;
    for (let n = 1; n <= 12; n++) {
      const c = credibility(Array.from({ length: n }, () => lie(5)), 0, 5);
      expect(c).toBeLessThan(prev);
      prev = c;
    }
  });
  it("bounded: always within [floor, 1], even with a runaway pile", () => {
    const c = credibility(Array.from({ length: 400 }, () => lie(5)), 400, 5);
    expect(c).toBeGreaterThanOrEqual(CREDIBILITY.floor);
    expect(c).toBeLessThanOrEqual(1);
    expect(c).toBe(CREDIBILITY.floor);
  });
  it("no hard cap: the thirtieth caught lie still costs something (until the floor)", () => {
    expect(credibility(Array.from({ length: 4 }, () => lie(5)), 0, 5)).toBeLessThan(credibility(Array.from({ length: 3 }, () => lie(5)), 0, 5));
  });
  it("a caught lie decays with age (half-forgiven after the half-life) but is never fully erased", () => {
    const fresh = credibility([lie(10)], 0, 10), old = credibility([lie(10)], 0, 10 + CREDIBILITY.halfLifeWeeks), ancient = credibility([lie(10)], 0, 10 + 200);
    expect(fresh).toBeLessThan(old);
    expect(old).toBeLessThan(ancient);
    expect(ancient).toBeLessThan(1 + 1e-12);
    expect(1 - old).toBeCloseTo((1 - fresh) / 2, 9);
  });
  it("severity scales the cost; repeats to the same ear scale it further", () => {
    expect(credibility([lie(5, 0.3)], 0, 5)).toBeGreaterThan(credibility([lie(5, 1)], 0, 5));
    expect(credibility([], 3, 5)).toBeLessThan(credibility([], 1, 5));
    expect(credibility([], 1, 5)).toBeCloseTo(CREDIBILITY.perRepeatToListener, 9);
  });
  it("is pure: the module imports no store, port, clock or randomness (import-pin)", () => {
    const src = readFileSync("src/engine/credibility.ts", "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../domain/ids", "./credibilityConstants"]);
    expect(src).not.toMatch(/Math\.random|Date\.now|VaultStore|process\.env/);
  });
});

describe("credibility wired into the co-presence spread", () => {
  function run(credibilityOf: SpreadDeps["credibilityOf"], seed: number) {
    const sb = buildSandbox(7); const k = sb.engine.knowledge;
    k.seedBelief(SPEAKER, { content: "a fact", originalContent: "a fact", factId: "f1", confidence: 1, hops: 0, distortion: 0, source: SPEAKER }, "origin");
    const deps: SpreadDeps = {
      knowledge: k, told: new ToldLedger(), rngFor: () => new SeededRandom(seed), trust: () => 0.95, affinity: () => 0.95, threat: () => 0, style: () => "strategic", volatility: () => 0.1,
      audienceOf: () => 0, cunning: () => 0.9, ...(credibilityOf ? { credibilityOf } : {}),
    };
    const r = spreadBetween(SPEAKER, LISTENER, deps)[0]!;
    return { r, got: k.knownTo(LISTENER).find((f) => (f.factId ?? f.id) === "f1") };
  }
  const lyingSeed = (): number => { for (let s = 1; s < 400; s++) if (run(undefined, s).r.decision === "lied") return s; throw new Error("no lying seed"); };
  it("a lie lands weaker in proportion to how little the listener believes the liar; a trusted liar's lie is not discounted", () => {
    const seed = lyingSeed();
    const trusted = run(() => 1, seed).got!.confidence!, doubted = run(() => 0.4, seed).got!.confidence!;
    expect(doubted).toBeCloseTo(trusted * 0.4, 9);
  });
  it("with the dep absent the B34 stand-in applies (flag off is byte-identical to before)", () => {
    const seed = lyingSeed();
    expect(run(undefined, seed).got!.confidence!).toBeCloseTo(run(() => 1, seed).got!.confidence!, 9);
  });
  it("the dep receives (holder, listener, repeats-to-that-ear) and no lying means no cap: the lie still happens at any credibility", () => {
    const seed = lyingSeed(); const seen: Array<[string, string, number]> = [];
    const x = run((h, l, n) => { seen.push([h, l, n]); return CREDIBILITY.floor; }, seed);
    expect(x.r.decision).toBe("lied");
    expect(seen).toEqual([[SPEAKER, LISTENER, 0]]);
  });
});
