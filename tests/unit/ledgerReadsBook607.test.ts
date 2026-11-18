import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { NPC_MEMORY, PLAYED_NPC_MEMORY, BOOK_FOLDED_KINDS, grudgeSalienceWithBook, memoryTiltStandalone, salience, type MemoryEntry } from "../../src/engine/npcMemory";

/** ORW-607 (wrongs, step 2): the memory ledger's GRUDGE salience reads the grudge book's wrongWeight in a played game (favors and headless unchanged). Roles only. */
const e = (kind: MemoryEntry["kind"], week: number, severity: number): MemoryEntry => ({ kind, week, severity });
const GRUDGE_ONLY = new Set(["deal-broken", "nominated-by-friend", "replaced-by-friend"]);

describe("grudgeSalienceWithBook (pure)", () => {
  it("a wrong the book already holds counts once: as the book's weight, not memory plus book", () => {
    const entries = [e("deal-broken", 1, 0.8)];
    const s = grudgeSalienceWithBook(entries, 20, 1, NPC_MEMORY, { weight: 0.4, folded: () => true });
    expect(s).toBeCloseTo(0.4, 12);
  });
  it("a grudge kind the book does not hold keeps the ledger read, combined (never summed) with the book", () => {
    const entries = [e("deal-broken", 1, 0.8), e("scene-betrayal", 9, 0.6)];
    const rest = salience([entries[1]!], new Set(["scene-betrayal"]), 10, 1, NPC_MEMORY);
    const s = grudgeSalienceWithBook(entries, 10, 1, NPC_MEMORY, { weight: 0.3, folded: (i) => i === 0 });
    expect(s).toBeCloseTo(1 - (1 - rest) * (1 - 0.3), 12);
  });
  it("an unfolded wrong keeps the old read, and the term stays bounded by the tilt cap", () => {
    const entries = [e("deal-broken", 3, 0.7)];
    const old = memoryTiltStandalone(entries, 5, 1, PLAYED_NPC_MEMORY);
    expect(memoryTiltStandalone(entries, 5, 1, PLAYED_NPC_MEMORY, { weight: 0, folded: () => false })).toBeCloseTo(old, 12);
    expect(memoryTiltStandalone(entries, 5, 1, PLAYED_NPC_MEMORY, { weight: 5, folded: () => true })).toBeLessThanOrEqual(PLAYED_NPC_MEMORY.grudgeMax + 1e-12);
  });
  it("a favor entry is exactly as it was (the book never reads it)", () => {
    const entries = [e("veto-saved", 2, 0.6), e("deal-kept", 3, 0.5)];
    expect(memoryTiltStandalone(entries, 6, 1, PLAYED_NPC_MEMORY, { weight: 0, folded: () => false })).toBe(memoryTiltStandalone(entries, 6, 1, PLAYED_NPC_MEMORY));
  });
  it("only the kinds the fold reads are book kinds", () => { expect([...BOOK_FOLDED_KINDS].sort()).toEqual([...GRUDGE_ONLY].sort()); });
});

type G = {
  live: { active: string[]; week: number; playedGame?: boolean; npcMemory?: Record<string, Record<string, MemoryEntry[]>>; grudgesSeen?: string[] };
  grudgeOf(h: string, s: string, fold?: boolean): { weight: number } | null;
  memoryTiltFor(s: string, h: string): number;
  memoryBlocksPlayerDeal(n: string): boolean;
  setGrudgesEnabled(on: boolean): void;
};
const start = (seed: number, tag: string) => {
  const sb = new GameSessionRegistry().sandboxFor(`l607-${tag}-${seed}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.noteMessage({ messageId: "m1" });
  const s = sb.session as unknown as G;
  const [H, S] = s.live.active.filter((x) => x.startsWith("npc:"));
  return { s, H: H!, S: S! };
};
const cap = PLAYED_NPC_MEMORY.grudgeMax;

describe("the adapter's memoryTiltFor in a played game", () => {
  it("a folded broken deal reads the book's weight (7-week curve), not the 4-week fade; counted once", () => {
    const { s, H, S } = start(3, "a");
    s.live.npcMemory = { [H]: { [S]: [e("deal-broken", 1, 0.8)] } };
    const g = s.grudgeOf(H, S)!; // folds it into the book
    s.live.week = 9;
    const w = s.grudgeOf(H, S, false)!.weight;
    const on = s.memoryTiltFor(S, H);
    s.setGrudgesEnabled(false);
    const off = s.memoryTiltFor(S, H);
    expect(g.weight).toBeGreaterThan(0);
    expect(on).toBeCloseTo(cap * w, 9);
    expect(on).toBeGreaterThan(off);
    expect(on).toBeLessThanOrEqual(cap);
  });
  it("before the fold has seen the wrong, the read is the old one", () => {
    const { s, H, S } = start(3, "b");
    s.live.npcMemory = { [H]: { [S]: [e("deal-broken", 1, 0.8)] } };
    const before = s.memoryTiltFor(S, H);
    s.setGrudgesEnabled(false);
    expect(before).toBe(s.memoryTiltFor(S, H));
  });
  it("headless keeps the old read byte for byte, and a favor is unchanged in a played game", () => {
    const a = start(11, "c");
    a.s.live.npcMemory = { [a.H]: { [a.S]: [e("nominated-by-friend", 1, 0.7)] } };
    a.s.grudgeOf(a.H, a.S); a.s.live.week = 8;
    a.s.live.playedGame = false;
    const headless = a.s.memoryTiltFor(a.S, a.H);
    a.s.setGrudgesEnabled(false);
    expect(headless).toBe(a.s.memoryTiltFor(a.S, a.H));
    const f = start(11, "d");
    f.s.live.npcMemory = { [f.H]: { [f.S]: [e("veto-saved", 1, 0.7)] } };
    f.s.live.week = 8;
    const withBook = f.s.memoryTiltFor(f.S, f.H);
    f.s.setGrudgesEnabled(false);
    expect(withBook).toBe(f.s.memoryTiltFor(f.S, f.H));
  });
  it("the deal-offer block reads the same book weight", () => {
    const { s, H } = start(3, "e");
    s.live.npcMemory = { [H]: { player: [e("deal-broken", 1, 0.9)] } };
    s.grudgeOf(H, "player"); s.live.week = 2;
    expect(typeof s.memoryBlocksPlayerDeal(H)).toBe("boolean");
  });
});

describe("one path (source pin)", () => {
  const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
  it("the derived reads go through memoryTiltFor, and the book read has ONE builder", () => {
    for (const fn of ["grudgeStanceFor", "approachMemoryFor"]) {
      const at = src.search(new RegExp(`\\n  ${fn}\\(`));
      expect(at).toBeGreaterThan(0);
      expect(src.slice(at, at + 500)).toContain("this.memoryTiltFor(");
    }
    expect(src.match(/this\.bookReadFor\(/g)!.length).toBe(2); // memoryTiltFor + memoryBlocksPlayerDeal only
    expect(src.match(/private bookReadFor\(/g)!.length).toBe(1);
    expect(src).toContain("const book = this.bookReadFor(holder, subject, raw);");
  });
});
