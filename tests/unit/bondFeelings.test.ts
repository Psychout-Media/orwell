import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BOND_FEELINGS, breakDivisor, feeling, feelingKeep, feelsGuilt, guiltKey, guiltScale, hesitation, hesitationFor, markFeeling } from "../../src/engine/bondFeelings";
import { bondKey, emptyBond } from "../../src/engine/bondRecord";
import type { BondReader } from "../../src/engine/bonds";
import { nominationPlan } from "../../src/engine/season";
import { voteChoice } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-568 / spec 0181: a bond's life, part 1 (feelings vs strategy, guilt). Roles only. */
const v = (warmth: number, resentment = 0, strain = 0) => ({ warmth, resentment, strain });

describe("hesitation (pure)", () => {
  it("is monotone in warmth, capped below 1, and falls with resentment", () => {
    let prev = -1;
    for (const w of [0, 0.1, 0.3, 0.5, 0.8, 1]) { const h = hesitation(v(w)); expect(h).toBeGreaterThanOrEqual(prev); expect(h).toBeLessThan(1); prev = h; }
    expect(hesitation(v(0.8, 0.5))).toBeLessThan(hesitation(v(0.8, 0)));
    expect(BOND_FEELINGS.maxHesitation).toBeLessThan(1);
  });
  it("is zero for a stranger and for a grudge-holder", () => {
    expect(hesitation(v(0))).toBe(0);
    expect(hesitation(v(0.9, 1))).toBe(0);
  });
  it("a frayed bond holds back a little less, never below zero", () => {
    expect(hesitation(v(0.8, 0, 1))).toBeLessThan(hesitation(v(0.8, 0, 0)));
    expect(hesitation(v(0.8, 0, 1))).toBeGreaterThan(0);
  });
  it("hesitationFor reads the holder's own view through the reader", () => {
    const reader = { bond: (h: string, o: string) => ({ ...v(h === "A" && o === "B" ? 0.9 : 0), holder: h, other: o }) } as unknown as BondReader;
    expect(hesitationFor("A", "B", reader)).toBeGreaterThan(0);
    expect(hesitationFor("B", "A", reader)).toBe(0);
  });
  it("the vote term and the alliance divisor follow the hesitation", () => {
    expect(feelingKeep(v(0))).toBe(0);
    expect(feelingKeep(v(0.9))).toBeGreaterThan(feelingKeep(v(0.4)));
    expect(breakDivisor(v(0))).toBe(1);
    expect(breakDivisor(v(0.9))).toBeGreaterThan(1);
  });
});

describe("guilt (pure)", () => {
  it("is zero for a grudge-holder or a stranger and larger with warmth, below 1", () => {
    expect(guiltScale(v(0.9, 1))).toBe(0);
    expect(guiltScale(v(0))).toBe(0);
    expect(guiltScale(v(0.9))).toBeGreaterThan(guiltScale(v(0.5)));
    expect(guiltScale(v(1, 0, 0), { loyalty: 5, bonding: 5, paranoia: 5 })).toBeLessThan(1);
  });
  it("the culture dials lean it, and no dials is a no-op", () => {
    const base = guiltScale(v(0.7));
    expect(guiltScale(v(0.7), { loyalty: 1.2 })).toBeGreaterThan(base);
    expect(guiltScale(v(0.7), { paranoia: 1.2 })).toBeGreaterThan(base);
    expect(guiltScale(v(0.7), { bonding: 1.2 })).toBeGreaterThan(base);
    expect(guiltScale(v(0.7), { bonding: 1.2 })).toBeLessThan(guiltScale(v(0.7), { loyalty: 1.2 }));
    expect(guiltScale(v(0.7), { loyalty: 1, bonding: 1, paranoia: 1 })).toBe(base);
  });
  it("only a real feeling passes the bar", () => {
    expect(feelsGuilt(v(0.1))).toBe(false);
    expect(feelsGuilt(v(0.9, 0.9))).toBe(false);
    expect(feelsGuilt(v(0.9))).toBe(true);
    expect(feeling(v(0.8, 0.5))).toBeCloseTo(0.4, 9);
  });
  it("the dedupe ledger marks a key once and keeps order", () => {
    const seen: string[] = [];
    expect(markFeeling(seen, guiltKey(2, "A", "B"))).toBe(true);
    expect(markFeeling(seen, guiltKey(2, "A", "B"))).toBe(false);
    expect(markFeeling(seen, guiltKey(3, "A", "B"))).toBe(true);
    expect(seen).toEqual(["guilt:2:A:B", "guilt:3:A:B"]);
  });
});

describe("nominations", () => {
  it("a candidate the HOH truly likes is harder to put up", () => {
    const ids = ["h", "a", "b", "c", "d", "e"];
    const rel = new RelationshipModel(0.5);
    const free = nominationPlan("h", ids, rel, {});
    const liked = free.target;
    const kept = nominationPlan("h", ids, rel, { feelingPush: (t) => (t === liked ? -0.9 : 0) });
    expect(kept.target).not.toBe(liked);
    expect(kept.nominees).not.toContain(liked);
  });
});

type Live = { week: number; playedGame?: boolean; active: string[]; bonds?: Record<string, Record<string, unknown>>; feelingsSeen?: string[]; voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }> };
type Internals = {
  live: Live;
  rel: { load(e: unknown): void };
  ctx(): { feelingKeepFor?: unknown };
  feelGuilt(b: string, w: string): void;
  feelingKeepOf(o: string, h: string): number;
  setBondFeelingsEnabled(on: boolean): void;
  evolveFromBeat(ev: { beat: string; content: string; participants: string[] }): void;
  snapshot(): unknown; restore(c: unknown): void; npcVoice(id: string): unknown;
  house: { player: { soul: { emotionalState: number } }; npcs: Array<{ id: string; soul: { emotionalState: number; memory: string[] } }> };
};
let n = 0;
const start = (seed: number, opts: { on?: boolean; played?: boolean } = {}): Internals => {
  const sb = new GameSessionRegistry().sandboxFor(`bf568-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setBondFeelingsEnabled(opts.on ?? true);
  if (opts.played !== false) sb.session.noteMessage({ messageId: "m1" });
  return sb.session as unknown as Internals;
};
const npcs = (s: Internals): string[] => s.live.active.filter((x) => x.startsWith("npc:"));
const setBond = (s: Internals, h: string, o: string, warmth: number, resentment = 0): void => { (s.live.bonds ??= {})[bondKey(h, o)] = { ...emptyBond(), warmth, resentment }; };
const mood = (s: Internals, id: string): number => s.house.npcs.find((x) => x.id === id)!.soul.emotionalState;

describe("the eviction vote, decision level", () => {
  it("a warm nominee draws fewer evict votes than a cold one, same seed", () => {
    const tally = (on: boolean): { warm: number; cold: number } => {
      const s = start(3, { on });
      s.rel.load([]); // strangers everywhere: the only difference is the feeling
      const [A, B, ...rest] = npcs(s);
      for (const voter of rest) setBond(s, voter!, A!, 0.9);
      const ctx = s.ctx() as unknown as Parameters<typeof voteChoice>[2];
      let warm = 0, cold = 0;
      for (const voter of rest) (voteChoice(voter!, [A!, B!], ctx) === A ? warm++ : cold++);
      return { warm, cold };
    };
    const off = tally(false), on = tally(true);
    expect(off.warm).toBeGreaterThan(0); // with no feeling the tie goes to the first nominee
    expect(on.warm).toBeLessThan(off.warm);
    expect(on.warm).toBeLessThan(on.cold);
  });
  it("the player is never held back by this", () => {
    const s = start(3);
    const [A] = npcs(s);
    setBond(s, "player", A!, 0.9);
    expect(s.feelingKeepOf(A!, "player")).toBe(0);
  });
});

describe("guilt in a played game", () => {
  it("a betrayer who truly liked the wronged is shaken once; a grudge-holder is not; no resentment moves", () => {
    const s = start(3);
    const [B, W, G] = npcs(s);
    setBond(s, B!, W!, 0.9); setBond(s, B!, G!, 0.9, 1);
    const bondsBefore = JSON.stringify(s.live.bonds);
    const m0 = mood(s, B!);
    const mem = s.house.npcs.find((x) => x.id === B)!.soul.memory.length;
    s.feelGuilt(B!, G!);
    expect(mood(s, B!)).toBe(m0);
    expect(s.live.feelingsSeen).toBeUndefined();
    s.feelGuilt(B!, W!);
    const m1 = mood(s, B!);
    expect(m1).toBeLessThan(m0);
    expect(s.live.feelingsSeen).toEqual([guiltKey(s.live.week, B!, W!)]);
    expect(s.house.npcs.find((x) => x.id === B)!.soul.memory.length).toBe(mem); // no recall filler
    s.feelGuilt(B!, W!);
    expect(mood(s, B!)).toBe(m1); // deduped
    const after = JSON.parse(JSON.stringify(s.live.bonds)) as Record<string, { resentment: number }>;
    const before = JSON.parse(bondsBefore) as Record<string, { resentment: number }>;
    for (const k of Object.keys(before)) expect(after[k]!.resentment).toBe(before[k]!.resentment);
  });
  it("a stronger feeling shakes harder", () => {
    const run = (w: number): number => { const s = start(3); const [B, W] = npcs(s); setBond(s, B!, W!, w); const m0 = mood(s, B!); s.feelGuilt(B!, W!); return m0 - mood(s, B!); };
    expect(run(0.9)).toBeGreaterThan(run(0.5));
    expect(run(0.5)).toBeGreaterThan(0);
  });
  it("the player is never the betrayer it acts on", () => {
    const s = start(3);
    const [W] = npcs(s);
    setBond(s, "player", W!, 0.9);
    const p0 = s.house.player.soul.emotionalState;
    s.feelGuilt("player", W!);
    expect(s.house.player.soul.emotionalState).toBe(p0);
    expect(s.live.feelingsSeen).toBeUndefined();
  });
  it("the dedupe survives a save and restore", () => {
    const s = start(3);
    const [B, W] = npcs(s);
    setBond(s, B!, W!, 0.9);
    s.feelGuilt(B!, W!);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const sb2 = new GameSessionRegistry().sandboxFor(`bf568-rt-${n++}`);
    sb2.session.restore(snap);
    const t = sb2.session as unknown as Internals;
    expect(t.live.feelingsSeen).toEqual(s.live.feelingsSeen);
    const m0 = mood(t, B!);
    t.feelGuilt(B!, W!);
    expect(mood(t, B!)).toBe(m0);
  });
  it("an eviction shakes the voters who truly liked the evictee, privately, and no one else", () => {
    const s = start(3);
    const [E, F, S, X] = npcs(s);
    setBond(s, F!, E!, 0.9); setBond(s, S!, E!, 0.9); // F voted to evict a friend; S liked them too but voted to keep
    s.live.voteRecord = [{ week: s.live.week, evictee: E!, voteOf: { [F!]: E!, [S!]: X!, [X!]: E! } }];
    const [f0, s0, x0] = [mood(s, F!), mood(s, S!), mood(s, X!)];
    s.evolveFromBeat({ beat: "eviction", content: "", participants: [E!] });
    expect(mood(s, F!)).toBeLessThan(f0);
    expect(mood(s, S!)).toBeLessThanOrEqual(s0); // spread by contagion only, never by guilt
    expect(s.live.feelingsSeen).toEqual([guiltKey(s.live.week, F!, E!)]);
    expect(mood(s, X!)).toBeLessThanOrEqual(x0);
  });
});

describe("flag off and headless are byte-identical", () => {
  it("the context carries no hook unless a played game has the flag on", () => {
    expect(start(3, { on: true }).ctx().feelingKeepFor).toBeTypeOf("function");
    expect(start(3, { on: false }).ctx().feelingKeepFor).toBeUndefined();
    expect(start(3, { on: true, played: false }).ctx().feelingKeepFor).toBeUndefined();
  });
  it("a headless game's snapshot is the same with the flag on or off, seeds 3 and 11", () => {
    const run = (seed: number, on: boolean): string => {
      const sb = new GameSessionRegistry().sandboxFor(`bf568-h-${n++}`);
      sb.session.setBondFeelingsEnabled(on);
      sb.session.createCharacter({ playerName: "The Player", seed });
      sb.session.advanceGame({});
      sb.session.advanceGame({});
      return JSON.stringify(sb.session.snapshot());
    };
    for (const seed of [3, 11]) expect(run(seed, true)).toBe(run(seed, false));
  });
  it("the alliance-break draw keeps its own key; only the threshold takes the feeling", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect(src.match(/alliance-clash:\$\{al\.id\}:\$\{m\}:\$\{day\}/g)?.length).toBe(1);
    expect(src).toContain('ALLIANCE.goalClashBreak / this.cultureMult("loyalty") / hold');
  });
});

describe("the wall: no feeling, guilt or hesitation on any outward surface", () => {
  it("projections, the moment prompt and the admin view carry none", async () => {
    const sb = new GameSessionRegistry().sandboxFor(`bf568-wall-${n++}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 21 });
    sb.session.noteMessage({ messageId: "w0" });
    const s = sb.session as unknown as Internals;
    const [B, W] = npcs(s);
    setBond(s, B!, W!, 0.9);
    s.feelGuilt(B!, W!);
    expect(s.live.feelingsSeen?.length).toBe(1);
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {}), npcs(s).map((id) => s.npcVoice(id)),
    ];
    const blob = JSON.stringify(surfaces).toLowerCase();
    for (const k of ["feelingsseen", "hesitation", "guilt", "jealousy", "warmth", "feelingkeep", "feelingpush"]) expect(blob.includes(k), `a live surface carries ${k}`).toBe(false);
  });
});
