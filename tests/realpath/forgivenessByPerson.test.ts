import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { forgivenessTraitFor, applyForgiveness } from "../../src/engine/forgiveness";
import { FORGIVENESS } from "../../src/engine/forgivenessConstants";
import type { MemoryEntry } from "../../src/engine/npcMemory";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-130 / ORW-507 - forgiveness by person, REAL PATH. A season is played to week 2 through the player's levers only, then the player turns on each houseguest in
 * turn (their own `recordInteraction` scenes), so every houseguest holds a betrayal the engine itself wrote, about the player and any about each other (by week 3 the
 * house had remembered no betrayal among themselves in this seed, so the player supplies them; half of them first get three kind scenes from the player, since
 * a history of favors is part of the rule). For EVERY holder and subject with a remembered betrayal, the entries the session reads are exactly the pure rule
 * applied to that holder's REAL style, their soul's volatility and their bond to THAT subject (so the session reads the right trait and the right relationship);
 * the same kind of record is held by some holders and forgiven by others; with the layer off the ledger is read as it stands. Seed 7 (the unit rig's seed). Roles only.
 */
type Rig = {
  live: { week: number; npcMemory?: Record<string, Record<string, MemoryEntry[]>> };
  house: { npcs: Array<{ id: string; character: { strategyStyle?: string } }> };
  soulObj(id: string): { volatility: number } | undefined;
  rel: { bondStrength(a: string, b: string): number };
  memoryEntriesSeenBy(holder: string, entries: readonly MemoryEntry[] | undefined, subject: string): readonly MemoryEntry[] | undefined;
  setForgivenessEnabled(on: boolean): void;
};

describe("ORW-130 REAL PATH: who holds a betrayal is read from the holder and the relationship", () => {
  it("every remembered betrayal is read through the holder's own style, volatility and bond to that subject; some hold, some forgive; off reads the ledger raw", async () => {
    // ORW-880: the first seed from 7 that reaches week 2 (the claims below are the feature's own, so the precondition is only the stop)
    const { at: g } = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      g.playUntil(() => (g.s.getGameState() as { week?: number }).week! >= 2 && !g.s.getGameState().pending, 5000, "week 2");
      return g;
    }, { from: 1, to: 12, hint: 7, sandbox: (s) => `forg-real-${s}`, what: "week 2" });
    // the player turns on each houseguest in turn (their own recorded scenes); each houseguest's memory of it is the engine's own write
    // half of them first get the player's kindness (a history of favors is part of the rule), then the player turns on every one of them
    const npcs = g.s.livingIds().filter((id) => id !== PLAYER);
    for (const [i, npc] of npcs.entries()) if (i % 2 === 0) for (let k = 0; k < 3; k++) await g.sb.mcp.player.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, npc], content: "the player has their back", kind: "bonding" });
    for (const npc of npcs) await g.sb.mcp.player.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, npc], content: "the player sells them out", kind: "betrayal" });
    const r = g.s as unknown as Rig;
    const mem = r.live.npcMemory ?? {};
    const pairs: Array<{ holder: string; subject: string; raw: MemoryEntry[] }> = [];
    for (const [holder, row] of Object.entries(mem)) for (const [subject, raw] of Object.entries(row)) {
      if (holder === PLAYER) continue;
      if (raw.some((e) => FORGIVENESS.betrayalKinds.includes(e.kind))) pairs.push({ holder, subject, raw });
    }
    expect(pairs.length, "the house remembers the betrayals").toBeGreaterThan(3);
    const traits = new Set<string>();
    r.setForgivenessEnabled(true);
    for (const p of pairs) {
      const style = r.house.npcs.find((n) => n.id === p.holder)?.character.strategyStyle;
      const trait = forgivenessTraitFor(p.raw, { ...(style !== undefined ? { style } : {}), volatility: r.soulObj(p.holder)?.volatility ?? 0.5, closeness: r.rel.bondStrength(p.holder, p.subject) });
      traits.add(trait);
      expect(r.memoryEntriesSeenBy(p.holder, p.raw, p.subject)).toEqual(applyForgiveness(p.raw, trait, r.live.week));
    }
    expect([...traits].sort(), "the same kind of record is held by some holders and forgiven by others").toEqual(["grudge-keeper", "typical"]);
    // not as shipped: the control arm, the same seed with this feature off, proves the feature is what makes the difference
    r.setForgivenessEnabled(false);
    for (const p of pairs) expect(r.memoryEntriesSeenBy(p.holder, p.raw, p.subject)).toBe(p.raw);
  }, 300_000);
});
