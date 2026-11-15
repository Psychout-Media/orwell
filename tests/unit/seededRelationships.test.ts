import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { generateHouse } from "../../src/engine/characterFactory";
import {
  loadSeededRelationships, DEFAULT_TIE_BUDGET, DEFAULT_SHOWMANCE_BUDGET, TIE_AFFINITY_BIAS,
  nextShowmanceStage, SHOWMANCE_BOND_AFFINITY, SHOWMANCE_VISIBLE_AFFINITY,
} from "../../src/engine/seededRelationships";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { PLAYER } from "../../src/domain/ids";

/**
 * Feature 0059 — hidden seeded relationships (pre-game ties L35 + showmances L40). The layer is sparse,
 * Vault-sealed from the player AND admin, surfaces only organically, and folds a small standing affinity
 * bias between a seeded pair. Roles only — no names. The 0025 reserve-twist governance, mirrored.
 */

const SENT = "SENTINEL-0059";

function liveGame(user: string, seed: number) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { reg, sb };
}

/** Find a seed whose seeded layer has at least one tie (sparseness means most seeds have none). */
function seedWithATie(): { seed: number } {
  for (let seed = 1; seed <= 200; seed++) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`probe-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    if ((sb.session.snapshot().seededRelationships?.ties.length ?? 0) > 0) return { seed };
  }
  throw new Error("no seed produced a pre-game tie within the probe range");
}

/** A live game whose seeded layer has at least one showmance (returns the sandbox + the pair). */
function gameWithAShowmance() {
  for (let seed = 1; seed <= 300; seed++) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`sm-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const sms = sb.session.snapshot().seededRelationships?.showmances ?? [];
    if (sms.length > 0) return { reg, sb, pair: sms[0]! };
  }
  throw new Error("no seed produced a showmance within the probe range");
}

describe("0059 loadSeededRelationships — sparse, distinct, deterministic", () => {
  it("stays within budget, over DISTINCT houseguests, across many seeds (the L40 saturation guard)", () => {
    let everSeeded = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const npcs = generateHouse(new SeededRandom(seed)).npcs;
      const rng = new SeededRandom(seed * 7 + 1);
      const rels = loadSeededRelationships(npcs, DEFAULT_TIE_BUDGET, DEFAULT_SHOWMANCE_BUDGET, rng);
      expect(rels.ties.length).toBeLessThanOrEqual(DEFAULT_TIE_BUDGET);
      expect(rels.showmances.length).toBeLessThanOrEqual(DEFAULT_SHOWMANCE_BUDGET);
      // no NPC sits in two seeded pairs (the layer never clusters on one person)
      const seen = new Set<string>();
      for (const p of [...rels.ties, ...rels.showmances]) {
        expect(p.a).not.toBe(p.b);
        expect(seen.has(p.a)).toBe(false);
        expect(seen.has(p.b)).toBe(false);
        seen.add(p.a); seen.add(p.b);
      }
      everSeeded += rels.ties.length + rels.showmances.length;
    }
    // sparse, but NOT always empty — the layer exists
    expect(everSeeded).toBeGreaterThan(0);
    // …and it is sparse: far below "everyone is paired" (a 16-cast over 80 seeds)
    expect(everSeeded).toBeLessThan(80 * (DEFAULT_TIE_BUDGET + DEFAULT_SHOWMANCE_BUDGET));
  });

  it("is deterministic per seed and player-independent (keys off the cast)", () => {
    const npcs = generateHouse(new SeededRandom(42)).npcs;
    const a = loadSeededRelationships(npcs, 2, 2, new SeededRandom(99));
    const b = loadSeededRelationships(npcs, 2, 2, new SeededRandom(99));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("0059 live wiring — Vault-sealed, never projected, folds a behavioral bias", () => {
  it("no tie / showmance / partner reaches the player, admin, npcVoice, or the moment prompt", () => {
    const { sb } = liveGame("sr-wall", 4);
    // plant a sentinel into the Vault's seeded-relationship layer, like a real sealed tie would carry
    sb.engine.vault.writeHidden({ id: "sr:sent", kind: "seeded-relationship", subject: "npc:1", content: `${SENT}-tie` });
    // EVERY outward surface — including the moment prompts — must be sentinel-free (the real wall test).
    const everySurface = JSON.stringify(sb.session.getGameState())
      + JSON.stringify(sb.player.getVisibleState())
      + JSON.stringify(sb.session.gameStatus())
      + sb.session.getMomentPrompt({}).systemPrompt
      + sb.session.getMomentPrompt({ moment: "social" }).systemPrompt
      + sb.session.getGameState().house.filter((h) => h.status === "active")
          .map((h) => JSON.stringify(sb.session.npcVoice(h.id))).join("");
    expect(everySurface).not.toContain(SENT);
    // The structured layer's own markers (`pre-game-tie` / `seeded-relationship`) never appear on the
    // DATA projections either. (The moment prompt is excluded here: the L40 restraint legitimately uses
    // the word "showmance" as narrator GUIDANCE — that is not a seeded-layer leak.)
    const dataSurface = JSON.stringify(sb.session.getGameState())
      + JSON.stringify(sb.player.getVisibleState())
      + JSON.stringify(sb.session.gameStatus())
      + sb.session.getGameState().house.filter((h) => h.status === "active")
          .map((h) => JSON.stringify(sb.session.npcVoice(h.id))).join("");
    expect(dataSurface).not.toMatch(/pre-game-tie|seeded-relationship/);
    sb.syncAdmin();
    expect(JSON.stringify(sb.admin.inspect())).not.toContain(SENT);
    expect(JSON.stringify(sb.admin.inspect())).not.toMatch(/pre-game-tie|seeded-relationship/);
  });

  it("a seeded pre-game tie folds a small standing AFFINITY bias between the pair (both directions)", () => {
    const { seed } = seedWithATie();
    const { sb } = liveGame("sr-fold", seed);
    const tie = sb.session.snapshot().seededRelationships!.ties[0]!;
    // the bias is the ONLY observable (as behavior): the tied pair like each other a touch more than
    // the move-in baseline. Both directions carry it.
    const ab = sb.engine.relationships.edge(tie.a, tie.b);
    const ba = sb.engine.relationships.edge(tie.b, tie.a);
    const { baseline } = RELATIONSHIP_CONSTANTS;
    // ORW-132: a FRIENDLY tie starts a touch warmer; an ex / rival starts a touch COLDER (each side by its own temperament). The delta is measured against a same-seed CONTROL game with no ties at all,
    // so the move-in scatter around the baseline cancels out and only the tie's own fold remains.
    const control = new GameSessionRegistry().sandboxFor("sr-fold-control");
    (control.session as unknown as { tieBudget: number; showmanceBudget: number }).tieBudget = 0;
    (control.session as unknown as { showmanceBudget: number }).showmanceBudget = 0; // a different tie budget shifts the showmance draws, so the control draws neither
    control.session.createCharacter({ playerName: "The Player", seed });
    const dAB = ab.affinity - control.engine.relationships.edge(tie.a, tie.b).affinity;
    const dBA = ba.affinity - control.engine.relationships.edge(tie.b, tie.a).affinity;
    void baseline;
    const hostile = tie.nature === "ex" || tie.nature === "rival";
    if (hostile) { expect(dAB).toBeLessThan(0); expect(dBA).toBeLessThan(0); }
    else { expect(dAB).toBeCloseTo(TIE_AFFINITY_BIAS, 9); expect(dBA).toBeCloseTo(TIE_AFFINITY_BIAS, 9); }
    // it is SMALL - never a deterministic advantage (well under a full point)
    expect(Math.abs(dAB)).toBeLessThanOrEqual(TIE_AFFINITY_BIAS + 0.2);
    expect(Math.abs(dBA)).toBeLessThanOrEqual(TIE_AFFINITY_BIAS + 0.2);
  });

  it("nextShowmanceStage advances one step at a time, never skipping visible, only on sustained affinity", () => {
    expect(nextShowmanceStage("spark", SHOWMANCE_BOND_AFFINITY - 0.01)).toBe("spark"); // not yet
    expect(nextShowmanceStage("spark", SHOWMANCE_BOND_AFFINITY)).toBe("bond");
    expect(nextShowmanceStage("bond", SHOWMANCE_VISIBLE_AFFINITY - 0.01)).toBe("bond"); // not yet
    expect(nextShowmanceStage("bond", SHOWMANCE_VISIBLE_AFFINITY)).toBe("visible");
    // a spark with already-very-high affinity still only steps to bond (one step per tick — gradual)
    expect(nextShowmanceStage("spark", 0.99)).toBe("bond");
    expect(nextShowmanceStage("visible", 0.99)).toBe("visible"); // terminal until resolved
  });

  it("L40 — a showmance SURFACES only when sustained affinity carries it to visible; then it is public", () => {
    const { sb, pair } = gameWithAShowmance();
    const rel = sb.engine.relationships;
    // The GAME-CONTEXT showmance LISTING carries this phrase; the L40 restraint (always present) does
    // NOT — so it tells "a pair is publicly surfaced NOW" apart from the standing narrator guidance.
    const CTX = /voice romance for THESE pairs only/;
    // pre-visible: it is sealed — not in the Vault-free projection, not listed in the GM context
    expect(sb.session.visibleShowmances()).toEqual([]);
    expect(sb.session.getMomentPrompt({}).systemPrompt).not.toMatch(CTX);
    // drive the pair's mutual affinity up and advance the arc (spark → bond → visible)
    rel.edge(pair.a, pair.b).affinity = 0.95;
    rel.edge(pair.b, pair.a).affinity = 0.95;
    sb.session.advanceShowmances(); // spark → bond
    expect(sb.session.visibleShowmances()).toEqual([]); // still sealed at bond
    const surfaced = sb.session.advanceShowmances(); // bond → visible
    expect(surfaced.length).toBe(1);
    // now PUBLIC: it appears in the Vault-free projection and is LISTED in the narrator's context
    const visible = sb.session.visibleShowmances();
    expect(visible.length).toBe(1);
    const prompt = sb.session.getMomentPrompt({}).systemPrompt;
    expect(prompt).toMatch(CTX);
    expect(prompt).toContain(`${visible[0]!.a} & ${visible[0]!.b}`);
    // and the surfacing fact reached the PLAYER's knowledge as a witnessed (non-hidden) event
    const surfacedName = surfaced[0]!.aName;
    const witnessed = sb.engine.events.queryAll().filter((e) => !e.hidden && e.witnessSet.includes(PLAYER));
    expect(witnessed.some((e) => e.content.includes(surfacedName) && /showmance|grown close/.test(e.content))).toBe(true);
  });

  it("the seeded layer is sealed in the Vault and persists across a restart (stage never resets)", () => {
    const { seed } = seedWithATie();
    const { sb } = liveGame("sr-persist", seed);
    const before = sb.session.snapshot().seededRelationships!;
    expect(before.ties.length).toBeGreaterThan(0);
    // sealed engine-side
    const sealed = sb.engine.vault.readHidden({ kind: "seeded-relationship" });
    expect(sealed.length).toBeGreaterThan(0);
    // round-trips byte-identical (a showmance stage can only advance, never silently reset)
    const core = sb.session.snapshot();
    sb.session.restore(core);
    expect(JSON.stringify(sb.session.snapshot().seededRelationships)).toBe(JSON.stringify(before));
  });
});
