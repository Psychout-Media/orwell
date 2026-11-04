import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { memoryTiltStandalone, NPC_MEMORY } from "../../src/engine/npcMemory";

/**
 * P4g (PO: Ryne 2026-11-04) - a recorded PLAYER scene of kind betrayal / conflict writes a GRUDGE memory for the wronged NPC, and a kind scene (bonding / alliance) writes a FAVOR
 * memory, through the existing 0024 ledger: bounded, deterministic, one write per recorded scene (idempotent). Strategy / gossip / showmance chatter writes none. Roles only.
 */
function started(seed = 7) {
  const sb = new GameSessionRegistry().sandboxFor(`scene-mem-${seed}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  const npc = [...sb.session.livingIds()].find((id) => id !== PLAYER)!;
  (sb.session as unknown as { presence: Map<string, string> }).presence = new Map([[PLAYER, "kitchen"], [npc, "kitchen"]]); // seat them together so the scene is grounded (co-presence)
  return { sb, npc };
}
const ledger = (s: ReturnType<typeof started>["sb"]["session"]) => (s.snapshot().live?.npcMemory ?? {}) as Record<string, Record<string, { kind: string; severity: number; week: number }[]>>;
const rec = (e: ReturnType<typeof started>, kind: string, extra: object = {}) =>
  e.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: `a ${kind} scene`, kind: kind as never, ...extra });

describe("a recorded scene writes a memory for the NPC it touched", () => {
  it("betrayal => a grudge memory (holder = the wronged NPC, subject = the player)", () => {
    const e = started(); rec(e, "betrayal");
    const list = ledger(e.sb.session)[e.npc]?.[PLAYER] ?? [];
    expect(list.map((m) => m.kind)).toEqual(["scene-betrayal"]);
    expect(list[0]!.severity).toBeGreaterThan(0.4);
    expect(memoryTiltStandalone(list as never, list[0]!.week, 1)).toBeGreaterThan(0); // it sways a decision against the player
  });
  it("conflict => a smaller grudge than a betrayal", () => {
    const a = started(); rec(a, "conflict");
    const b = started(); rec(b, "betrayal");
    expect(ledger(a.sb.session)[a.npc]![PLAYER]![0]!.severity).toBeLessThan(ledger(b.sb.session)[b.npc]![PLAYER]![0]!.severity);
    expect(ledger(a.sb.session)[a.npc]![PLAYER]![0]!.kind).toBe("scene-conflict");
  });
  it("bonding (a kindness / favor) => a favor memory, weaker than the grudges (negativity bias)", () => {
    const e = started(); rec(e, "bonding");
    const list = ledger(e.sb.session)[e.npc]![PLAYER]!;
    expect(list.map((m) => m.kind)).toEqual(["scene-kindness"]);
    expect(memoryTiltStandalone(list as never, list[0]!.week, 1)).toBeLessThan(0); // warmer toward the player
  });
  it("strategy / gossip chatter writes no memory", () => {
    const e = started(); rec(e, "strategy"); rec(e, "gossip");
    expect(ledger(e.sb.session)[e.npc]?.[PLAYER] ?? []).toEqual([]);
  });
  it("one write per recorded scene: an idempotent retry does not double-write", () => {
    const e = started(); rec(e, "betrayal", { idempotencyKey: "k1" }); rec(e, "betrayal", { idempotencyKey: "k1" });
    expect(ledger(e.sb.session)[e.npc]![PLAYER]!.length).toBe(1);
  });
  it("is bounded by the ledger's per-pair cap however many scenes", () => {
    const e = started(); for (let i = 0; i < 20; i++) rec(e, "betrayal");
    expect(ledger(e.sb.session)[e.npc]![PLAYER]!.length).toBeLessThanOrEqual(NPC_MEMORY.maxEntriesPerPair);
  });
  it("is deterministic: the same seed + scenes => the same ledger", () => {
    const a = started(7); rec(a, "betrayal"); const b = started(7); rec(b, "betrayal");
    expect(JSON.stringify(ledger(a.sb.session))).toBe(JSON.stringify(ledger(b.sb.session)));
  });
  it("writes nothing when the memory writers are off (opt-out) - byte-identical ledger", () => {
    const e = started(); e.sb.session.setNpcMemoryWritersEnabled(false); rec(e, "betrayal");
    expect(ledger(e.sb.session)[e.npc]?.[PLAYER] ?? []).toEqual([]);
  });
});
