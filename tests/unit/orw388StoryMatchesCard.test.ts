import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { APPEARANCE_POOLS, generateHouse } from "../../src/engine/characterFactory";
import { GENESIS_LOOK_FEATURES } from "../../src/engine/genesisConstants";
import { isGrayHair } from "../../src/engine/deepProfile";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// ORW-388: the source look lists agree with ORW-381 (no scars, birthmarks, chipped teeth; gray hair at 40 and over),
// and recordCastProfile can carry a repaired identity concept.

const SEEDS = Array.from({ length: 40 }, (_, i) => 7 + i * 173);
const BANNED = /scar|birthmark|chipped|gap-?tooth/i;

describe("ORW-388 source lists", () => {
  it("no APPEARANCE_POOLS entry or GENESIS_LOOK_FEATURES entry is a scar, birthmark, chipped tooth or tooth gap", () => {
    for (const [pool, entries] of Object.entries(APPEARANCE_POOLS)) {
      for (const e of entries as readonly string[]) expect(e, `${pool}: ${e}`).not.toMatch(BANNED);
    }
    for (const e of GENESIS_LOOK_FEATURES) expect(e).not.toMatch(BANNED);
  });

  it("over 40 seeds no houseguest's appearance string has a scar/birthmark/chipped tooth, and gray hair only at 40 and over", () => {
    for (const seed of SEEDS) {
      const { npcs } = generateHouse(new SeededRandom(seed));
      for (const n of npcs) {
        const a = n.character.appearance;
        expect(a, `${seed}`).not.toMatch(BANNED);
        if (n.character.age < 40) expect(isGrayHair(a), `${seed}: age ${n.character.age} ${a}`).toBe(false);
      }
    }
  });

  it("the style families keep no word that describes the person (worn, weathered, craggy); 'rugged workwear' names a garment", async () => {
    const { STYLE_FAMILIES } = await import("../../src/domain/styleFamilies");
    for (const f of STYLE_FAMILIES) expect(`${f.label} ${f.sample}`).not.toMatch(/\b(worn|weathered|craggy|haggard)\b/i);
  });
});

describe("ORW-388 recordCastProfile identityConcept", () => {
  const start = () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 });
    return s;
  };

  // The stored concept is set the way genesis leaves it (a field on the warmed character), then repaired through the write-back.
  const withConcept = (concept: string | undefined) => {
    const s = start();
    const hg = s.getGameState().house[0]!;
    const npc = (s as unknown as { house: { npcs: { id: string; character: { identityConcept?: string } }[] } }).house.npcs
      .find((n) => n.id === hg.id)!;
    if (concept !== undefined) npc.character.identityConcept = concept;
    return { s, hg, npc };
  };

  it("folds a repaired identity concept onto a houseguest that has one: single line, capped at 300", () => {
    const { s, hg, npc } = withConcept("Floats through the Big Brother house like she owns it.");
    const res = s.recordCastProfile({ houseguestId: hg.id, identityConcept: "Floats through the Orwell house\nlike he owns it." });
    expect(res.accepted).toBe(true);
    expect(res.publicFields).toContain("identityConcept");
    expect(npc.character.identityConcept).toBe("Floats through the Orwell house like he owns it.");
    s.recordCastProfile({ houseguestId: hg.id, identityConcept: "x".repeat(500) });
    expect(npc.character.identityConcept!.length).toBe(300);
  });

  it("never invents one: a houseguest with no stored concept keeps none", () => {
    const { s, hg, npc } = withConcept(undefined);
    const res = s.recordCastProfile({ houseguestId: hg.id, identityConcept: "A brand new concept." });
    expect(res.accepted).toBe(true);
    expect(res.publicFields).not.toContain("identityConcept");
    expect(npc.character.identityConcept).toBeUndefined();
  });

  it("refuses an identity concept that names the player", () => {
    const { s, hg } = withConcept("A calm baker.");
    const res = s.recordCastProfile({ houseguestId: hg.id, identityConcept: "Obsessed with The Player." });
    expect(res.accepted).toBe(false);
  });
});
