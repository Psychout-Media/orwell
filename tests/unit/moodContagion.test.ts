import { describe, it, expect } from "vitest";
import { MOOD_CONTAGION, catchScales, exposureOf, shockOf } from "../../src/engine/moodContagion";
import { evolveEmotion } from "../../src/engine/emotionalArc";
import type { Soul } from "../../src/engine/characterFactory";
import type { BondReader } from "../../src/engine/bonds";
import { dialMult, type HouseLeans } from "../../src/engine/houseLeans";
import { GameSessionRegistry } from "../../src/composition/registry";

/** ORW-567 / spec 0185: mood contagion. Roles only. */
const readerOf = (ids: string[], strong: Array<[string, string]>): BondReader => {
  const key = (a: string, b: string): string => [a, b].sort().join("|");
  const set = new Set(strong.map(([a, b]) => key(a, b)));
  const tie = (a: string, b: string): number => (set.has(key(a, b)) ? 0.9 : 0);
  return {
    living: () => ids, day: () => 1, tie,
    strength: tie, bond: () => { throw new Error("unused"); },
    ties: (h: string) => ids.filter((o) => o !== h).map((other) => ({ other, strength: tie(h, other) })),
  } as unknown as BondReader;
};
const IDS = ["E", "A", "F", "S", "G"];
// A is E's direct ally, F is A's friend (not E's), S and G are strangers to everyone.
const reader = readerOf(IDS, [["E", "A"], ["A", "F"]]);
const cands = ["A", "F", "S", "G"];
const scaleOf = (m: number, mood: "bad" | "good" = "bad", dials = {}): Record<string, number> =>
  Object.fromEntries(catchScales({ reader, source: "E", magnitude: m, mood, candidates: cands, dials }).map((x) => [x.id, x.scale]));

describe("the pure spread", () => {
  it("a close ally catches more than a second-hop friend, who catches more than a stranger, who still catches a little", () => {
    const s = scaleOf(1);
    expect(s.A!).toBeGreaterThan(s.F!);
    expect(s.F!).toBeGreaterThan(s.S!);
    expect(s.S!).toBeGreaterThan(0);
  });
  it("no shock spreads nothing", () => {
    expect(catchScales({ reader, source: "E", magnitude: 0, mood: "bad", candidates: cands })).toEqual([]);
    expect(shockOf(undefined)).toBe(0);
    expect(shockOf({ x: { respected: true, intensity: 0.9 } })).toBe(0);
  });
  it("shock reads the worst blindsided or betrayed intensity", () => {
    expect(shockOf({ x: { blindsided: true, intensity: 0.4 }, y: { betrayed: true, intensity: 0.7 }, z: { respected: true, intensity: 1 } })).toBe(0.7);
  });
  it("is monotone in the shock and bounded", () => {
    let prev = scaleOf(0.1);
    for (const m of [0.3, 0.6, 1, 5]) {
      const cur = scaleOf(m);
      for (const id of cands) { expect(cur[id]!).toBeGreaterThanOrEqual(prev[id]!); expect(cur[id]!).toBeLessThanOrEqual(MOOD_CONTAGION.MAX_SCALE); }
      prev = cur;
    }
  });
  it("is deterministic and independent of candidate order", () => {
    const a = catchScales({ reader, source: "E", magnitude: 0.8, mood: "bad", candidates: cands });
    const b = catchScales({ reader, source: "E", magnitude: 0.8, mood: "bad", candidates: [...cands].reverse() });
    expect(b).toEqual(a);
  });
  it("the source is never a candidate", () => {
    expect(catchScales({ reader, source: "E", magnitude: 1, mood: "bad", candidates: ["E", ...cands] }).some((x) => x.id === "E")).toBe(false);
  });
  it("a paranoid house spreads a bad mood more and a good mood not; a bonding house the reverse; no culture is a no-op", () => {
    const par = dialMult({ leans: [{ id: "paranoid", w: 1 }] } as HouseLeans, "paranoia");
    const bond = dialMult({ leans: [{ id: "one-big-family", w: 1 }] } as HouseLeans, "bonding");
    expect(par).toBeGreaterThan(1); expect(bond).toBeGreaterThan(1);
    const base = scaleOf(0.5);
    expect(scaleOf(0.5, "bad", { paranoia: par }).S!).toBeGreaterThan(base.S!);
    expect(scaleOf(0.5, "good", { paranoia: par })).toEqual(scaleOf(0.5, "good"));
    expect(scaleOf(0.5, "good", { bonding: bond }).S!).toBeGreaterThan(scaleOf(0.5, "good").S!);
    expect(scaleOf(0.5, "bad", { paranoia: 1, bonding: 1, loyalty: 1 })).toEqual(base);
    expect(scaleOf(0.5, "bad", {})).toEqual(base);
  });
  it("the loyalty dial scales only the direct tie term", () => {
    const d = scaleOf(0.5, "bad", { loyalty: 1.2 });
    const b = scaleOf(0.5);
    expect(d.A!).toBeGreaterThan(b.A!);
    expect(d.S!).toBe(b.S!);
  });
  it("exposure is the direct tie or half the best two-step link", () => {
    expect(exposureOf(reader, "A", "E")).toBeCloseTo(0.9, 9);
    expect(exposureOf(reader, "F", "E")).toBeCloseTo(MOOD_CONTAGION.HOP_DECAY * 0.81, 9);
    expect(exposureOf(reader, "S", "E")).toBe(0);
  });
});

const emptySoul = (): Soul => ({ emotionalBaseline: 0.5, volatility: 0.4, emotionalState: 0.5, emotionalHistory: [], memory: [] });

describe("evolveEmotion with a scale", () => {
  const run = (scale?: number, depth = false) => {
    const s = emptySoul(); s.emotionalState = 0.5;
    evolveEmotion(s, "blindside", undefined, undefined, { soulDepth: depth, ...(scale === undefined ? {} : { scale }) });
    return JSON.stringify(s);
  };
  it("scale 1 and absent are byte-identical", () => {
    expect(run(1)).toBe(run(undefined));
    expect(run(1, true)).toBe(run(undefined, true));
  });
  it("a smaller scale moves the state less, in the same direction", () => {
    const d = (sc: number): number => { const s = emptySoul(); s.emotionalState = 0.5; evolveEmotion(s, "blindside", undefined, undefined, { scale: sc }); return 0.5 - s.emotionalState; };
    expect(d(1)).toBeGreaterThan(d(0.3));
    expect(d(0.3)).toBeGreaterThan(0);
  });
});

describe("in a played game", () => {
  type Internals = {
    live: { active: string[]; mannerByEvictee?: Record<string, Record<string, unknown>> };
    rel: { serialize(): { edges: Array<Record<string, number | string>> }; load(e: unknown): void; peek(a: string, b: string): Record<string, number> };
    evolveFromBeat(ev: { beat: string; content: string; participants: string[] }): void;
    snapshot(): unknown; settleOvernight(n: number): number; npcVoice(id: string): unknown;
    setMoodContagionEnabled(on: boolean): void;
    house: { player: { soul: { emotionalState: number } }; npcs: Array<{ id: string; soul: { emotionalState: number; emotionalHistory: number[]; memory: string[] } }> };
  };
  const start = (seed: number, n: string, on = true) => {
    const sb = new GameSessionRegistry().sandboxFor(`mc567-${n}-${seed}-${on}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    sb.session.setMoodContagionEnabled(on);
    sb.session.noteMessage({ messageId: "m1" });
    return sb.session as unknown as Internals;
  };
  const setEdge = (s: Internals, a: string, b: string, v: number): void => {
    const base = s.rel.peek(a, b);
    const edges = s.rel.serialize().edges.filter((e) => !(e.from === a && e.to === b));
    edges.push({ from: a, to: b, ...base, trust: v, affinity: v, threat: 0.1 });
    s.rel.load(edges);
  };
  const cast = (s: Internals) => {
    const [E, A, B, S] = s.live.active.filter((x) => x.startsWith("npc:"));
    s.rel.load([]); // every pair at the baseline: strangers
    for (const [x, y, v] of [[A, E, 0.95], [E, A, 0.95], [B, E, 0.8], [E, B, 0.8]] as Array<[string, string, number]>) setEdge(s, x!, y!, v);
    s.live.mannerByEvictee = { [E!]: { player: { blindsided: true, intensity: 1 } } };
    return { E: E!, A: A!, B: B!, S: S! };
  };
  const mood = (s: Internals, id: string): number => s.house.npcs.find((n) => n.id === id)!.soul.emotionalState;
  const evict = (s: Internals, E: string): void => s.evolveFromBeat({ beat: "eviction", content: "", participants: [E] });

  it("a blindsiding eviction rattles an ally more than a stranger, and a stranger a little", () => {
    const s = start(3, "a"); const { E, B, S } = cast(s);
    const [b0, s0] = [mood(s, B), mood(s, S)];
    const mem = s.house.npcs.find((n) => n.id === S)!.soul.memory.length;
    evict(s, E);
    expect(b0 - mood(s, B)).toBeGreaterThan(s0 - mood(s, S));
    expect(s0 - mood(s, S)).toBeGreaterThan(0);
    expect(s.house.npcs.find((n) => n.id === S)!.soul.memory.length).toBe(mem); // no recall filler
  });
  it("an expected exit spreads nothing", () => {
    const on = start(3, "b"); const { E, S } = cast(on);
    on.live.mannerByEvictee = { [E]: { player: { respected: true, intensity: 1 } } };
    const s0 = mood(on, S); evict(on, E);
    expect(mood(on, S)).toBe(s0);
  });
  it("overnight settling pulls a rattled houseguest back toward baseline", () => {
    const s = start(3, "c"); const { E, B } = cast(s);
    const b0 = mood(s, B); evict(s, E);
    const rattled = mood(s, B);
    expect(rattled).toBeLessThan(b0);
    s.settleOvernight(8);
    expect(mood(s, B)).toBeGreaterThan(rattled);
  });
  it("flag off leaves every soul but the closest ally byte-identical, seeds 3 and 11, and replays the same", () => {
    for (const seed of [3, 11]) {
      const run = (): { snap: string; strangers: string } => {
        const s = start(seed, "d", false); const { E, A } = cast(s);
        const strangers = (): string => JSON.stringify(s.house.npcs.filter((n) => n.id !== A && n.id !== E).map((n) => n.soul));
        const before = strangers(); evict(s, E);
        expect(strangers()).toBe(before);
        return { snap: JSON.stringify(s.snapshot()), strangers: before };
      };
      expect(run()).toEqual(run());
    }
  });
  it("an HOH win lifts the winner's allies a little, and the player's mood is not touched", () => {
    const s = start(3, "f"); const { E: W, A, S } = cast(s);
    const [a0, s0] = [mood(s, A), mood(s, S)];
    const player = s.house.player.soul;
    const p0 = player.emotionalState;
    s.evolveFromBeat({ beat: "hoh-competition", content: "", participants: [W] });
    expect(mood(s, A) - a0).toBeGreaterThan(mood(s, S) - s0);
    expect(player.emotionalState).toBe(p0);
  });
  it("ORW-684 item 5: the hidden regard only sets how much of the mood a houseguest catches; contagion on vs off differs in the souls and nowhere else (no event, claim, edge or room moves)", () => {
    const run = (on: boolean): Record<string, unknown> => {
      const s = start(3, "h", on); const { E } = cast(s);
      (s as unknown as { foldAtCommit(): void }).foldAtCommit(); // catch the lazy bond/grudge fold up in BOTH runs first: reading a bond folds the record (a separate, known read-time fold), and that must not be what this compares
      evict(s, E);
      const snap = JSON.parse(JSON.stringify(s.snapshot())) as Record<string, unknown>;
      delete snap.house; // the souls live here: the one place the catch may land
      delete snap.tellOnsetCount; // a telemetry count of tells starting (the tells themselves are in the souls)
      for (const k of Object.keys(snap)) if (/^seenMessageIds$/.test(k)) delete snap[k];
      return snap;
    };
    expect(run(true)).toEqual(run(false));
  });
  it("no projection carries a scale, a bond strength or a mood number", () => {
    const s = start(3, "g"); const { E } = cast(s); evict(s, E);
    const dump = JSON.stringify(s.live.active.map((id) => s.npcVoice(id)));
    for (const w of ["scale", "contagion", "distress", "confidence", "strength"]) expect(dump).not.toContain(`"${w}"`);
  });
});
