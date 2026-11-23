import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { GameSessionRegistry } from "../../src/composition/registry";
import { jealousyKey } from "../../src/engine/bondJealousy";
import { playedGame } from "../support/playedGame";

/**
 * ORW-568 / spec 0181 part 2: jealousy and divided loyalty, REAL PATH. A season is played through the player's levers only, so every bond, every scene and every
 * nightly tick is the house's own. Played until the first night a houseguest grows jealous: the holder is close to the friend they watched, the friend spent their
 * time with the rival in scenes the holder saw, the player is never a holder, and the mood hit is once per holder, rival and week. The record survives a save and
 * load. With the layer off, the same seed played the same number of turns grows no jealousy. Divided loyalty: some houseguest in the played house reads a split
 * (close to both of a fallen-out pair), and the player never does.
 * Seed 3 (the unit tests' seed) in the sandbox "pj": the sandbox name is part of the game's identity, and in this one the player is still in the house when the
 * first jealous night comes (the nightly tick runs at the player's own bedtime, so a season the player has left early grows none). Roles only.
 */
type Live = { week: number; jealousy?: Record<string, { value: number; week: number; close: string }>; jealousySeen?: string[]; jealousyCursor?: number; active: string[] };
type Priv = { live: Live; bondReader(): { bond(h: string, o: string): { warmth: number } }; splitOf(h: string, o: string): number; feelingKeepOf(o: string, h: string): number };
const SEED = 3;
const jealous = (s: unknown): Array<[string, { value: number; week: number; close: string }]> => Object.entries((s as Priv).live.jealousy ?? {}).filter(([, v]) => v.value > 0);

describe("0181 REAL PATH: jealousy grows from what the holder watched, in a played house", () => {
  it("the first jealous night: a close holder, a friend seen with the rival, never the player; once-a-week mood; survives a save; off grows none", () => {
    const g = playedGame({ seed: SEED, user: "pj" });
    const turns = g.playUntil(() => jealous(g.s).length > 0, 8000, "a jealous night");
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

    const off = playedGame({ seed: SEED, user: "pj", before: (s) => s.setBondFeelingsEnabled(false) });
    for (let i = 0; i < turns; i++) off.turn();
    expect((off.s as unknown as Priv).live.jealousy).toBeUndefined();
  });

  it("divided loyalty: some houseguest in a played house is split between a fallen-out pair; the player never is", () => {
    const g = playedGame({ seed: SEED, user: "bj-real-split" });
    const p = g.s as unknown as Priv;
    const anySplit = (): boolean => { const ids = g.s.livingIds().filter((i) => i !== PLAYER); return ids.some((h) => ids.some((o) => o !== h && p.splitOf(h, o) > 0)); };
    g.playUntil(anySplit, 8000, "a split loyalty");
    for (const o of g.s.livingIds()) if (o !== PLAYER) expect(p.splitOf(PLAYER, o)).toBe(0);
  });
});
