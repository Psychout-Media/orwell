import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { GameSessionRegistry } from "../../src/composition/registry";
import { jealousyKey } from "../../src/engine/bondJealousy";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-568 / spec 0181 part 2: jealousy and divided loyalty, REAL PATH. A season is played through the player's levers only, so every bond, every scene and every
 * nightly tick is the house's own. Played until the first night a houseguest grows jealous: the holder is close to the friend they watched, the friend spent their
 * time with the rival in scenes the holder saw, the player is never a holder, and the mood hit is once per holder, rival and week. The record survives a save and
 * load. With the layer off, the same seed played the same number of turns grows no jealousy. Divided loyalty: some houseguest in the played house reads a split
 * (close to both of a fallen-out pair), and the player never does.
 * The seed is the first in 1..12 (ORW-880: firstSeedWhere) whose game reaches a jealous night: the player must still be in the house when it comes (the nightly tick
 * runs at the player's own bedtime, so a season the player has left early grows none). The sandbox name is part of the game's identity: `pj-<seed>`. Roles only.
 */
type Live = { week: number; jealousy?: Record<string, { value: number; week: number; close: string }>; jealousySeen?: string[]; jealousyCursor?: number; active: string[] };
type Priv = { live: Live; bondReader(): { bond(h: string, o: string): { warmth: number } }; splitOf(h: string, o: string): number; feelingKeepOf(o: string, h: string): number };
const jealous = (s: unknown): Array<[string, { value: number; week: number; close: string }]> => Object.entries((s as Priv).live.jealousy ?? {}).filter(([, v]) => v.value > 0);

describe("0181 REAL PATH: jealousy grows from what the holder watched, in a played house", () => {
  it("the first jealous night: a close holder, a friend seen with the rival, never the player; once-a-week mood; survives a save; off grows none", () => {
    const { seed, sandbox, at: { g, turns } } = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      return { g, turns: g.playUntil(() => jealous(g.s).length > 0, 8000, "a jealous night") };
    }, { from: 1, to: 12, hint: 3, sandbox: (s) => `pj-${s}`, what: "a jealous night" });
    const p = g.s as unknown as Priv;
    const rows = jealous(g.s);
    const events = g.sb.engine.events.queryAll() as unknown as Array<{ type: string; initiator: string; witnessSet: string[]; houseLife?: { seenBy?: string[] } }>;
    for (const [key, row] of rows) {
      const [holder, rival] = key.split("|") as [string, string];
      expect(key).toBe(jealousyKey(holder, rival));
      expect(holder).not.toBe(PLAYER);
      const warmth = (o: string): number => p.bondReader().bond(holder, o).warmth; // the bond record the tick reads (a view: it folds nothing)
      expect(warmth(row.close), "the holder is warmer to the friend than to the rival").toBeGreaterThan(warmth(rival));
      const sawThem = events.some((e) => e.witnessSet.includes(row.close) && e.witnessSet.includes(rival) && !e.witnessSet.includes(holder) && (e.houseLife?.seenBy ?? []).includes(holder));
      expect(sawThem, "the holder watched the friend with the rival").toBe(true);
    }
    const seen = p.live.jealousySeen ?? [];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(0);
    const save = JSON.parse(JSON.stringify(g.s.snapshot()));
    const loaded = new GameSessionRegistry().sandboxFor("bj-real-load").session;
    loaded.restore(save);
    expect((loaded as unknown as Priv).live.jealousy).toEqual(p.live.jealousy);
    expect((loaded as unknown as Priv).live.jealousySeen).toEqual(p.live.jealousySeen);

    // not as shipped: the control arm, the same seed with this feature off, proves the feature is what makes the difference
    const off = playedGame({ seed, user: sandbox, before: (s) => s.setBondFeelingsEnabled(false) });
    for (let i = 0; i < turns; i++) off.turn();
    expect((off.s as unknown as Priv).live.jealousy).toBeUndefined();
  }, 300_000);

  it("divided loyalty: some houseguest in a played house is split between a fallen-out pair; the player never is", () => {
    const anySplit = (p: Priv, ids: string[]): boolean => ids.some((h) => ids.some((o) => o !== h && p.splitOf(h, o) > 0));
    const { at: g } = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      g.playUntil(() => anySplit(g.s as unknown as Priv, g.s.livingIds().filter((i) => i !== PLAYER)), 8000, "a split loyalty");
      return g;
    }, { from: 1, to: 12, hint: 3, sandbox: (s) => `bj-real-split-${s}`, what: "a split loyalty" });
    const p = g.s as unknown as Priv;
    for (const o of g.s.livingIds()) if (o !== PLAYER) expect(p.splitOf(PLAYER, o)).toBe(0);
  }, 300_000);
});
