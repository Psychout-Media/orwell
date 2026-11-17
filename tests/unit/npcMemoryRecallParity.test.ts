import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { recordMemory, memoryTiltStandalone, NPC_MEMORY, PLAYED_NPC_MEMORY, type NpcMemoryLedger, type MemoryEntry } from "../../src/engine/npcMemory";

/** ORW-575 + ORW-616 (2). Roles only. */
const sev = (l: NpcMemoryLedger) => (l["holder"]?.["subject"] ?? []).map((e) => ({ kind: e.kind, severity: e.severity }));

describe("the six-per-pair cap", () => {
  const fill = (protect: boolean): NpcMemoryLedger => {
    const l: NpcMemoryLedger = {};
    recordMemory(l, "holder", "subject", { kind: "scene-betrayal", week: 1, severity: 0.6 }, NPC_MEMORY, protect);
    for (let i = 0; i < 6; i++) recordMemory(l, "holder", "subject", { kind: "scene-conflict", week: 14 + i, severity: 0.3 }, NPC_MEMORY, protect);
    return l;
  };
  it("played games: a long-ago betrayal is never the entry dropped for trivial newer ones", () => {
    const l = fill(true);
    expect(sev(l)).toHaveLength(6);
    expect(sev(l).some((e) => e.kind === "scene-betrayal" && e.severity === 0.6)).toBe(true);
  });
  it("headless: the old rule is unchanged (the decayed-weakest drops)", () => {
    expect(sev(fill(false)).some((e) => e.kind === "scene-betrayal")).toBe(false);
  });
  it("the strongest favor is kept too, and the cap still holds", () => {
    const l: NpcMemoryLedger = {};
    recordMemory(l, "holder", "subject", { kind: "deal-kept", week: 1, severity: 0.5 }, NPC_MEMORY, true);
    for (let i = 0; i < 9; i++) recordMemory(l, "holder", "subject", { kind: "scene-conflict", week: 9 + i, severity: 0.1 }, NPC_MEMORY, true);
    expect(sev(l)).toHaveLength(6);
    expect(sev(l).some((e) => e.kind === "deal-kept")).toBe(true);
  });
});

describe("a remembered favor weighs like a remembered wrong, and fades", () => {
  const favor: MemoryEntry[] = [{ kind: "deal-kept", week: 1, severity: 0.5 }];
  const wrong: MemoryEntry[] = [{ kind: "deal-broken", week: 1, severity: 0.5 }];
  it("played constants make the two equal and opposite; headless keeps the favor weaker", () => {
    expect(memoryTiltStandalone(favor, 1, 1, PLAYED_NPC_MEMORY)).toBeCloseTo(-memoryTiltStandalone(wrong, 1, 1, PLAYED_NPC_MEMORY), 12);
    expect(Math.abs(memoryTiltStandalone(favor, 1, 1))).toBeLessThan(Math.abs(memoryTiltStandalone(wrong, 1, 1)));
  });
  it("it decays and stays bounded", () => {
    const now = Math.abs(memoryTiltStandalone(favor, 1, 1, PLAYED_NPC_MEMORY));
    const later = Math.abs(memoryTiltStandalone(favor, 9, 1, PLAYED_NPC_MEMORY));
    expect(now).toBeGreaterThan(0);
    expect(later).toBeLessThan(now / 3);
    expect(now).toBeLessThanOrEqual(PLAYED_NPC_MEMORY.grudgeMax);
  });
});

type Internals = { live: { active: string[]; playedGame?: boolean; npcMemory?: Record<string, Record<string, MemoryEntry[]>> } };
function start(n: string, played: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`o575-${n}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 3 });
  const s = sb.session as unknown as Internals;
  s.live.playedGame = played;
  const [A, B] = s.live.active.filter((x) => x.startsWith("npc:")) as [string, string];
  const mem = (h: string, subj: string) => (s.live.npcMemory?.[h]?.[subj] ?? []).map((e) => ({ kind: e.kind, severity: e.severity }));
  const ses = sb.session as unknown as { recordOffscreenScene(i: string, p: string, t: string): void };
  return { sb, s, A, B, mem, ses };
}

describe("a scene between houseguests is remembered like one involving the player", () => {
  for (const kind of ["betrayal", "conflict", "bonding"]) {
    it(`${kind}: same memory kind and severity, roles substituted`, () => {
      const p = start(`p-${kind}`, true), n = start(`n-${kind}`, true);
      p.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, p.A], toward: [p.A], content: "a scene", kind } as never);
      n.ses.recordOffscreenScene(n.B, n.A, kind);
      expect(n.mem(n.A, n.B)).toEqual(p.mem(p.A, PLAYER));
      expect(n.mem(n.A, n.B)).not.toEqual([]);
      expect(n.mem(n.B, n.A)).toEqual([]); // the actor is not wronged
    });
  }
  it("a headless game (not played) writes nothing new", () => {
    const g = start("h", false);
    g.ses.recordOffscreenScene(g.B, g.A, "betrayal");
    expect(g.mem(g.A, g.B)).toEqual([]);
  });
  it("the wall: no memory or salience field reaches the player's view", () => {
    const g = start("w", true);
    g.ses.recordOffscreenScene(g.B, g.A, "betrayal");
    const view = JSON.stringify(g.sb.session.getGameState());
    expect(view).not.toMatch(/npcMemory|scene-betrayal|salience|severity/);
  });
});
