import { describe, it, expect } from "vitest";
import { buildPortraitPrompt } from "../../src/engine/portraitPrompts";
import {
  STYLE_ANCHOR_VARIANTS,
  WORN_TEXTURE_VARIANTS,
  EXPRESSION_VARIANTS,
  FRAMING_VARIANTS,
  BACKDROP_VARIANTS,
  FACIAL_STRUCTURE_VARIANTS,
  LIGHTING_VARIANTS,
} from "../../src/engine/imageConstants";
import { APPEARANCE_POOLS } from "../../src/engine/characterFactory";
import { dealCastPhysicalSpread, MAX_PER_HEIGHT_BUILD, MAX_PER_SKIN_TONE } from "../../src/engine/deepProfile";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { PhysicalCharacteristics } from "../../src/domain/physicalCharacteristics";
import type { EntityId } from "../../src/domain/ids";

/**
 * G24 — portrait variety (anti-sameness / anti-AI-look). Three layers, one claim each:
 *   A. the season anchors ask for candid, imperfect production stills — never the
 *      AI-saturated "professional headshot / studio lighting" genre;
 *   B. expression/framing/backdrop vary PER SUBJECT (hash-seeded, stable per season)
 *      instead of every portrait sharing one identical pose/crop;
 *   C. the public appearance facets carry the axes that differentiate real faces
 *      (complexion, hair color+texture, distinguishing features, a wide age band).
 * HARD rule: roles only — generated fixtures, no real names.
 */

const facets = { appearance: "athletic, warm brown skin, loose chestnut curls, laugh lines, bright eyes", age: 31, presentation: "casual and laid-back" };

describe("G24/A — candid anchors, not AI-headshot anchors", () => {
  it("every anchor stays photorealistic, names the Orwell house, and keeps skin cues out (ORW-361)", () => {
    for (const anchor of STYLE_ANCHOR_VARIANTS) {
      expect(anchor).toContain("photorealistic");
      expect(anchor).toMatch(/Orwell house/);
      expect(anchor).not.toMatch(/Big Brother|unretouched|true-to-life|lived-in|honest|blemish/);
    }
  });

  it("the imperfection cues live in the parallel worn-texture pool (same index)", () => {
    expect(WORN_TEXTURE_VARIANTS.length).toBe(STYLE_ANCHOR_VARIANTS.length);
    for (const w of WORN_TEXTURE_VARIANTS) expect(w).toMatch(/unretouched|true-to-life|lived-in|honest/);
  });

  it("the AI-saturated headshot genre is ratcheted out of the anchors", () => {
    for (const anchor of STYLE_ANCHOR_VARIANTS) {
      expect(anchor).not.toMatch(/professional headshot|professional portrait|studio lighting/);
    }
  });
});

describe("G24/B — per-subject shot variation, deterministic per season", () => {
  const anchor = STYLE_ANCHOR_VARIANTS[0]!;

  it("the same (houseguest, anchor) always assembles the identical prompt", () => {
    const a = buildPortraitPrompt("hg:7", "A Houseguest", facets, anchor);
    const b = buildPortraitPrompt("hg:7", "A Houseguest", facets, anchor);
    expect(a.prompt).toBe(b.prompt);
  });

  it("every pick comes from the declared pools, and distinguishing content leads (#1317 reweight)", () => {
    const p = buildPortraitPrompt("hg:3", "A Houseguest", facets, anchor).prompt;
    // #1317 (root cause 1): the shared style anchor no longer leads — the subject-distinguishing
    // clauses do — but the anchor is still KEPT in full further along the prompt.
    expect(p.startsWith("Subject:")).toBe(true);
    expect(p).toContain(anchor);
    const expression = p.match(/Expression: ([^.]+)\./)?.[1];
    const framing = p.match(/Framing: ([^.]+)\./)?.[1];
    const setting = p.match(/Setting: ([^.]+)\./)?.[1];
    expect(EXPRESSION_VARIANTS as readonly string[]).toContain(expression);
    expect(FRAMING_VARIANTS as readonly string[]).toContain(framing);
    expect(BACKDROP_VARIANTS as readonly string[]).toContain(setting);
  });

  it("a full cast does NOT share one pose: expressions, framings, and settings vary", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 1234 });
    const prompts = view.portraitPrompts!.map((p) => p.prompt);
    // #529: the cast pipeline covers the 15 generated NPCs (the player has no name-hash portrait).
    expect(prompts.length).toBeGreaterThanOrEqual(15);

    const pick = (re: RegExp) => new Set(prompts.map((p) => p.match(re)?.[1] ?? ""));
    // 15 subjects over pools of 10/8/8 — sameness would be 1 distinct value; require real spread.
    expect(pick(/Expression: ([^.]+)\./).size).toBeGreaterThanOrEqual(4);
    expect(pick(/Framing: ([^.]+)\./).size).toBeGreaterThanOrEqual(3);
    // #1317: "Setting:" is no longer the LAST clause (a "Distinctive look:" clause now follows it), so
    // scope the capture to end at the next clause boundary rather than end-of-string.
    expect(pick(/Setting: ([^.]+)\./).size).toBeGreaterThanOrEqual(3);
  });

  it("shot variation is season-keyed: a different anchor re-deals the shot", () => {
    // Not a hard guarantee per subject (hash collisions allowed) — but across a cast-sized
    // sweep the deals must differ somewhere, proving the anchor participates in the key.
    const other = STYLE_ANCHOR_VARIANTS[1]!;
    const ids = Array.from({ length: 16 }, (_, i) => `hg:${i}`);
    const dealt = (a: string) => ids.map((id) => buildPortraitPrompt(id, "A Houseguest", facets, a).prompt.split("Expression:")[1]).join("|");
    expect(dealt(anchor)).not.toBe(dealt(other));
  });
});

describe("G24/C — the physical facet carries the differentiating axes (the single source of truth)", () => {
  it("every cast member's physical facet carries a complexion, hair, and a distinguishing feature", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 99 });
    // L29: a 0058 card's physical descriptor is the STRUCTURED `physicalCharacteristics` facet (what the
    // portrait AND narration read) — the prose `appearance` no longer rides alongside it (it could
    // contradict). Each face still carries the axes that differentiate real people.
    const cards = view.house as ReadonlyArray<{ appearance?: string; physicalCharacteristics?: PhysicalCharacteristics }>;
    expect(cards.length).toBe(15);
    for (const hg of cards) {
      expect(hg.appearance, "the redundant prose is gone from a 0058 card").toBeUndefined();
      const pc = hg.physicalCharacteristics!;
      expect(pc).toBeTruthy();
      for (const axis of [pc.skinTone, pc.hair, pc.facialFeatures, pc.distinguishingMark, pc.heightBuild]) {
        expect(typeof axis === "string" && axis.length > 0).toBe(true);
      }
    }
  });

  it("ages span the widened 21–52 band", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 7 });
    for (const hg of view.house as ReadonlyArray<{ age?: number }>) {
      expect(hg.age).toBeGreaterThanOrEqual(21);
      expect(hg.age).toBeLessThanOrEqual(52);
    }
  });

  it("a cast reads as distinct people: physical facets barely collide", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 4242 });
    const faces = (view.house as ReadonlyArray<{ physicalCharacteristics?: PhysicalCharacteristics }>)
      .map((h) => JSON.stringify(h.physicalCharacteristics));
    expect(new Set(faces).size).toBeGreaterThanOrEqual(13);
  });

  it("facets stay seed-stable: the same seed deals the same faces", () => {
    const deal = (seed: number) => {
      const a = new GameSessionAdapter();
      const v = a.createCharacter({ playerName: "The Player", seed });
      return (v.house as ReadonlyArray<{ physicalCharacteristics?: PhysicalCharacteristics; age?: number }>)
        .map((h) => `${JSON.stringify(h.physicalCharacteristics)}|${h.age}`).join("~");
    };
    expect(deal(555)).toBe(deal(555));
  });

  it("no facet smuggles hidden-layer vocabulary", () => {
    for (const pool of Object.values(APPEARANCE_POOLS)) {
      for (const entry of pool) {
        expect(entry).not.toMatch(/\b(trust|affinity|threat|soul|confessional|secret-motive|stat)\b/i);
      }
    }
  });
});

/**
 * #1317 (cast portraits converge) — the fix for the four root causes diagnosed on the issue:
 *   D. NEW axes (facial structure + lighting) vary per subject, hash-seeded and seed-stable, the same
 *      G24 discipline as expression/framing/backdrop — countering the shared style anchor's weight.
 *   E. heightBuild/skinTone are now cast-wide SPREAD-CAPPED in `dealCastPhysicalSpread`, exactly like
 *      hair/facial/style already were (#533) — no longer a bare independent per-NPC `rng.pick()`.
 *   F. `genderPresentation` now MEASURABLY shifts build/hair phrasing at prompt-assembly time — the
 *      stored facet stays gender-neutral and byte-stable; only the local prompt copy changes.
 */
describe("G24/D — #1317: facial structure + lighting vary per subject (new axes)", () => {
  const anchor = STYLE_ANCHOR_VARIANTS[0]!;

  it("every prompt carries a Facial structure and Lighting clause drawn from the declared pools", () => {
    const p = buildPortraitPrompt("hg:5", "A Houseguest", facets, anchor).prompt;
    const facial = p.match(/Facial structure: ([^.]+)\./)?.[1];
    const lighting = p.match(/Lighting: ([^.]+)\./)?.[1];
    expect(FACIAL_STRUCTURE_VARIANTS as readonly string[]).toContain(facial);
    expect(LIGHTING_VARIANTS as readonly string[]).toContain(lighting);
  });

  it("the same (houseguest, anchor) always deals the same facial structure + lighting (seed-stable)", () => {
    const a = buildPortraitPrompt("hg:11", "A Houseguest", facets, anchor).prompt;
    const b = buildPortraitPrompt("hg:11", "A Houseguest", facets, anchor).prompt;
    expect(a.match(/Facial structure: ([^.]+)\./)?.[1]).toBe(b.match(/Facial structure: ([^.]+)\./)?.[1]);
    expect(a.match(/Lighting: ([^.]+)\./)?.[1]).toBe(b.match(/Lighting: ([^.]+)\./)?.[1]);
  });

  it("a full cast spreads across lighting; written faces carry no random Facial structure (ORW-361)", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 4321 });
    const prompts = view.portraitPrompts!.map((p) => p.prompt);
    const pick = (re: RegExp) => new Set(prompts.map((p) => p.match(re)?.[1] ?? ""));
    expect(prompts.every((p) => !p.includes("Facial structure:"))).toBe(true);
    expect(pick(/Lighting: ([^.]+)\./).size).toBeGreaterThanOrEqual(3);
  });

  it("the strongest distinguishing facet is restated near the end of the prompt (root cause 4)", () => {
    const p = buildPortraitPrompt("hg:5", "A Houseguest", facets, anchor).prompt;
    expect(p).toMatch(/Distinctive look: .+$/);
    // The repeated close comes AFTER Setting (the prompt's former terminal clause) — proving it is a
    // genuine restatement at the very end, not a duplicate of an earlier clause's position.
    expect(p.indexOf("Distinctive look:")).toBeGreaterThan(p.indexOf("Setting:"));
  });

  it("the new pools carry no hidden-layer vocabulary", () => {
    for (const entry of [...FACIAL_STRUCTURE_VARIANTS, ...LIGHTING_VARIANTS]) {
      expect(entry).not.toMatch(/\b(trust|affinity|threat|soul|confessional|secret-motive|stat)\b/i);
    }
  });
});

describe("G24/E — #1317: heightBuild + skinTone are cast-wide spread-capped (root cause 2)", () => {
  it("dealCastPhysicalSpread caps each heightBuild/skinTone value cast-wide, exactly like hair/facial/style", () => {
    const spread = dealCastPhysicalSpread(new SeededRandom(2026), 15);
    expect(spread.length).toBe(15);
    const countBy = (key: "heightBuild" | "skinTone") => {
      const counts = new Map<string, number>();
      for (const s of spread) counts.set(s[key], (counts.get(s[key]) ?? 0) + 1);
      return counts;
    };
    for (const [, count] of countBy("heightBuild")) expect(count).toBeLessThanOrEqual(MAX_PER_HEIGHT_BUILD);
    for (const [, count] of countBy("skinTone")) expect(count).toBeLessThanOrEqual(MAX_PER_SKIN_TONE);
    // Real spread, not incidental: a 15-cast over a 10-entry pool capped at 2 must use at least 5 distinct
    // values (the old bare-rng.pick behavior had no such guarantee and could pile up on one value).
    expect(countBy("heightBuild").size).toBeGreaterThanOrEqual(5);
    expect(countBy("skinTone").size).toBeGreaterThanOrEqual(5);
  });

  it("the cast-wide deal is seed-stable: the same seed always deals the same spread", () => {
    const a = dealCastPhysicalSpread(new SeededRandom(77), 15);
    const b = dealCastPhysicalSpread(new SeededRandom(77), 15);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("2026-07-21 prompt audit: distinguishing marks are cast-wide capped — named marks ≤2, tattoos a small minority, 'none' free", () => {
    for (const seed of [2026, 77, 4242, 999, 108108]) {
      const marks = dealCastPhysicalSpread(new SeededRandom(seed), 15).map((s) => s.mark);
      const named = marks.filter((m) => !/^none\b/i.test(m));
      const counts = new Map<string, number>();
      for (const m of named) counts.set(m, (counts.get(m) ?? 0) + 1);
      // no NAMED mark lands on 3+ houseguests (the "half-sleeve tattoo ×4" index case stays dead)
      for (const [, count] of counts) expect(count).toBeLessThanOrEqual(2);
      // tattoo marks are a bounded small minority (2 tattoo entries × cap 2 ⇒ hard ceiling 4)
      expect(named.filter((m) => /tattoo/i.test(m)).length).toBeLessThanOrEqual(4);
    }
  });

  it("a live cast's heightBuild spreads within the cap (not overwritten downstream, unlike skinTone which is separately ethnicity-grounded)", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 606 });
    const builds = (view.house as ReadonlyArray<{ physicalCharacteristics?: PhysicalCharacteristics }>)
      .map((h) => h.physicalCharacteristics!.heightBuild);
    const counts = new Map<string, number>();
    for (const b of builds) counts.set(b, (counts.get(b) ?? 0) + 1);
    for (const [, count] of counts) expect(count).toBeLessThanOrEqual(MAX_PER_HEIGHT_BUILD);
    expect(counts.size).toBeGreaterThanOrEqual(5);
  });
});

describe("G24/F — #1317: flipping genderPresentation measurably shifts build/hair vocabulary (root cause 3)", () => {
  const anchor = STYLE_ANCHOR_VARIANTS[0]!;
  const baseFacet: PhysicalCharacteristics = {
    heightBuild: "average height, athletic", skinTone: "olive complexion", hair: "shoulder-length auburn hair",
    facialFeatures: "an open friendly face", distinguishingMark: "none notable",
    ageLook: "settled, thirties presence", style: "sporty and laid-back",
  };
  // L29 (`momentOrchestration.test.ts`) requires the portrait's `Physical appearance:` clause to be
  // BYTE-IDENTICAL to `physicalFacetToAppearance(physicalCharacteristics)` — the exact string the
  // narrator context also voices verbatim, so words and picture can never diverge. The gender cue
  // therefore rides in its OWN separate "Build & hair styling:" clause, never inside the physical line.
  const stylingOf = (p: string) => p.match(/Build & hair styling: ([^.]+)\./)?.[1];
  const physOf = (p: string) => p.split("Physical appearance: ")[1]!.split(". ")[0]!;

  const promptFor = (gender: "man" | "woman" | "nonbinary") =>
    buildPortraitPrompt("hg:9", "A Houseguest", {
      appearance: "ignored", age: 33, presentation: "warm",
      physicalCharacteristics: baseFacet, genderPresentation: gender,
    }, anchor).prompt;

  it("the SAME stored facet gets a DIFFERENT gendered styling clause across man/woman/nonbinary", () => {
    const man = promptFor("man");
    const woman = promptFor("woman");
    const nb = promptFor("nonbinary");
    // All three carry the STORED base phrase verbatim, UNCHANGED (the L29 invariant holds)...
    const bareLook = [baseFacet.heightBuild, baseFacet.skinTone, baseFacet.hair, baseFacet.facialFeatures, baseFacet.ageLook].join(", ");
    for (const p of [man, woman, nb]) {
      expect(physOf(p)).toBe(bareLook);
      expect(p).toContain(baseFacet.heightBuild);
      expect(p).toContain(baseFacet.hair);
    }
    // ...but each carries its OWN "Build & hair styling:" clause, and the three differ pairwise.
    expect(stylingOf(man)).toBeTruthy();
    expect(stylingOf(woman)).toBeTruthy();
    expect(stylingOf(nb)).toBeTruthy();
    expect(stylingOf(man)).not.toBe(stylingOf(woman));
    expect(stylingOf(man)).not.toBe(stylingOf(nb));
    expect(stylingOf(woman)).not.toBe(stylingOf(nb));
  });

  it("with NO genderPresentation, there is no styling clause at all (back-compat, byte-identical to pre-#1317)", () => {
    const noGender = buildPortraitPrompt("hg:9", "A Houseguest", {
      appearance: "ignored", age: 33, presentation: "warm", physicalCharacteristics: baseFacet,
    }, anchor).prompt;
    expect(noGender).not.toContain("Build & hair styling:");
    expect(physOf(noGender)).toBe(
      [baseFacet.heightBuild, baseFacet.skinTone, baseFacet.hair, baseFacet.facialFeatures, baseFacet.ageLook].join(", "),
    );
  });

  it("the STORED facet object passed in is never mutated (prompt-assembly-time only — non-degradation, 0007/0031)", () => {
    const snapshot = { ...baseFacet };
    promptFor("woman");
    promptFor("man");
    promptFor("nonbinary");
    expect(baseFacet).toEqual(snapshot);
  });

  it("across a live cast, every gendered houseguest's prompt carries a Build & hair styling clause", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 909 });
    let checked = 0;
    for (const hg of view.house as ReadonlyArray<{
      id: string; physicalCharacteristics?: PhysicalCharacteristics; genderPresentation?: "man" | "woman" | "nonbinary";
    }>) {
      if (!hg.physicalCharacteristics || !hg.genderPresentation) continue;
      const pp = adapter.getPortraitPrompt(hg.id as EntityId)!;
      // The Physical appearance clause is UNTOUCHED (L29's shared-string invariant) — reconstructed
      // with the SAME rule `physicalFacetToAppearance` uses (skip a "none notable" mark).
      const f = hg.physicalCharacteristics;
      expect(physOf(pp.prompt)).toBe([f.heightBuild, f.skinTone, f.hair, f.facialFeatures, f.ageLook].join(", "));
      // ...while a separate styling clause carries the gender-aware build/hair vocabulary.
      expect(stylingOf(pp.prompt)).toBeTruthy();
      checked++;
    }
    expect(checked).toBeGreaterThan(0); // the sweep actually exercised gendered houseguests
  });
});
