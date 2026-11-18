import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { memoryTiltStandalone, SCENE_MEMORY_SEVERITY, SCENE_MEMORY_SEVERITY_MORE } from "../../src/engine/npcMemory";

/**
 * ORW-614 (P-11): flirt, strategy and gossip scenes move a houseguest's mood and memory, for a scene the player is in and for one between houseguests, through ONE table. Roles only.
 */
type Sb = ReturnType<GameSessionRegistry["sandboxFor"]>;
function started(played: boolean, on = true) {
  const sb = new GameSessionRegistry().sandboxFor(`p614-${played}-${on}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  if (played) sb.session.noteMessage({ messageId: "m1" });
  (sb.session as unknown as { setPlayerSceneMovesEnabled(o: boolean): void }).setPlayerSceneMovesEnabled(on);
  const [a, b] = [...sb.session.livingIds()].filter((id) => id !== PLAYER);
  (sb.session as unknown as { presence: Map<string, string> }).presence = new Map([[PLAYER, "kitchen"], [a!, "kitchen"]]);
  return { sb, a: a!, b: b! };
}
const ledger = (sb: Sb) => (sb.session.snapshot().live?.npcMemory ?? {}) as Record<string, Record<string, { kind: string; severity: number; week: number }[]>>;
const moodMoves = (sb: Sb, id: string) => ((sb.session as unknown as { soulObj(i: string): { emotionalHistory: unknown[] } | undefined }).soulObj(id))?.emotionalHistory?.length ?? 0;
const rec = (e: ReturnType<typeof started>, kind: string) => e.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, e.a], content: `a ${kind} scene`, kind: kind as never });

describe("ORW-614 P-11: more scene kinds move memory and mood", () => {
  it("a flirt and a strategy scene with the player are remembered as a small warmth (smaller than bonding)", () => {
    for (const kind of ["showmance", "strategy"]) {
      const e = started(true); rec(e, kind);
      const list = ledger(e.sb)[e.a]?.[PLAYER] ?? [];
      expect(list.map((m) => m.kind), kind).toEqual(["scene-kindness"]);
      expect(list[0]!.severity).toBeLessThan(SCENE_MEMORY_SEVERITY["bonding"]!.severity);
      expect(memoryTiltStandalone(list as never, list[0]!.week, 1)).toBeLessThan(0);
    }
  });
  it("parity: the same kind between two houseguests writes the same memory through the same table", () => {
    const e = started(true);
    const sess = e.sb.session as unknown as { recordOffscreenScene(i: string, p: string, t: string): void };
    sess.recordOffscreenScene(e.b, e.a, "showmance");
    const npcSide = ledger(e.sb)[e.a]?.[e.b] ?? [];
    expect(npcSide.map((m) => [m.kind, m.severity])).toEqual([[SCENE_MEMORY_SEVERITY_MORE["showmance"]!.kind, SCENE_MEMORY_SEVERITY_MORE["showmance"]!.severity]]);
    rec(e, "showmance");
    expect((ledger(e.sb)[e.a]?.[PLAYER] ?? [])[0]!.severity).toBe(npcSide[0]!.severity);
  });
  it("a gossip scene writes no memory but moves the mood of the houseguest it touched; bounded and deterministic", () => {
    const e = started(true); const before = moodMoves(e.sb, e.a);
    rec(e, "gossip");
    expect(ledger(e.sb)[e.a]?.[PLAYER] ?? []).toEqual([]);
    expect(moodMoves(e.sb, e.a)).toBeGreaterThan(before);
    const f = started(true); rec(f, "gossip");
    expect(moodMoves(f.sb, f.a)).toBe(moodMoves(e.sb, e.a));
  });
  it("flag off, or a game nobody is playing: today's behaviour (no memory, no mood move)", () => {
    for (const e of [started(true, false), started(false, true)]) {
      const before = moodMoves(e.sb, e.a);
      rec(e, "showmance"); rec(e, "gossip");
      expect(ledger(e.sb)[e.a]?.[PLAYER] ?? []).toEqual([]);
      expect(moodMoves(e.sb, e.a)).toBe(before);
    }
  });
  it("persistence: the new entries round-trip through a save and only add to the ledger (superset)", () => {
    const e = started(true); rec(e, "strategy");
    const before = JSON.stringify(ledger(e.sb));
    const snap = JSON.parse(JSON.stringify(e.sb.session.snapshot()));
    expect(JSON.stringify(snap.live.npcMemory)).toBe(before);
  });
});
