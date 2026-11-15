import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import {
  loadSeededRelationships, TIE_AFFINITY_BIAS, TIE_LOAD_PROB, TIE_NATURES, tieExposureOf, tieNatureProse,
  type PreGameTie, type TieNature,
} from "../../src/engine/seededRelationships";
import { markTieVisibility, PUBLIC_TIE_CHANCE, tieDirectedBias, tiePrickle, TIE_HOSTILITY } from "../../src/engine/tieVisibility";
import type { Houseguest } from "../../src/engine/characterFactory";

/**
 * ORW-132 (Ryne): pre-show ties are a HUGE MINORITY (like reserve twists), each marked SECRET or PUBLIC at season start; a public tie is a house fact from Day 1; a secret one stays sealed; the hostility of an ex or a
 * rival comes from the pair's own temperaments; everything deterministic per seed. Roles only.
 */
const cast = (n: number): Houseguest[] => Array.from({ length: n }, (_, i) => ({ id: npc(i + 1) }) as unknown as Houseguest);

describe("ties are rare (a huge minority, rarer than reserve twists)", () => {
  it("over 300 seeds the mean tie count is small and most seasons have none", () => {
    let total = 0, zero = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const n = loadSeededRelationships(cast(15), 2, 0, new SeededRandom(seed * 7919)).ties.length;
      total += n; if (n === 0) zero++;
    }
    expect(total / 300, "mean ties per season").toBeLessThan(0.7);
    expect(zero / 300, "share of seasons with no tie at all").toBeGreaterThan(0.5);
    expect(TIE_LOAD_PROB, "rarer than the 0.5 per-slot load of a reserve twist").toBeLessThan(0.5);
  });
  it("is deterministic per seed", () => {
    for (let seed = 1; seed < 40; seed++) {
      expect(loadSeededRelationships(cast(15), 2, 0, new SeededRandom(seed))).toEqual(loadSeededRelationships(cast(15), 2, 0, new SeededRandom(seed)));
    }
  });
});

describe("every tie is marked secret or public at season start", () => {
  const ties = (nature: TieNature, n: number): PreGameTie[] => Array.from({ length: n }, (_, i) => ({ a: npc(2 * i + 1), b: npc(2 * i + 2), nature }));
  it("each tie gets an explicit mark, deterministic, and an existing mark is never re-decided", () => {
    const marked = markTieVisibility(ties("ex", 6), new SeededRandom(5));
    expect(marked.every((t) => t.visibility === "secret" || t.visibility === "public")).toBe(true);
    expect(markTieVisibility(ties("ex", 6), new SeededRandom(5))).toEqual(marked);
    const pre = markTieVisibility([{ a: npc(1), b: npc(2), nature: "family", visibility: "secret" }], new SeededRandom(5));
    expect(pre[0]!.visibility).toBe("secret");
  });
  it("depends on the pair: family is public far more often than an ex", () => {
    const rate = (nature: TieNature): number => markTieVisibility(ties(nature, 400), new SeededRandom(11)).filter((t) => t.visibility === "public").length / 400;
    expect(rate("family")).toBeGreaterThan(rate("ex") + 0.3);
    for (const nature of TIE_NATURES) expect(PUBLIC_TIE_CHANCE[nature], nature).toBeGreaterThan(0);
  });
});

describe("hostility of an ex or a rival comes from the pair's personalities", () => {
  it("friendly natures keep the original warm bias byte-identical", () => {
    for (const nature of TIE_NATURES.filter((n) => n !== "ex" && n !== "rival")) expect(tieDirectedBias(nature, "aggressive", 0.9)).toBe(TIE_AFFINITY_BIAS);
  });
  it("an ex / rival starts cold, and a prickly volatile houseguest holds it harder than an easy-going calm one", () => {
    for (const nature of ["ex", "rival"] as const) {
      const prickly = tieDirectedBias(nature, "aggressive", 0.9), easy = tieDirectedBias(nature, "loyal", 0.05);
      expect(prickly).toBeLessThan(easy);
      expect(easy).toBeLessThan(0);
      expect(prickly).toBeGreaterThanOrEqual(-(TIE_HOSTILITY.base + TIE_HOSTILITY.span));
    }
    expect(tiePrickle("aggressive", 0.9)).toBeGreaterThan(tiePrickle("loyal", 0.05));
  });
});

describe("through the live game: a public tie is a house fact from Day 1, a secret one stays sealed (Vault wall)", () => {
  function findSeason(want: "public" | "secret"): { sb: ReturnType<GameSessionRegistry["sandboxFor"]>; tie: PreGameTie } {
    for (let seed = 1; seed <= 150; seed++) {
      const sb = new GameSessionRegistry().sandboxFor(`orw132-${want}-${seed}`);
      sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
      const tie = (sb.session.snapshot().seededRelationships?.ties ?? []).find((t) => t.visibility === want);
      if (tie) return { sb, tie };
    }
    throw new Error(`no ${want} tie in seeds 1..150`);
  }
  it("PUBLIC: starts at exposure public and the whole house (player included) witnessed it as a normal event", () => {
    const { sb, tie } = findSeason("public");
    expect(tieExposureOf(tie)).toBe("public");
    const ev = sb.engine.events.queryAll().filter((e) => e.type === "pre-show-tie");
    expect(ev.length).toBeGreaterThanOrEqual(1);
    const house = [PLAYER, ...sb.session.snapshot().house!.npcs.map((n) => n.id)];
    for (const e of ev) { expect(e.hidden, "a public tie is not Vault content").toBe(false); expect(e.witnessSet.slice().sort()).toEqual(house.slice().sort()); }
    expect(sb.engine.events.query({ witnessedBy: PLAYER }).some((e) => e.type === "pre-show-tie")).toBe(true);
  });
  it("SECRET: stays sealed, no announcement event, and nothing in the player's sweep names the pair's connection", () => {
    const { sb, tie } = findSeason("secret");
    expect(tieExposureOf(tie)).toBe("sealed");
    const names = sb.session.snapshot().house!.npcs.filter((n) => n.id === tie.a || n.id === tie.b).map((n) => n.name);
    expect(names.length).toBe(2);
    const sweep = sb.player.vaultLeakSweep();
    expect(sweep.includes(tieNatureProse(tie.nature)), "the connection's prose never reaches the player").toBe(false);
    const announced = sb.engine.events.queryAll().filter((e) => e.type === "pre-show-tie");
    expect(announced.every((e) => !names.every((nm) => e.content.includes(nm))), "no announcement names the secret pair").toBe(true);
  });
  it("is deterministic per seed (same marks, same exposure)", () => {
    const run = (): string => {
      const sb = new GameSessionRegistry().sandboxFor(`orw132-det-${Math.random()}`);
      sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 31 });
      return JSON.stringify(sb.session.snapshot().seededRelationships?.ties);
    };
    expect(run()).toBe(run());
  });
});
