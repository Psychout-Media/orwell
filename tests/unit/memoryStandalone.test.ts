import { describe, it, expect, afterEach, vi } from "vitest";
import { memoryTilt, memoryTiltStandalone, NPC_MEMORY, type MemoryEntry } from "../../src/engine/npcMemory";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { SessionCore } from "../../src/engine/sessionSnapshot";

/**
 * B2 / #2017 (PO 2026-11-03: "memories must VISIBLY sway decisions"). The 0024 residual-floor tilt subtracts what the relationship edge still carries, and inside a season the
 * edge carries a fresh betrayal — so the memory term measured exactly 0 on every read. `ORWELL_NPC_MEMORY_STANDALONE` (default OFF, never-flipped) reads the memory ON ITS OWN:
 * a grudge outlives the edge's decay, a favor is repaid because it is remembered. OFF is byte-identical. Roles only.
 */
const BETRAYAL: MemoryEntry = { kind: "nominated-by-friend", week: 2, severity: 1 };
const FAVOR: MemoryEntry = { kind: "veto-saved", week: 2, severity: 1 };
const FULL_CARRY = { threatAboveBaseline: 1, bondAboveNeutral: 1 }; // the edge "already carries" everything (the in-season situation)

describe("memoryTiltStandalone — the memory read on its own", () => {
  it("the residual floor is exactly 0 when the edge carries the memory; the standalone read is not (the PO's 'visible sway')", () => {
    expect(memoryTilt([BETRAYAL], 3, 1, FULL_CARRY)).toBe(0);
    expect(memoryTilt([FAVOR], 3, 1, FULL_CARRY)).toBe(0);
    expect(memoryTiltStandalone([BETRAYAL], 3, 1)).toBeGreaterThan(0);
    expect(memoryTiltStandalone([FAVOR], 3, 1)).toBeLessThan(0);
  });
  it("signed direction: a remembered betrayal raises the odds against the subject, a favor lowers them, nothing remembered = 0", () => {
    expect(memoryTiltStandalone(undefined, 3, 1)).toBe(0);
    expect(memoryTiltStandalone([], 3, 1)).toBe(0);
    expect(memoryTiltStandalone([BETRAYAL, FAVOR], 3, 1)).toBeLessThan(memoryTiltStandalone([BETRAYAL], 3, 1));
  });
  it("is bounded by the existing grudge/favor maxima (a remembered betrayal never exceeds grudgeMax)", () => {
    expect(memoryTiltStandalone([BETRAYAL, BETRAYAL, BETRAYAL], 2, 1)).toBeLessThanOrEqual(NPC_MEMORY.grudgeMax + 1e-9);
    expect(memoryTiltStandalone([FAVOR, FAVOR], 2, 1)).toBeGreaterThanOrEqual(-NPC_MEMORY.favorMax - 1e-9);
  });
  it("a grudge fades with the holder's own temperament (decayScale) exactly like the floor does", () => {
    expect(memoryTiltStandalone([BETRAYAL], 10, 2)).toBeLessThan(memoryTiltStandalone([BETRAYAL], 10, 0.5));
  });
});

describe("the adapter: two NPCs with IDENTICAL edges but different remembered histories decide differently (flag ON), identically (flag OFF)", () => {
  afterEach(() => vi.unstubAllEnvs());
  function setup(): { tilt: (subject: string, holder: string) => number; a: string; b: string; subject: string; session: ReturnType<GameSessionRegistry["sandboxFor"]>["session"] } {
    const session = new GameSessionRegistry().sandboxFor("b2").session;
    session.createCharacter({ playerName: "P", seed: 5 });
    session.advanceGame(); session.advanceGame();
    const core = JSON.parse(JSON.stringify(session.snapshot())) as SessionCore;
    const live = core.live!;
    const npcs = live.active.filter((h) => h !== PLAYER);
    const [a, b, subject] = [npcs[0]!, npcs[1]!, npcs[2]!];
    live.npcMemory = { [a]: { [subject]: [{ kind: "nominated-by-friend", week: live.week, severity: 1 }] } }; // `a` remembers a betrayal by `subject`; `b` remembers nothing
    session.restore(core);
    return { tilt: (s, h) => (session as unknown as { memoryTiltFor(s: string, h: string): number }).memoryTiltFor(s, h), a, b, subject, session };
  }
  it("OFF: the residual floor — never MORE than the standalone read (the edge carry only subtracts), and a holder with no memory reads 0", () => {
    const { tilt, a, b, subject, session } = setup();
    const off = tilt(subject, a);
    expect(tilt(subject, b)).toBe(0);
    (session as unknown as { setNpcMemoryStandaloneEnabled(on: boolean): void }).setNpcMemoryStandaloneEnabled(true);
    expect(tilt(subject, a)).toBeGreaterThanOrEqual(off);
    (session as unknown as { setNpcMemoryStandaloneEnabled(on: boolean): void }).setNpcMemoryStandaloneEnabled(false);
    expect(tilt(subject, a), "turning it back OFF restores the residual-floor read exactly").toBe(off);
  });
  it("ON: the holder with the remembered betrayal tilts against the subject; the one without does not", () => {
    const { tilt, a, b, subject, session } = setup();
    (session as unknown as { setNpcMemoryStandaloneEnabled(on: boolean): void }).setNpcMemoryStandaloneEnabled(true);
    expect(tilt(subject, a)).toBeGreaterThan(tilt(subject, b));
    expect(tilt(subject, b)).toBe(0);
  });
});
