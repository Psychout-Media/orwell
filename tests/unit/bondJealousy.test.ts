import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BOND_JEALOUSY, adjustedKeep, jealousy, jealousyKey, jealousyMoodKey, loyaltySplit, loyaltySplitOver, nextJealousy, sharedScenes } from "../../src/engine/bondJealousy";
import { bondKey, emptyBond } from "../../src/engine/bondRecord";
import type { BondReader } from "../../src/engine/bonds";
import { voteChoice } from "../../src/engine/liveSeason";
import { GameSessionRegistry } from "../../src/composition/registry";

/** ORW-568 / spec 0181 part 2: jealousy and divided loyalty. Roles only. */
const base = { closeWarmth: 0.8, rivalWarmth: 0.2, xyScenes: 4, xhScenes: 1 };

describe("jealousy (pure)", () => {
  it("is monotone in how much the close friend favours the rival, and bounded", () => {
    let prev = -1;
    for (const xy of [2, 3, 4, 6, 10, 30]) { const j = jealousy({ ...base, xyScenes: xy }); expect(j).toBeGreaterThanOrEqual(prev); expect(j).toBeLessThanOrEqual(BOND_JEALOUSY.maxJealousy); prev = j; }
    expect(jealousy({ ...base, xyScenes: 10 })).toBeGreaterThan(jealousy({ ...base, xyScenes: 3 }));
    expect(BOND_JEALOUSY.maxJealousy).toBeLessThan(1);
    expect(jealousy({ ...base, closeWarmth: 1, xyScenes: 1000, xhScenes: 0, rivalWarmth: 0 }, { paranoia: 9, bonding: 9, loyalty: 0.01 })).toBeLessThanOrEqual(BOND_JEALOUSY.maxJealousy);
  });
  it("is zero when the holder is not close, when the favour is not there, or the friend gives the holder as much", () => {
    expect(jealousy({ ...base, closeWarmth: 0.1 })).toBe(0);
    expect(jealousy({ ...base, xyScenes: 1 })).toBe(0);
    expect(jealousy({ ...base, xyScenes: 3, xhScenes: 3 })).toBe(0);
    expect(jealousy({ ...base, xhScenes: 4 })).toBe(0);
  });
  it("the closer the holder, the more it stings; a rival they warm to stings less", () => {
    expect(jealousy({ ...base, closeWarmth: 0.9 })).toBeGreaterThan(jealousy({ ...base, closeWarmth: 0.4 }));
    expect(jealousy({ ...base, rivalWarmth: 0.9 })).toBeLessThan(jealousy({ ...base, rivalWarmth: 0 }));
  });
  it("the culture leans it and no dials is a no-op", () => {
    const j = jealousy(base);
    expect(jealousy(base, { paranoia: 1.2 })).toBeGreaterThan(j);
    expect(jealousy(base, { bonding: 1.2 })).toBeGreaterThan(j);
    expect(jealousy(base, { loyalty: 1.2 })).toBeLessThan(j);
    expect(jealousy(base, { loyalty: 1, bonding: 1, paranoia: 1 })).toBe(j);
  });
  it("decays at night without the favour, rises at once with it, and is capped", () => {
    expect(nextJealousy(0.4, 0)).toBeCloseTo(0.4 - BOND_JEALOUSY.nightlyFade, 9);
    expect(nextJealousy(0.05, 0)).toBe(0);
    expect(nextJealousy(0.1, 0.4)).toBe(0.4);
    expect(nextJealousy(0.5, 5)).toBe(BOND_JEALOUSY.maxJealousy);
  });
  it("counts shared scenes, and the keep slips with jealousy while a split adds to it", () => {
    expect(sharedScenes([["a", "b"], ["a", "b", "c"], ["b", "c"]], "a", "b")).toBe(2);
    expect(adjustedKeep(0.2, 0, 0)).toBe(0.2);
    expect(adjustedKeep(0.2, 0.6, 0)).toBeLessThan(0.2);
    expect(adjustedKeep(0.2, 0, 0.5)).toBeGreaterThan(0.2);
  });
  it("the keys are one holder and one rival, once per week", () => {
    expect(jealousyKey("H", "Y")).toBe("H|Y");
    expect(jealousyMoodKey(3, "H", "Y")).toBe("jealous:3:H:Y");
  });
});

describe("divided loyalty (pure)", () => {
  type V = { strength?: number; resentment?: number; strain?: number };
  const reader = (s: Record<string, V>): BondReader => ({
    strength: (h: string, o: string) => s[`${h}|${o}`]?.strength ?? 0,
    bond: (h: string, o: string) => ({ resentment: s[`${h}|${o}`]?.resentment ?? 0, strain: s[`${h}|${o}`]?.strain ?? 0 }),
    living: () => ["H", "A", "B", "C"],
  }) as unknown as BondReader;
  const close = { "H|A": { strength: 0.6 }, "H|B": { strength: 0.6 } };
  it("is zero unless the holder is close to both and the two have fallen out, and bounded", () => {
    expect(loyaltySplit("H", "A", "B", reader({ ...close, "A|B": { resentment: 0.7 } }))).toBeGreaterThan(0);
    expect(loyaltySplit("H", "A", "B", reader({ ...close }))).toBe(0);
    expect(loyaltySplit("H", "A", "B", reader({ "H|A": { strength: 0.6 }, "H|B": { strength: 0.05 }, "A|B": { resentment: 0.9 } }))).toBe(0);
    expect(loyaltySplit("H", "A", "B", reader({ "H|A": { strength: 1 }, "H|B": { strength: 1 }, "A|B": { resentment: 1, strain: 1 } }))).toBeLessThanOrEqual(BOND_JEALOUSY.maxSplit);
    expect(loyaltySplit("H", "A", "A", reader(close))).toBe(0);
  });
  it("is deeper with a deeper fall-out, from either side, and the over-reading finds the pair", () => {
    const r = (x: number) => reader({ ...close, "B|A": { strain: x } });
    expect(loyaltySplit("H", "A", "B", r(0.9))).toBeGreaterThan(loyaltySplit("H", "A", "B", r(0.4)));
    expect(loyaltySplitOver("H", "A", r(0.9))).toBe(loyaltySplit("H", "A", "B", r(0.9)));
    expect(loyaltySplitOver("Z", "A", r(0.9))).toBe(0);
  });
});

type Ev = { id: string; ts: number; type: string; initiator: string; witnessSet: string[]; hidden: boolean; content: string; houseLife?: { seenBy?: string[] } };
type Live = { week: number; playedGame?: boolean; active: string[]; bonds?: Record<string, unknown>; bondsCursor?: number; jealousy?: Record<string, { value: number; week: number; close: string }>; jealousySeen?: string[]; jealousyCursor?: number };
type Internals = {
  live: Live;
  rel: { load(e: unknown): void; edge(a: string, b: string): { trust: number; affinity: number } };
  ctx(): unknown;
  feelingsTick(): void;
  feelingKeepOf(o: string, h: string): number;
  jealousyOf(h: string, c: string): number;
  splitOf(h: string, o: string): number;
  setBondFeelingsEnabled(on: boolean): void;
  setRecordProviders(p: { events: () => Ev[]; hidden: () => [] }): void;
  snapshot(): unknown; restore(c: unknown): void; npcVoice(id: string): unknown;
  house: { player: { soul: { emotionalState: number } }; npcs: Array<{ id: string; soul: { emotionalState: number } }> };
};
let n = 0;
let evs: Ev[] = [];
const start = (seed: number, on = true): Internals => {
  const sb = new GameSessionRegistry().sandboxFor(`bj568-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setBondFeelingsEnabled(on);
  sb.session.noteMessage({ messageId: "m1" });
  evs = [];
  const s = sb.session as unknown as Internals;
  s.setRecordProviders({ events: () => evs, hidden: () => [] });
  return s;
};
const npcs = (s: Internals): string[] => s.live.active.filter((x) => x.startsWith("npc:"));
const setBond = (s: Internals, h: string, o: string, warmth: number, extra: Record<string, number> = {}): void => { (s.live.bonds ??= {})[bondKey(h, o)] = { ...emptyBond(), warmth, ...extra }; };
const scene = (type: string, ...w: string[]): void => { evs.push({ id: `e${evs.length}`, ts: evs.length, type, initiator: w[0]!, witnessSet: w, hidden: false, content: "" }); };
/** A scene among `w` that the people in `saw` watched from the same room. */
const seenScene = (type: string, saw: string[], ...w: string[]): void => { evs.push({ id: `e${evs.length}`, ts: evs.length, type, initiator: w[0]!, witnessSet: w, hidden: false, content: "", houseLife: { seenBy: saw } }); };
const settle = (s: Internals): void => { s.live.bondsCursor = evs.length; s.feelingsTick(); };
const mood = (s: Internals, id: string): number => s.house.npcs.find((x) => x.id === id)!.soul.emotionalState;
/** H is close to X; X spends scenes with Y and few with H. */
const triangle = (s: Internals, scenesXY = 4, seen = true): [string, string, string] => {
  const [H, X, Y] = npcs(s) as [string, string, string];
  setBond(s, H, X, 0.8); setBond(s, X, Y, 0.7); setBond(s, X, H, 0.3);
  scene("strategy", X, H);
  for (let i = 0; i < scenesXY; i++) { if (seen) seenScene("bonding", [H], X, Y); else scene("bonding", X, Y); }
  return [H, X, Y];
};

describe("unit, state set by hand (bonds and scenes are planted; REAL PATH: tests/realpath/bondJealousy.test.ts, ORW-811): the nightly tick, in a played game", () => {
  it("a holder close to X who watches X favour a rival grows jealous, and the closeness slips", () => {
    const s = start(3);
    const [H, X, Y] = triangle(s);
    const keep0 = s.feelingKeepOf(X, H);
    const m0 = mood(s, H);
    settle(s);
    const j = s.live.jealousy![jealousyKey(H, Y)]!;
    expect(j.value).toBeGreaterThan(0);
    expect(j.close).toBe(X);
    expect(s.feelingKeepOf(X, H)).toBeLessThan(keep0);
    expect(mood(s, H)).toBeLessThan(m0);
    expect(s.live.jealousySeen).toEqual([jealousyMoodKey(s.live.week, H, Y)]);
  });
  it("more favour, more jealousy", () => {
    const run = (k: number): number => { const s = start(3); const [H, , Y] = triangle(s, k); settle(s); return s.live.jealousy?.[jealousyKey(H, Y)]?.value ?? 0; };
    expect(run(8)).toBeGreaterThan(run(3));
    expect(run(1)).toBe(0);
  });
  it("a scene the holder did not witness raises no jealousy; the same scene witnessed does", () => {
    const unseen = start(3);
    const [H1, , Y1] = triangle(unseen, 4, false);
    settle(unseen);
    expect(unseen.live.jealousy?.[jealousyKey(H1, Y1)]).toBeUndefined();
    const seen = start(3);
    const [H2, , Y2] = triangle(seen, 4, true);
    settle(seen);
    expect(seen.live.jealousy![jealousyKey(H2, Y2)]!.value).toBeGreaterThan(0);
    const inRoom = start(3);
    const [H3, X3, Y3] = npcs(inRoom) as [string, string, string];
    setBond(inRoom, H3, X3, 0.8);
    scene("strategy", X3, H3);
    for (let i = 0; i < 4; i++) seenScene("bonding", [], X3, Y3, H3); // the holder was in the scene itself: X gives the holder as much
    settle(inRoom);
    expect(inRoom.live.jealousy?.[jealousyKey(H3, Y3)]).toBeUndefined();
  });
  it("X's hidden warmth toward the rival or the holder is not read", () => {
    const run = (xy: number, xh: number): number => { const s = start(3); const [H, X, Y] = triangle(s); setBond(s, X, Y, xy); setBond(s, X, H, xh); settle(s); return s.live.jealousy?.[jealousyKey(H, Y)]?.value ?? 0; };
    const v = run(0.7, 0.3);
    expect(v).toBeGreaterThan(0);
    expect(run(0.05, 0.9)).toBe(v);
    expect(run(1, 0)).toBe(v);
  });
  it("a holder who is not close to X feels nothing", () => {
    const s = start(3);
    const [H, X, Y] = triangle(s);
    setBond(s, H, X, 0.05);
    settle(s);
    expect(s.live.jealousy?.[jealousyKey(H, Y)]).toBeUndefined();
  });
  it("a bonding scene between the holder and X ahead of the tick handles it", () => {
    const s = start(3);
    const [H, X, Y] = triangle(s);
    settle(s);
    expect(s.live.jealousy![jealousyKey(H, Y)]!.value).toBeGreaterThan(0);
    scene("bonding", H, X);
    settle(s);
    expect(s.live.jealousy![jealousyKey(H, Y)]!.value).toBe(0);
    expect(s.jealousyOf(H, X)).toBe(0);
  });
  it("it fades by itself when the favour stops, and the mood hit is once per week", () => {
    const s = start(3);
    const [H, , Y] = triangle(s);
    settle(s); settle(s);
    expect(s.live.jealousySeen!.length).toBe(1);
    const v0 = s.live.jealousy![jealousyKey(H, Y)]!.value;
    evs = []; // the favour is out of the window
    settle(s);
    expect(s.live.jealousy![jealousyKey(H, Y)]!.value).toBeLessThan(v0);
    for (let i = 0; i < 10; i++) settle(s);
    expect(s.live.jealousy![jealousyKey(H, Y)]!.value).toBe(0);
  });
  it("the player is never the holder, and the bond record is never written", () => {
    const s = start(3);
    const [, X, Y] = triangle(s);
    setBond(s, "player", X, 0.9);
    for (let i = 0; i < 5; i++) scene("bonding", X, Y);
    const before = JSON.stringify(s.live.bonds);
    settle(s);
    expect(Object.keys(s.live.jealousy ?? {}).some((k) => k.startsWith("player|"))).toBe(false);
    expect(JSON.stringify(s.live.bonds)).toBe(before);
  });
  it("persists across a save and restore", () => {
    const s = start(3);
    triangle(s);
    settle(s);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const sb2 = new GameSessionRegistry().sandboxFor(`bj568-rt-${n++}`);
    sb2.session.restore(snap);
    const t = sb2.session as unknown as Internals;
    expect(t.live.jealousy).toEqual(s.live.jealousy);
    expect(t.live.jealousySeen).toEqual(s.live.jealousySeen);
    expect(t.live.jealousyCursor).toBe(s.live.jealousyCursor);
  });
  it("flag off: the tick writes nothing", () => {
    const s = start(3, false);
    triangle(s);
    settle(s);
    expect(s.live.jealousy).toBeUndefined();
    expect(s.live.jealousyCursor).toBeUndefined();
  });
});

describe("unit, state set by hand (bonds and scenes are planted; REAL PATH: tests/realpath/bondJealousy.test.ts, ORW-811): divided loyalty, decision level through the real adapter", () => {
  /** The same voters, all close to A; `alsoB` makes them close to B too, and A and B have fallen out. Returns how many vote A out against C. */
  const votesAgainstA = (alsoB: boolean, on = true): number => {
    const s = start(3, on);
    s.rel.load([]); // strangers everywhere: the only difference is the ties set below
    const [A, B, C, ...rest] = npcs(s);
    const voters = rest.slice(0, 10);
    for (const v of voters) { s.rel.edge(v, A!).trust = 0.9; s.rel.edge(v, A!).affinity = 0.9; setBond(s, v, A!, 0.95); }
    if (alsoB) for (const v of voters) { s.rel.edge(v, B!).trust = 0.9; s.rel.edge(v, B!).affinity = 0.9; setBond(s, v, B!, 0.95); }
    setBond(s, A!, B!, 0.1, { resentment: 0.7, strain: 0.7 }); setBond(s, B!, A!, 0.1, { resentment: 0.7, strain: 0.7 });
    s.live.bondsCursor = Number.MAX_SAFE_INTEGER;
    const ctx = { ...(s.ctx() as object), memoryTiltFor: (n: string) => (n === A ? PRESSURE : 0) } as unknown as Parameters<typeof voteChoice>[2];
    return voters.filter((v) => voteChoice(v, [A!, C!], ctx) === A).length;
  };
  const PRESSURE = 0.5;
  it("a holder close to both of a fallen-out pair draws fewer evict votes against either than a holder close to one only", () => {
    const one = votesAgainstA(false), both = votesAgainstA(true);
    expect(one).toBeGreaterThan(0);
    expect(both).toBeLessThan(one);
  });
  it("with the feature off the second tie changes nothing", () => {
    expect(votesAgainstA(true, false)).toBe(votesAgainstA(false, false));
  });
  it("the split only shows through the keep: a single-tie holder reads zero split, a double-tie holder reads some", () => {
    const s = start(3);
    s.rel.load([]);
    const [A, B, , V1, V2] = npcs(s);
    for (const v of [V1!, V2!]) setBond(s, v, A!, 0.95);
    setBond(s, V1!, B!, 0.95);
    setBond(s, A!, B!, 0.1, { resentment: 0.7 });
    s.live.bondsCursor = Number.MAX_SAFE_INTEGER;
    for (const v of [V1!, V2!]) { s.rel.edge(v, A!).trust = 0.9; s.rel.edge(v, A!).affinity = 0.9; }
    s.rel.edge(V1!, B!).trust = 0.9; s.rel.edge(V1!, B!).affinity = 0.9;
    expect(s.splitOf(V2!, A!)).toBe(0);
    expect(s.splitOf(V1!, A!)).toBeGreaterThan(0);
    expect(s.splitOf("player", A!)).toBe(0);
    expect(s.feelingKeepOf(A!, V1!)).toBeGreaterThan(s.feelingKeepOf(A!, V2!));
  });
});

describe("flag off and headless are byte-identical", () => {
  it("a headless game's snapshot is the same with the flag on or off, seeds 3 and 11", () => {
    const run = (seed: number, on: boolean): string => {
      const sb = new GameSessionRegistry().sandboxFor(`bj568-h-${n++}`);
      sb.session.setBondFeelingsEnabled(on);
      sb.session.createCharacter({ playerName: "The Player", seed });
      sb.session.advanceGame({});
      sb.session.advanceGame({});
      return JSON.stringify(sb.session.snapshot());
    };
    for (const seed of [3, 11]) expect(run(seed, true)).toBe(run(seed, false));
  });
  it("the alliance-break draw keeps its own key; only the threshold takes the split", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect(src.match(/alliance-clash:\$\{al\.id\}:\$\{m\}:\$\{day\}/g)?.length).toBe(1);
    expect(src).toContain("BOND_JEALOUSY.splitBreakK * this.splitOf(m, goal.target!)");
  });
});

describe("the wall: no jealousy or split on any outward surface", () => {
  it("projections, the moment prompt and the admin view carry none", async () => {
    const sb = new GameSessionRegistry().sandboxFor(`bj568-wall-${n++}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 21 });
    sb.session.noteMessage({ messageId: "w0" });
    const s = sb.session as unknown as Internals;
    evs = [];
    s.setRecordProviders({ events: () => evs, hidden: () => [] });
    triangle(s);
    settle(s);
    expect(Object.keys(s.live.jealousy ?? {}).length).toBeGreaterThan(0);
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {}), npcs(s).map((id) => s.npcVoice(id)),
    ];
    const blob = JSON.stringify(surfaces).toLowerCase();
    for (const k of ["jealousy", "jealousyseen", "jealousycursor", "loyaltysplit", "splitof", "jealous:"]) expect(blob.includes(k), `a live surface carries ${k}`).toBe(false);
  });
});
