import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { ACCUSE, hitReaction, sourChance } from "../../src/engine/accuseConstants";
import type { TieNature } from "../../src/engine/seededRelationships";

/**
 * B50 (Ryne's accuseTie ruling; flag ORWELL_ACCUSE_COST, off by default): a MISS dings the accuser with the accused; a HIT sometimes sours and sometimes earns respect, by the accused's distrust, temperament
 * and what the tie was; same seed => same reaction; the accuser's wording is not an input (accuseTie takes none). Flag off => exactly today's accuseTie (a miss is free). Roles only.
 */
describe("sourChance / hitReaction (pure)", () => {
  it("is monotone: more distrust, a pricklier temperament and a more hurtful tie each raise it; always within the bounds", () => {
    const base = sourChance(0.5, 0.5, "shared-hometown");
    expect(sourChance(0.1, 0.5, "shared-hometown")).toBeGreaterThan(base);
    expect(sourChance(0.5, 0.9, "shared-hometown")).toBeGreaterThan(base);
    expect(sourChance(0.5, 0.5, "family")).toBeGreaterThan(base);
    for (const n of ["family", "ex", "rival", "shared-hometown"] as TieNature[]) for (const t of [0, 0.5, 1]) for (const p of [0, 0.5, 1]) {
      const c = sourChance(t, p, n); expect(c).toBeGreaterThanOrEqual(ACCUSE.minSour); expect(c).toBeLessThanOrEqual(ACCUSE.maxSour);
    }
  });
  it("the reaction is a deterministic threshold on the roll", () => {
    expect(hitReaction(0.1, 0.4)).toBe("sour"); expect(hitReaction(0.9, 0.4)).toBe("respect"); expect(hitReaction(0.4, 0.4)).toBe("respect");
  });
});

type G = { accuseTie(a: string, b: string): { landed: boolean } | null; setAccuseCostEnabled(on: boolean): void };
type Ledger = Record<string, Record<string, { kind: string }[]>>;
function game(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`accuse-${seed}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  const ties = (sb.session as unknown as { seededRels: { ties: Array<{ a: string; b: string; nature: TieNature }> } }).seededRels.ties;
  const npcs = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { sb, g: sb.session as unknown as G, ties, npcs, rel: sb.engine.relationships, ledger: () => ((sb.session.snapshot().live as { npcMemory?: Ledger }).npcMemory ?? {}) };
}
const noTiePair = (ties: Array<{ a: string; b: string }>, npcs: string[]): [string, string] => {
  for (const a of npcs) for (const b of npcs) if (a < b && !ties.some((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a))) return [a, b];
  throw new Error("no tie-free pair");
};

describe("a MISS dings the accuser (flag on); a free miss stays free (flag off)", () => {
  it("flag on: both accused hold a lower read of the accuser than a no-accusation control; flag off: nothing moves", () => {
    const on = game(7), off = game(7), ctrl = game(7);
    const [a, b] = noTiePair(on.ties, on.npcs);
    on.g.setAccuseCostEnabled(true);
    off.g.setAccuseCostEnabled(false); // pinned OFF explicitly: the flag now defaults ON
    expect(on.g.accuseTie(a, b)).toEqual({ landed: false });
    expect(off.g.accuseTie(a, b)).toEqual({ landed: false });
    for (const m of [a, b]) {
      expect(on.rel.edge(m, PLAYER).trust, `${m} trust vs control`).toBeLessThan(ctrl.rel.edge(m, PLAYER).trust);
      expect(off.rel.edge(m, PLAYER).trust, "flag off is free").toBe(ctrl.rel.edge(m, PLAYER).trust);
    }
    expect(Object.keys(on.ledger()).sort()).toEqual([a, b].sort());
    expect(off.ledger()).toEqual({});
  });
});

describe("an honest HIT sometimes sours and sometimes earns respect", () => {
  it("over many seeds both reactions occur; each is bounded; the same seed gives the same reaction; flag off folds neither", () => {
    let sour = 0, respect = 0, seen = 0;
    for (let seed = 1; seed <= 120; seed++) { // ORW-132 made pre-show ties rare, so more seeds are needed to see enough accusable ties
      const g = game(seed); const tie = g.ties[0]; if (!tie) continue;
      g.g.setAccuseCostEnabled(true);
      const before = g.rel.edge(tie.a, PLAYER).trust;
      expect(g.g.accuseTie(tie.a, tie.b)).toEqual({ landed: true });
      const after = g.rel.edge(tie.a, PLAYER).trust;
      expect(Math.abs(after - before)).toBeLessThan(0.6); // bounded
      const kinds = (g.ledger()[tie.a]?.[PLAYER] ?? []).map((e) => e.kind);
      if (kinds.includes("scene-conflict")) sour++; else if (kinds.includes("scene-kindness")) respect++;
      seen++;
      // same seed => same reaction
      const again = game(seed); again.g.setAccuseCostEnabled(true); again.g.accuseTie(tie.a, tie.b);
      expect((again.ledger()[tie.a]?.[PLAYER] ?? []).map((e) => e.kind)).toEqual(kinds);
      // flag off: a hit folds neither reaction
      const off = game(seed); off.g.setAccuseCostEnabled(false); off.g.accuseTie(tie.a, tie.b);
      expect(off.ledger()[tie.a]?.[PLAYER]).toBeUndefined();
    }
    expect(seen).toBeGreaterThan(20);
    expect(sour, "some hits sour").toBeGreaterThan(0);
    expect(respect, "some hits earn respect").toBeGreaterThan(0);
  });
});
