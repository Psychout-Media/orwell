import { describe, it, expect } from "vitest";
import { buildSandbox } from "../support/sandbox";
import { spreadBetween, spreadForScenes, type SpreadDeps } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";

/** B11 / B10 slice 3 - information moves only inside a co-present pair, one hop, decided once. Roles only. */
const H = npc(1), L = npc(2), OUT = npc(3);
function setup(o: { trust?: number; affinity?: number; seed?: number } = {}) {
  const sb = buildSandbox(7);
  const k = sb.engine.knowledge;
  k.seedBelief(H, { content: "a fact the holder owns", originalContent: "a fact the holder owns", factId: "f1", confidence: 1, hops: 0, distortion: 0, source: H }, "origin");
  const told = new ToldLedger();
  const deps: SpreadDeps = {
    knowledge: k, told,
    rngFor: (h, l) => new SeededRandom((o.seed ?? 3) + h.length * 31 + l.length),
    trust: () => o.trust ?? 0.9, affinity: () => o.affinity ?? 0.9, threat: () => 0,
    style: () => "emotional", volatility: () => 0.9, audienceOf: () => 0,
  };
  return { k, told, deps };
}
const holds = (k: ReturnType<typeof setup>["k"], who: typeof H, id = "f1") => k.knownTo(who).some((f) => (f.factId ?? f.id) === id);

describe("B10 S3 - copresence spread", () => {
  it("decides the fact exactly once per (holder, fact, listener)", () => {
    const { deps, told } = setup();
    const first = spreadBetween(H, L, deps);
    expect(first).toHaveLength(1);
    expect(told.decided(H, "f1", L)).toBe(true);
    expect(spreadBetween(H, L, deps)).toEqual([]);
  });
  it("a transmitted fact moves exactly one hop with decayed confidence and the teller as source", () => {
    // find a seed where the holder shares/slips
    for (let seed = 1; seed < 60; seed++) {
      const { k, deps } = setup({ seed });
      const r = spreadBetween(H, L, deps)[0]!;
      if (!r.transmitted) { expect(holds(k, L)).toBe(false); continue; }
      const got = k.knownTo(L).find((f) => (f.factId ?? f.id) === "f1")!;
      expect(got.hops).toBe(1);
      expect(got.source).toBe(H);
      expect(got.confidence!).toBeLessThan(1);
      return;
    }
    throw new Error("no seed in 1..59 produced a transmit - the decision is dead");
  });
  it("a hold transmits nothing and still counts as decided", () => {
    for (let seed = 1; seed < 200; seed++) {
      const { k, deps, told } = setup({ seed, trust: 0.05, affinity: 0.0 });
      const r = spreadBetween(H, L, deps)[0]!;
      if (r.decision === "held") {
        expect(r.transmitted).toBe(false);
        expect(holds(k, L)).toBe(false);
        expect(told.outcome(H, "f1", L)).toBe("held");
        return;
      }
    }
    throw new Error("no hold in 1..199");
  });
  it("never reaches someone outside the pair (no network hops, no cross-room spread)", () => {
    for (let seed = 1; seed < 40; seed++) {
      const { k, deps } = setup({ seed });
      spreadForScenes([[H, L]], deps);
      expect(holds(k, OUT)).toBe(false);
    }
  });
  it("is deterministic: same seed, same outcome", () => {
    const a = setup({ seed: 11 }), b = setup({ seed: 11 });
    expect(spreadBetween(H, L, a.deps)).toEqual(spreadBetween(H, L, b.deps));
  });
  it("works both directions of a pair and only decides facts the listener lacks", () => {
    const { k, deps } = setup();
    k.seedBelief(L, { content: "a fact the listener owns", originalContent: "a fact the listener owns", factId: "f2", confidence: 1, hops: 0, distortion: 0, source: L }, "origin");
    const out = spreadForScenes([[H, L]], deps);
    expect(out.map((x) => `${x.holder}>${x.listener}:${x.factId}`).sort()).toEqual([`${H}>${L}:f1`, `${L}>${H}:f2`].sort());
  });
});

describe("S19 - branch coverage: styleless holders, subjects, topK, slip decay", () => {
  const withFacts = (facts: Array<{ id: string; subject?: typeof H; first?: boolean }>, o: { seed?: number; style?: boolean } = {}) => {
    const sb = buildSandbox(7);
    const k = sb.engine.knowledge;
    for (const f of facts) {
      k.seedBelief(H, { content: `c-${f.id}`, originalContent: `c-${f.id}`, factId: f.id, confidence: 1, hops: 0, distortion: 0, source: f.first === false ? OUT : H, ...(f.subject ? { subject: f.subject } : {}) }, "origin");
    }
    const told = new ToldLedger();
    const deps: SpreadDeps = {
      knowledge: k, told, rngFor: () => new SeededRandom(o.seed ?? 5),
      trust: () => 0.9, affinity: () => 0.9, threat: () => 0.6,
      style: () => (o.style === false ? undefined : "strategic"), volatility: () => 0.2, audienceOf: () => 1,
    };
    return { k, told, deps };
  };
  it("a holder with no strategy style still decides (default leakiness/cunning) and records the outcome", () => {
    const { deps, told } = withFacts([{ id: "g1" }], { style: false });
    const r = spreadBetween(H, L, deps);
    expect(r).toHaveLength(1);
    expect(told.decided(H, "g1", L)).toBe(true);
  });
  it("facts about the holder themselves, about a third party and unsubjected facts all get a decision (risk classes), capped by topK", () => {
    const { deps } = withFacts([{ id: "s", subject: H }, { id: "t", subject: OUT }, { id: "u" }]);
    expect(spreadBetween(H, L, deps)).toHaveLength(2); // default topK = 2
    const again = withFacts([{ id: "s", subject: H }, { id: "t", subject: OUT }, { id: "u" }]);
    again.deps.topK = 3;
    expect(spreadBetween(H, L, again.deps)).toHaveLength(3);
    const one = withFacts([{ id: "s", subject: H }, { id: "t", subject: OUT }]);
    one.deps.topK = 1;
    expect(spreadBetween(H, L, one.deps)).toHaveLength(1);
  });
  it("a slipped fact arrives with LESS confidence than a shared one", () => {
    let shared: number | undefined, slipped: number | undefined;
    for (let seed = 1; seed < 400 && (shared === undefined || slipped === undefined); seed++) {
      const { k, deps } = withFacts([{ id: "g" }], { seed });
      const r = spreadBetween(H, L, deps)[0]!;
      if (!r.transmitted) continue;
      const c = k.knownTo(L).find((f) => (f.factId ?? f.id) === "g")!.confidence!;
      if (r.decision === "shared") shared = c; else if (r.decision === "slipped") slipped = c;
    }
    expect(shared, "a shared outcome occurs in 1..399").toBeDefined();
    if (slipped !== undefined) expect(slipped).toBeLessThan(shared!);
  });
});

describe("S19 - branch coverage: sparse beliefs, retold facts, unknown style", () => {
  it("a belief with no optional fields (no hops/confidence/original/distortion/subject) still spreads without crashing", () => {
    let moved = false;
    for (let seed = 1; seed < 200 && !moved; seed++) {
      const sb = buildSandbox(7);
      const k = sb.engine.knowledge;
      k.seedBelief(H, { content: "bare", factId: "bare" }, "origin");
      const deps: SpreadDeps = { knowledge: k, told: new ToldLedger(), rngFor: () => new SeededRandom(seed), trust: () => 0.9, affinity: () => 0.9, threat: () => 0, style: () => "loyal", volatility: () => 0.9, audienceOf: () => 0 };
      const r = spreadBetween(H, L, deps)[0]!;
      if (r.transmitted) { moved = true; const got = k.knownTo(L).find((f) => (f.factId ?? f.id) === "bare")!; expect(got.hops).toBe(1); expect(got.originalContent).toBe("bare"); }
    }
    expect(moved).toBe(true);
  });
  it("a fact the holder only heard second-hand (hops > 0) is the cheap risk class and still decides once", () => {
    const sb = buildSandbox(7);
    const k = sb.engine.knowledge;
    k.seedBelief(H, { content: "heard", factId: "h2", hops: 2, source: OUT, confidence: 0.6 }, "told");
    const told = new ToldLedger();
    const deps: SpreadDeps = { knowledge: k, told, rngFor: () => new SeededRandom(3), trust: () => 0.9, affinity: () => 0.9, threat: () => 0, style: () => "strategic", volatility: () => 0.1, audienceOf: () => 0 };
    expect(spreadBetween(H, L, deps)).toHaveLength(1);
    expect(told.decided(H, "h2", L)).toBe(true);
  });
  it("a strategy style outside the leakiness table falls back to the default", () => {
    const sb = buildSandbox(7);
    const k = sb.engine.knowledge;
    k.seedBelief(H, { content: "x", factId: "x1" }, "origin");
    const deps: SpreadDeps = { knowledge: k, told: new ToldLedger(), rngFor: () => new SeededRandom(3), trust: () => 0.9, affinity: () => 0.9, threat: () => 0, style: () => "mystery" as never, volatility: () => 0.2, audienceOf: () => 0 };
    expect(spreadBetween(H, L, deps)).toHaveLength(1);
  });
});
