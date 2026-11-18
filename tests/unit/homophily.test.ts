import { describe, it, expect } from "vitest";
import { similarity, pairBondMult, type HomophilyFacets } from "../../src/engine/homophily";
import { HOMOPHILY } from "../../src/engine/homophilyConstants";
import { HOUSE_LEAN_TUNING } from "../../src/engine/houseLeans";
import { RelationshipModel } from "../../src/engine/relationships";
import { scaleImpactByValence } from "../../src/engine/relationshipConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { STYLE_FAMILIES } from "../../src/domain/styleFamilies";

/** ORW-561 / spec 0176 (slice 10, part 1): homophily. Roles only. */
const F = HOUSE_LEAN_TUNING.MAX_FACTOR;
let n = 0;
type H = { house: { player: { character: HomophilyFacets }; npcs: Array<{ id: string; character: HomophilyFacets }> } };
function start(seed: number, flag = true): GameSessionAdapter {
  const sb = new GameSessionRegistry().sandboxFor(`homophily561-${n++}`);
  sb.session.setHomophilyEnabled(flag);
  sb.session.setHouseCultureEnabled(false); // isolate the pair term from the culture's own bonding dial
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.noteMessage({ messageId: "m1" });
  return sb.session;
}
const npcs = (s: GameSessionAdapter) => (s as unknown as H).house.npcs;

describe("similarity and the pair multiplier are pure and bounded", () => {
  const A: HomophilyFacets = { age: 27, presentation: STYLE_FAMILIES[0]!.label, archetype: "flirt", hometown: "Austin, TX", vocation: "ER nurse" };
  const B: HomophilyFacets = { age: 52, presentation: STYLE_FAMILIES[3]!.label, archetype: "analyst", hometown: "Boston, MA", vocation: "tax accountant" };
  it("is symmetric, within 0..1, and 1 for a person against themselves", () => {
    expect(similarity(A, B)).toBe(similarity(B, A));
    expect(similarity(A, B)).toBeGreaterThanOrEqual(0); expect(similarity(A, B)).toBeLessThanOrEqual(1);
    expect(similarity(A, A)).toBeGreaterThan(0.9);
    expect(similarity(A, A)).toBeGreaterThan(similarity(A, B));
  });
  it("tolerates missing facets: an empty card is neutral and never throws", () => {
    expect(similarity({}, {})).toBe(HOMOPHILY.NEUTRAL);
    expect(Number.isFinite(similarity({ age: 30 }, { vocation: "chef" }))).toBe(true);
    expect(similarity({ ...A, vocation: undefined, hometown: undefined }, { ...B, vocation: undefined, hometown: undefined })).toBeGreaterThanOrEqual(0);
  });
  it("the multiplier is inside [1/F, F] for any pair, and rises with similarity", () => {
    for (const x of [A, B, {}]) for (const y of [A, B, {}]) { const m = pairBondMult(x, y); expect(m).toBeGreaterThanOrEqual(1 / F); expect(m).toBeLessThanOrEqual(F); }
    expect(pairBondMult(A, A)).toBeGreaterThan(pairBondMult(A, B));
    expect(pairBondMult(A, A)).toBeGreaterThan(1);
    expect(pairBondMult(A, B)).toBeLessThan(1);
  });
  it("over real seeded casts it stays inside the bound and is roughly mean-neutral", () => {
    let sum = 0, cnt = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const c = npcs(start(seed)).map((x) => x.character);
      for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) { const m = pairBondMult(c[i]!, c[j]!); expect(m).toBeGreaterThanOrEqual(1 / F); expect(m).toBeLessThanOrEqual(F); sum += m; cnt++; }
    }
    expect(Math.abs(sum / cnt - 1)).toBeLessThan(0.03);
  });
});

describe("the bond seam in a played game", () => {
  /** The most and least alike pair among the NPCs of a seeded cast. */
  function extremes(s: GameSessionAdapter): { like: [string, string]; unlike: [string, string] } {
    const c = npcs(s); let hi = -1, lo = 2; let like: [string, string] = [c[0]!.id, c[1]!.id], unlike = like;
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
      const v = similarity(c[i]!.character, c[j]!.character);
      if (v > hi) { hi = v; like = [c[i]!.id, c[j]!.id]; }
      if (v < lo) { lo = v; unlike = [c[i]!.id, c[j]!.id]; }
    }
    return { like, unlike };
  }
  const gain = (v: { warm: number; sore: number }, seed: number): { warm: number; sore: number } => {
    const rel = new RelationshipModel(0.5);
    const rng = new SeededRandom(seed);
    const before = rel.read("npc:1", "npc:2").signals;
    rel.applyImpactDirected("npc:1", "npc:2", scaleImpactByValence({ affinity: 0.1, trust: 0.1 }, v.warm, v.sore), rng);
    const warm = rel.read("npc:1", "npc:2").signals.affinity - before.affinity;
    const rel2 = new RelationshipModel(0.5);
    const b2 = rel2.read("npc:1", "npc:2").signals;
    rel2.applyImpactDirected("npc:1", "npc:2", scaleImpactByValence({ affinity: -0.1, trust: -0.1 }, v.warm, v.sore), new SeededRandom(seed));
    return { warm, sore: b2.affinity - rel2.read("npc:1", "npc:2").signals.affinity };
  };
  it("a similar pair gains more warmth per same interaction than a mismatched pair, and loses less to a slight (several seeds)", () => {
    for (const seed of [3, 11, 21, 40]) {
      const s = start(seed); const { like, unlike } = extremes(s);
      const vl = s.socialFoldValence(like[0], like[0], like[1]), vu = s.socialFoldValence(unlike[0], unlike[0], unlike[1]);
      expect(vl.warm).toBeGreaterThan(vu.warm); expect(vl.sore).toBeLessThan(vu.sore);
      const gl = gain(vl, 5), gu = gain(vu, 5);
      expect(gl.warm).toBeGreaterThan(gu.warm);
      expect(gl.sore).toBeLessThan(gu.sore); // the souring side DIVIDES
    }
  });
  it("the flag off, or no pair named, or an unplayed game leaves the valence exactly as it was", () => {
    const s = start(3, false); const { like } = extremes(s);
    expect(s.socialFoldValence(like[0], like[0], like[1])).toEqual({ warm: 1, sore: 1 });
    const on = start(3, true);
    expect(on.socialFoldValence(like[0])).toEqual({ warm: 1, sore: 1 });
    const sb = new GameSessionRegistry().sandboxFor(`homophily561-${n++}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    expect(sb.session.socialFoldValence(like[0], like[0], like[1])).toEqual({ warm: 1, sore: 1 });
  });
  it("a played game with the flag off is byte-identical to one whose pair term is forced to 1 (seeds 3 and 11)", () => {
    for (const seed of [3, 11]) {
      const run = (flag: boolean, force1: boolean): string => {
        const s = start(seed, flag);
        if (force1) (s as unknown as { pairHomophilyMult: () => number }).pairHomophilyMult = () => 1;
        for (let i = 0; i < 8; i++) s.advanceGame({});
        return JSON.stringify(s.snapshot());
      };
      expect(run(false, false)).toBe(run(true, true));
    }
  });
  it("through the real recordInteraction fold, each NPC's warmth toward the player scales by exactly the pair multiplier (flag on vs off, same scene, seeds 3 and 11)", async () => {
    for (const seed of [3, 11]) {
      const warmth = async (flag: boolean): Promise<Map<string, number>> => {
        const out = new Map<string, number>();
        for (let k = 0; k < 6; k++) { // a fresh game per houseguest, so one scene's fold never colours the next
          const sb = new GameSessionRegistry().sandboxFor(`homophily561-fold-${seed}-${k}`); // the same user id on and off, so the seeded stream is the same
          sb.session.setHomophilyEnabled(flag); sb.session.setHouseCultureEnabled(false);
          sb.session.createCharacter({ playerName: "The Player", seed });
          sb.session.noteMessage({ messageId: "m1" });
          const g = npcs(sb.session)[k]!;
          const b = sb.engine.relationships.edge(g.id, PLAYER).affinity;
          await sb.mcp.player.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, g.id], kind: "bonding", content: "A long easy talk about home." });
          out.set(g.id, sb.engine.relationships.edge(g.id, PLAYER).affinity - b);
        }
        return out;
      };
      const on = await warmth(true), off = await warmth(false);
      const s = start(seed); const player = (s as unknown as H).house.player.character;
      const rows = npcs(s).slice(0, 6).map((g) => ({ m: pairBondMult(g.character, player), ratio: on.get(g.id)! / off.get(g.id)! })).filter((r) => Number.isFinite(r.ratio) && off.size);
      expect(rows.length).toBeGreaterThan(2);
      for (const r of rows) expect(r.ratio).toBeCloseTo(r.m, 6); // the fold's magnitude scales by exactly the pair multiplier: same draws, so no rng perturbation
    }
  });
  it("the seam clamps: with the house culture's own dial at its bound the pair term stays a bounded factor", () => {
    const s = start(11); const { like } = extremes(s);
    const v = s.socialFoldValence(like[0], like[0], like[1]);
    expect(v.warm).toBeLessThanOrEqual(F); expect(v.sore).toBeGreaterThanOrEqual(1 / F);
  });
});

describe("the wall", () => {
  it("no similarity or pair multiplier appears in any projection, tool result, moment prompt or admin view", async () => {
    const sb = new GameSessionRegistry().sandboxFor(`homophily561-wall-${n++}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 21 });
    sb.session.noteMessage({ messageId: "m1" });
    for (let i = 0; i < 3; i++) sb.session.advanceGame({});
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.player.callTool("whereabouts", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {}),
    ];
    const blob = JSON.stringify(surfaces).toLowerCase();
    for (const k of ["homophily", "pairbondmult", "similarity", "pairhomophily", "likeattracts"]) expect(blob.includes(k), `a surface carries ${k}`).toBe(false);
  });
});
