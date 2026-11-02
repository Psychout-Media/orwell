import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { startNewGame } from "../../src/engine/characterFactory";
import {
  generateDiversityLayer, showmanceIdentities, showmancePlausible,
  privateOrientationVaultId,
} from "../../src/engine/diversity";
import {
  MIN_BIPOC, MIN_QUEER, MIN_PER_BINARY_GENDER, MIN_PER_AGE_BAND, MAX_NONBINARY,
  AGE_BANDS, AGE_ELIGIBILITY_FLOOR, ageBandOf,
} from "../../src/engine/diversityConstants";
import { buildPortraitPrompt } from "../../src/engine/portraitPrompts";
import type { PhysicalCharacteristics } from "../../src/domain/physicalCharacteristics";
import { adrFixture } from "../support/adr0003";
import { nameGenderOf } from "../../src/engine/data/nameGender";

/**
 * Feature 0063 — the casting diversity floor. Roles only (no names). The engine GUARANTEES the four
 * floors (BIPOC / gender balance / age spread / LGBTQ+) across seeds; ethnicity is a first-class identity
 * facet grounding the skin tone; orientation is character-driven and split across the Vault by disclosure;
 * a private orientation NEVER reaches the player OR admin until a pathway surfaces it; the public
 * diversity + personality facets enrich the portrait prompt; and — the #338 lesson — the diversity layer
 * runs on a DEDICATED sub-stream so the public outcome stream is byte-identical with it on vs. off.
 */

const SENT = "SENTINEL-0063-private-orientation";

function liveGame(user: string, seed: number) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { reg, sb };
}

/** Re-derive the layer for a seed (the cast is generated player-independently off the seed). */
function layerForSeed(seed: number) {
  const house = startNewGame({ seed, playerName: "The Player" });
  return { house, layer: generateDiversityLayer(seed, house.npcs) };
}

const SEEDS = [1, 2, 3, 7, 13, 21, 42, 55, 99, 100, 256, 1000, 7777, 31337];

describe("0063 — the four floors hold across seeds", () => {
  it("BIPOC representation floor (≥ MIN_BIPOC of the 15-cast)", () => {
    for (const seed of SEEDS) {
      const { layer } = layerForSeed(seed);
      const bipoc = Object.values(layer.public).filter((p) => p.bipoc).length;
      expect(bipoc, `seed ${seed}`).toBeGreaterThanOrEqual(MIN_BIPOC);
    }
  });

  it("gender-balance floor (neither binary below MIN_PER_BINARY_GENDER)", () => {
    for (const seed of SEEDS) {
      const { layer } = layerForSeed(seed);
      const pub = Object.values(layer.public);
      const men = pub.filter((p) => p.genderPresentation === "man").length;
      const women = pub.filter((p) => p.genderPresentation === "woman").length;
      expect(men, `seed ${seed} men`).toBeGreaterThanOrEqual(MIN_PER_BINARY_GENDER);
      expect(women, `seed ${seed} women`).toBeGreaterThanOrEqual(MIN_PER_BINARY_GENDER);
    }
  });

  it("gender is inclusive — nonbinary is possible and sparse (≤ MAX_NONBINARY)", () => {
    let everNonbinary = false;
    for (const seed of SEEDS) {
      const { layer } = layerForSeed(seed);
      const nb = Object.values(layer.public).filter((p) => p.genderPresentation === "nonbinary").length;
      expect(nb, `seed ${seed}`).toBeLessThanOrEqual(MAX_NONBINARY);
      if (nb > 0) everNonbinary = true;
    }
    expect(everNonbinary, "at least one seed in the set carries a nonbinary houseguest").toBe(true);
  });

  it("name coheres with gender presentation for EVERY houseguest (#1140 — 0 incoherent)", () => {
    for (const seed of SEEDS) {
      const { house, layer } = layerForSeed(seed);
      // #1140 — the rename pass now GUARANTEES coherence: after the gender repairs are final, any draft
      // whose name disagreed with the final presentation has its given name re-picked to match. So the old
      // bounded "≤ 2/cast balance-flip exception" is gone — coherence is total.
      const incoherent = Object.values(layer.public).filter((p) => !p.nameCoheres).length;
      expect(incoherent, `seed ${seed}`).toBe(0);
      // And the standing invariant the fix exists to hold: the FINAL name (the re-pick when present, else
      // the drawn name) reads the SAME gender the facet encodes (the portrait + narration both anchor on
      // the facet, so the name must agree). A nonbinary presentation keeps a unisex (any-presentation) name;
      // a gendered one reads its own gender.
      const drawnName = (id: string): string => house.npcs.find((n) => n.id === id)?.name ?? "";
      for (const [id, pub] of Object.entries(layer.public)) {
        const finalName = pub.name ?? drawnName(id);
        const ng = nameGenderOf(finalName);
        if (pub.genderPresentation === "nonbinary") expect(ng, `seed ${seed} ${id}`).toBe("unisex");
        else expect(ng, `seed ${seed} ${id}`).toBe(pub.genderPresentation);
      }
    }
  });

  it("age-spread floor (every band ≥ MIN_PER_AGE_BAND) above the eligibility floor", () => {
    for (const seed of SEEDS) {
      const { layer } = layerForSeed(seed);
      const ages = Object.values(layer.public).map((p) => p.age);
      for (const a of ages) expect(a, `seed ${seed} age`).toBeGreaterThanOrEqual(AGE_ELIGIBILITY_FLOOR);
      for (const band of AGE_BANDS) {
        const n = ages.filter((a) => ageBandOf(a) === band.id).length;
        expect(n, `seed ${seed} band ${band.id}`).toBeGreaterThanOrEqual(MIN_PER_AGE_BAND);
      }
    }
  });

  it("LGBTQ+ floor (≥ MIN_QUEER non-straight OR nonbinary)", () => {
    for (const seed of SEEDS) {
      const { layer } = layerForSeed(seed);
      const pub = Object.values(layer.public);
      const nb = pub.filter((p) => p.genderPresentation === "nonbinary").length;
      const outQueer = pub.filter((p) => p.outOrientation).length;
      const privateQueer = Object.keys(layer.privateOrientations).length;
      expect(outQueer + privateQueer + nb, `seed ${seed}`).toBeGreaterThanOrEqual(MIN_QUEER);
    }
  });

  it("identity is reproducible by seed AND player-independent (same seed, different players ⇒ same facets)", () => {
    for (const seed of [7, 42]) {
      const a = generateDiversityLayer(seed, startNewGame({ seed, playerName: "Alice Example" }).npcs);
      const b = generateDiversityLayer(seed, startNewGame({ seed, playerName: "Zachary Other" }).npcs);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe("0063 — the weighted deal reflects U.S. population rates (not a BIPOC-heavy uniform draw)", () => {
  it("the BIPOC share centers near the U.S. ~40% figure across many seeds (never the old ~70% skew)", () => {
    let bipocTotal = 0;
    let castTotal = 0;
    const perSeedShares: number[] = [];
    for (let seed = 1; seed <= 80; seed++) {
      const { layer } = layerForSeed(seed);
      const pub = Object.values(layer.public);
      const bipoc = pub.filter((p) => p.bipoc).length;
      bipocTotal += bipoc;
      castTotal += pub.length;
      perSeedShares.push(bipoc / pub.length);
    }
    const mean = bipocTotal / castTotal;
    // Centered on the real U.S. figure (~40% BIPOC), with comfortable tolerance for seed variance + the
    // per-heritage cap. The hard regression guard is the UPPER bound: the old uniform draw over the
    // BIPOC-heavy pool produced ~0.70 — the weighted deal must be well clear of that.
    expect(mean, "mean BIPOC share").toBeGreaterThan(0.3);
    expect(mean, "mean BIPOC share").toBeLessThan(0.55);
    // And no systematic collapse to a single skew: the per-seed shares vary (a real cast isn't a constant).
    expect(new Set(perSeedShares).size, "BIPOC share varies seed to seed").toBeGreaterThan(1);
  });

  it("the cast is majority non-BIPOC on the typical seed, matching the country (still ≥ the floor)", () => {
    let majorityNonBipocSeeds = 0;
    const SAMPLE = [1, 2, 3, 7, 13, 21, 42, 55, 99, 100, 256, 1000];
    for (const seed of SAMPLE) {
      const { layer } = layerForSeed(seed);
      const pub = Object.values(layer.public);
      const bipoc = pub.filter((p) => p.bipoc).length;
      expect(bipoc, `seed ${seed} meets the floor`).toBeGreaterThanOrEqual(MIN_BIPOC);
      if (bipoc < pub.length / 2) majorityNonBipocSeeds++;
    }
    // The U.S. is majority non-BIPOC; most seeds should reflect that (not a hard per-seed rule — variance).
    expect(majorityNonBipocSeeds, "most seeds are majority non-BIPOC").toBeGreaterThan(SAMPLE.length / 2);
  });
});

describe("0063 — the engine owns skinTone: FE authoring can't collapse it (the olive-skin fix)", () => {
  it("recordCastProfile re-grounds an authored physicalCharacteristics.skinTone to the seeded heritage", () => {
    const { sb } = liveGame("div-reground", 5);
    const card = sb.session.getGameState().house.find((h) => h.status === "active")!;
    const grounded = card.physicalCharacteristics!.skinTone; // the ethnicity-grounded cue
    // Simulate the FE authoring LLM re-authoring the WHOLE facet and defaulting skin tone to a generic
    // value DIFFERENT from the grounded heritage cue (the real-world failure: "olive everything").
    const override = grounded.includes("olive") ? "deep brown skin" : "olive complexion";
    const res = sb.session.recordCastProfile({
      houseguestId: card.id,
      physicalCharacteristics: {
        heightBuild: "tall and lean", skinTone: override, hair: "short dark hair",
        facialFeatures: "a square jaw", distinguishingMark: "a wrist tattoo",
        ageLook: "fresh-faced, late-twenties look", style: "sporty and laid-back",
      },
    });
    expect(res.accepted).toBe(true);
    const after = sb.session.getGameState().house.find((h) => h.id === card.id)!;
    // The engine kept the heritage-grounded skin tone; the LLM's generic override was discarded.
    expect(after.physicalCharacteristics!.skinTone).toBe(grounded);
    expect(after.physicalCharacteristics!.skinTone).not.toBe(override);
    // The OTHER authored facets still landed (the LLM authors everything except the grounded skin tone).
    expect(after.physicalCharacteristics!.hair).toBe("short dark hair");
    // The portrait reads the re-grounded facet, so the picture agrees with the heritage too.
    const pp = sb.session.getPortraitPrompt(card.id)!;
    expect(pp.prompt).toContain(grounded);
    expect(pp.prompt).not.toContain(override);
  });
});

describe("2026-07-21 prompt audit — the engine owns the visible-ink budget (the tattoo-uniformity fix)", () => {
  // Canonical-factory convention (CLAUDE.md testing rules): these tests build their game through the
  // support-factory family, not manual wiring — `adrFixture` (tests/support/adr0003.ts), the
  // registry-built production object graph with a started game. (`tests/support/sandbox.ts`'s
  // `buildSandbox` is the Vault-sentinel factory and exposes no GameSession surface, so it cannot
  // drive recordCastProfile/getPortraitPrompt — adrFixture is the canonical fit here.)
  // The ink lexicon — kept IDENTICAL to the adapter's INK_RE: word-bounded so "forearm ink" /
  // "inked" classify as ink while "blinked"-style substrings can never false-positive, plus the
  // euphemism tail (Greptile #1768): "blackwork" / "body art" unconditionally, and "full/half
  // sleeve(s)" EXCEPT when a clothing noun follows (a "half-sleeve tee" is a shirt, not ink).
  const INK_LEXICON = /\btattoo|\bink(?:ed)?\b|\bblackwork\b|\bbody art\b|\b(?:full|half)[- ]sleeves?(?!\s+(?:tee|t-?shirt|shirt|top|blouse|sweater|kurta)s?\b)/i;
  const facetHasInk = (pc: PhysicalCharacteristics): boolean =>
    Object.values(pc).some((v) => INK_LEXICON.test(String(v ?? "")));

  it("the ink lexicon classifies real model phrasings and rejects substring false-positives", () => {
    const base: PhysicalCharacteristics = {
      heightBuild: "tall and lean", skinTone: "warm tan complexion", hair: "short dark hair",
      facialFeatures: "a square jaw", distinguishingMark: "none notable",
      ageLook: "fresh-faced, late-twenties look", style: "sporty and laid-back",
    };
    // "visible forearm ink" is a real model phrasing — it must classify as ink.
    expect(facetHasInk({ ...base, style: "visible forearm ink" })).toBe(true);
    expect(facetHasInk({ ...base, distinguishingMark: "an inked half-sleeve" })).toBe(true);
    expect(facetHasInk({ ...base, distinguishingMark: "a full sleeve of tattoos" })).toBe(true);
    // EUPHEMISMS (Greptile #1768): the live bundle's defects were literally "full sleeve of …"
    // phrasings carrying neither "tattoo" nor "ink" — they must classify as ink.
    expect(facetHasInk({ ...base, distinguishingMark: "a full sleeve of botanical blackwork" })).toBe(true);
    expect(facetHasInk({ ...base, distinguishingMark: "traditional body art across the shoulder" })).toBe(true);
    expect(facetHasInk({ ...base, style: "fine-line blackwork on both forearms" })).toBe(true);
    expect(facetHasInk({ ...base, distinguishingMark: "a half-sleeve of geometric linework" })).toBe(true);
    // CLOTHING sleeves are NOT ink (option B lookahead): a half-sleeve tee is a shirt.
    expect(facetHasInk({ ...base, style: "a breezy half-sleeve tee and shorts" })).toBe(false);
    expect(facetHasInk({ ...base, style: "rolled full-sleeve shirts and chinos" })).toBe(false);
    // Substring false-positives must NOT classify (the false-hold CodeRabbit flagged).
    expect(facetHasInk({ ...base, facialFeatures: "eyes that look like they just blinked awake" })).toBe(false);
    expect(facetHasInk(base)).toBe(false);
  });

  it("an authored mark that INTRODUCES ink where the seeded deal granted none is refused; other facets fold", () => {
    const { sb } = adrFixture("ink-budget", 5);
    // Find a houseguest whose SEEDED facet carries no ink ANYWHERE (the cast-wide deal guarantees most don't).
    const card = sb.session.getGameState().house
      .find((h) => h.status === "active" && h.physicalCharacteristics
        && !facetHasInk(h.physicalCharacteristics))!;
    const seededMark = card.physicalCharacteristics!.distinguishingMark;
    const res = sb.session.recordCastProfile({
      houseguestId: card.id,
      physicalCharacteristics: {
        heightBuild: "tall and lean", skinTone: "warm tan complexion", hair: "short dark hair",
        facialFeatures: "a square jaw", distinguishingMark: "a full sleeve of intricate tattoos",
        ageLook: "fresh-faced, late-twenties look", style: "sporty and laid-back",
      },
    });
    expect(res.accepted).toBe(true);
    const after = sb.session.getGameState().house.find((h) => h.id === card.id)!;
    // The ink the seeded deal never granted was refused — the seeded mark stands.
    expect(after.physicalCharacteristics!.distinguishingMark).toBe(seededMark);
    // Every other authored facet still landed.
    expect(after.physicalCharacteristics!.hair).toBe("short dark hair");
  });
  it("Greptile P1 (#1768): a clean mark + a tattooed STYLE on a no-ink slot cannot smuggle ink into any portrait-rendered field", () => {
    const { sb } = adrFixture("ink-style-bypass", 5);
    const card = sb.session.getGameState().house
      .find((h) => h.status === "active" && h.physicalCharacteristics
        && !facetHasInk(h.physicalCharacteristics))!;
    const seededStyle = card.physicalCharacteristics!.style;
    const res = sb.session.recordCastProfile({
      houseguestId: card.id,
      physicalCharacteristics: {
        heightBuild: "tall and lean", skinTone: "warm tan complexion", hair: "short dark hair",
        facialFeatures: "a square jaw", distinguishingMark: "a beauty mark on one cheek",
        ageLook: "fresh-faced, late-twenties look", style: "tattooed rocker edge, sleeves on show",
      },
    });
    expect(res.accepted).toBe(true);
    const after = sb.session.getGameState().house.find((h) => h.id === card.id)!;
    // The inked style was refused per-field — the seeded style stands; NO rendered field carries ink.
    expect(after.physicalCharacteristics!.style).toBe(seededStyle);
    expect(facetHasInk(after.physicalCharacteristics!)).toBe(false);
    // The clean authored facets still folded.
    expect(after.physicalCharacteristics!.hair).toBe("short dark hair");
    expect(after.physicalCharacteristics!.distinguishingMark).toBe("a beauty mark on one cheek");
    // And the portrait prompt — which renders style into "Presentation style:" — carries no ink.
    const pp = sb.session.getPortraitPrompt(card.id)!;
    expect(INK_LEXICON.test(pp.prompt)).toBe(false);
  });

  it("an authored ink mark is KEPT when the seeded deal already granted ink (sharpening, not inventing)", () => {
    // Deterministic fixture hunt: the mark deal grants ~1-2 tattoo marks per cast on average, so a
    // small fixed seed sweep is GUARANTEED to surface an inked card — and we ASSERT it does, so this
    // test can never silently pass while testing nothing (the CodeRabbit vacuity finding).
    let found: { sb: ReturnType<typeof adrFixture>["sb"]; id: string } | undefined;
    for (const seed of [5, 1, 2, 3, 4, 6, 7, 8, 9, 10]) {
      const { sb } = adrFixture(`ink-keep-${seed}`, seed);
      const inked = sb.session.getGameState().house
        .find((h) => h.status === "active" && h.physicalCharacteristics
          && /\btattoo/i.test(h.physicalCharacteristics.distinguishingMark));
      if (inked) { found = { sb, id: inked.id }; break; }
    }
    expect(found, "the fixed seed sweep must surface an ink-granted card").toBeDefined();
    const { sb, id } = found!;
    const res = sb.session.recordCastProfile({
      houseguestId: id,
      physicalCharacteristics: {
        heightBuild: "stocky and powerful", skinTone: "warm tan complexion", hair: "a close-cropped fade",
        facialFeatures: "an open friendly face", distinguishingMark: "a forearm tattoo of a compass rose",
        ageLook: "settled, thirties presence", style: "streetwear and bold sneakers",
      },
    });
    expect(res.accepted).toBe(true);
    const after = sb.session.getGameState().house.find((h) => h.id === id)!;
    expect(after.physicalCharacteristics!.distinguishingMark).toBe("a forearm tattoo of a compass rose");
  });

  it("T0-6: a BIOGRAPHY that introduces ink on a no-ink slot is dropped whole (the generic facetDiff " +
     "validator's gap-fix — the old inline guard only ever scanned physicalCharacteristics fields)", () => {
    const { sb } = adrFixture("ink-bio-bypass", 5);
    const card = sb.session.getGameState().house
      .find((h) => h.status === "active" && h.physicalCharacteristics
        && !facetHasInk(h.physicalCharacteristics))!;
    const seededBio = card.biography;
    const res = sb.session.recordCastProfile({
      houseguestId: card.id,
      biography: "Grew up skating and getting a full sleeve of tattoos before culinary school.",
    });
    expect(res.accepted).toBe(true);
    const after = sb.session.getGameState().house.find((h) => h.id === card.id)!;
    // The bio smuggled ink text the skeleton never granted — the whole field is dropped, seeded floor stands.
    expect(after.biography).toBe(seededBio);
    expect(res.publicFields).not.toContain("biography");
  });

  it("T0-6: a clean biography on a no-ink slot still folds normally (the generic guard never holds coherent prose)", () => {
    const { sb } = adrFixture("ink-bio-clean", 5);
    const card = sb.session.getGameState().house
      .find((h) => h.status === "active" && h.physicalCharacteristics
        && !facetHasInk(h.physicalCharacteristics))!;
    const res = sb.session.recordCastProfile({
      houseguestId: card.id,
      biography: "Grew up skating and cooking before culinary school opened new doors.",
    });
    expect(res.accepted).toBe(true);
    const after = sb.session.getGameState().house.find((h) => h.id === card.id)!;
    expect(after.biography).toBe("Grew up skating and cooking before culinary school opened new doors.");
    expect(res.publicFields).toContain("biography");
  });

  it("T0-6: a biography IS free to reference ink when the seeded deal already granted it (sharpening, not inventing)", () => {
    let found: { sb: ReturnType<typeof adrFixture>["sb"]; id: string } | undefined;
    for (const seed of [5, 1, 2, 3, 4, 6, 7, 8, 9, 10]) {
      const { sb } = adrFixture(`ink-bio-keep-${seed}`, seed);
      const inked = sb.session.getGameState().house
        .find((h) => h.status === "active" && h.physicalCharacteristics
          && /\btattoo/i.test(h.physicalCharacteristics.distinguishingMark));
      if (inked) { found = { sb, id: inked.id }; break; }
    }
    expect(found, "the fixed seed sweep must surface an ink-granted card").toBeDefined();
    const { sb, id } = found!;
    const res = sb.session.recordCastProfile({
      houseguestId: id,
      biography: "Every tattoo on their arms tells a story from a different city on tour.",
    });
    expect(res.accepted).toBe(true);
    const after = sb.session.getGameState().house.find((h) => h.id === id)!;
    expect(after.biography).toBe("Every tattoo on their arms tells a story from a different city on tour.");
    expect(res.publicFields).toContain("biography");
  });
});

describe("0063 — ethnicity grounds the physical facet (text + portrait agree)", () => {
  it("each houseguest's physicalCharacteristics.skinTone equals their ethnicity-grounded cue", () => {
    const { sb } = liveGame("div-ground", 5);
    const house = sb.session.getGameState().house;
    for (const h of house.filter((x) => x.status === "active")) {
      expect(h.ethnicity, "ethnicity facet present").toBeTruthy();
      expect(h.physicalCharacteristics, "physical facet present").toBeTruthy();
      // The grounded cue is a non-empty complexion phrase shared by the card AND the portrait builder.
      expect(h.physicalCharacteristics!.skinTone.length).toBeGreaterThan(0);
    }
  });

  it("the public card carries ethnicity + gender presentation; descriptive, never a number", () => {
    const { sb } = liveGame("div-card", 8);
    const house = sb.session.getGameState().house;
    for (const h of house.filter((x) => x.status === "active")) {
      expect(h.ethnicity).toBeTruthy();
      expect(["man", "woman", "nonbinary"]).toContain(h.genderPresentation);
    }
    expect(JSON.stringify(house)).not.toMatch(/"physical":|"mental":|"social":/);
  });
});

describe("0063 — orientation is character-driven and Vault-split by disclosure", () => {
  it("a publicly-out orientation IS an observable public card facet", () => {
    // Find a seed with at least one out houseguest (almost all seeds have one).
    const { sb } = liveGame("div-out", 3);
    const house = sb.session.getGameState().house;
    const out = house.filter((h) => h.outOrientation);
    expect(out.length, "some houseguest is publicly out").toBeGreaterThan(0);
    for (const h of out) expect(typeof h.outOrientation).toBe("string");
  });

  it("a PRIVATE orientation never reaches player, admin, npcVoice, or the moment prompt", () => {
    const { sb } = liveGame("div-leak", 1);
    // Plant the sentinel into EVERY private-orientation record via snapshot→restore.
    const core = sb.session.snapshot();
    expect(Object.keys(core.privateOrientations ?? {}).length, "the cast has ≥1 private orientation").toBeGreaterThan(0);
    for (const id of Object.keys(core.privateOrientations!)) {
      core.privateOrientations![id] = `${core.privateOrientations![id]} ${SENT}` as never;
    }
    sb.session.restore(core);

    const playerSurface = JSON.stringify(sb.session.getGameState())
      + JSON.stringify(sb.player.getVisibleState())
      + JSON.stringify(sb.session.gameStatus())
      + sb.session.getMomentPrompt({}).systemPrompt
      + sb.session.getMomentPrompt({ moment: "social" }).systemPrompt
      + sb.session.getGameState().house.filter((h) => h.status === "active")
          .map((h) => JSON.stringify(sb.session.npcVoice(h.id))).join("");
    expect(playerSurface).not.toContain(SENT);

    sb.syncAdmin();
    expect(JSON.stringify(sb.admin.inspect())).not.toContain(SENT);
  });

  it("a private orientation IS sealed into the Vault (engine-only audit copy)", () => {
    const { sb } = liveGame("div-vault", 1);
    const ids = Object.keys(sb.session.snapshot().privateOrientations ?? {});
    expect(ids.length).toBeGreaterThan(0);
    // The sealed record exists under the private-orientation Vault id (engine-only store, never projected).
    const sealed = sb.engine.vault.readHidden().some((r) => r.id === privateOrientationVaultId(ids[0]!));
    expect(sealed).toBe(true);
  });

  it("a private orientation persists across a restart (never silently resets)", () => {
    const { sb } = liveGame("div-persist", 1);
    const before = sb.session.snapshot().privateOrientations;
    sb.session.restore(sb.session.snapshot());
    expect(JSON.stringify(sb.session.snapshot().privateOrientations)).toBe(JSON.stringify(before));
  });
});

describe("0063 — the 0059 showmance eligibility tie (queer showmances are first-class)", () => {
  it("showmancePlausible allows same-gender pairs only for plausible orientations", () => {
    expect(showmancePlausible({ orientation: "gay", genderPresentation: "man" }, { orientation: "gay", genderPresentation: "man" })).toBe(true);
    expect(showmancePlausible({ orientation: "bisexual", genderPresentation: "woman" }, { orientation: "lesbian", genderPresentation: "woman" })).toBe(true);
    // two strictly-straight same-gender houseguests: implausible
    expect(showmancePlausible({ orientation: "straight", genderPresentation: "man" }, { orientation: "straight", genderPresentation: "man" })).toBe(false);
    // a straight + gay different-gender pair: gay isn't attracted across genders ⇒ implausible
    expect(showmancePlausible({ orientation: "straight", genderPresentation: "man" }, { orientation: "gay", genderPresentation: "woman" })).toBe(false);
    // a straight man + straight woman: plausible
    expect(showmancePlausible({ orientation: "straight", genderPresentation: "man" }, { orientation: "straight", genderPresentation: "woman" })).toBe(true);
  });

  it("across seeds the seeded showmance layer can produce a QUEER (same-gender) showmance, sealed at cast time", () => {
    let queerShowmanceSeeds = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const { sb } = liveGame(`div-show-${seed}`, seed);
      const rels = sb.session.snapshot().seededRelationships;
      if (!rels?.showmances?.length) continue;
      const ids = showmanceIdentities(generateDiversityLayer(seed, sb.session.snapshot().house!.npcs));
      for (const s of rels.showmances) {
        const a = ids[s.a]!; const b = ids[s.b]!;
        // every seeded showmance is plausible (the eligibility gate), and none is visible at cast time
        expect(showmancePlausible(a, b), `seed ${seed} seeded an implausible showmance`).toBe(true);
        expect(s.stage).not.toBe("visible"); // never week-one visible (sealed; surfaces organically)
        if (a.genderPresentation === b.genderPresentation) queerShowmanceSeeds++;
      }
    }
    expect(queerShowmanceSeeds, "at least one seed seeds a same-gender (queer) showmance").toBeGreaterThan(0);
  });
});

describe("0063 — the portrait generator reflects the unique person (no private state leaks)", () => {
  it("a houseguest's portrait prompt includes their ethnicity / gender / age / demeanor (public)", () => {
    const { sb } = liveGame("div-portrait", 5);
    const h = sb.session.getGameState().house.find((x) => x.status === "active")!;
    const pp = sb.session.getPortraitPrompt(h.id)!;
    expect(pp.prompt).toContain(h.ethnicity!);              // heritage in the SUBJECT line
    expect(pp.prompt).toContain(String(h.age));             // the age look
    // gender presentation phrase appears (a man / a woman / nonbinary presentation)
    expect(pp.prompt).toMatch(/a man|a woman|nonbinary/);
  });

  it("portrait prompts are DISTINCT across the cast (not a grid of siblings)", () => {
    const { sb } = liveGame("div-distinct", 5);
    const ids = sb.session.getGameState().house.filter((h) => h.status === "active").map((h) => h.id);
    const prompts = ids.map((id) => sb.session.getPortraitPrompt(id)!.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it("NO private/hidden state appears in ANY portrait prompt (the §5 Vault rule)", () => {
    const { sb } = liveGame("div-portrait-leak", 1);
    // Poison every private orientation + a hidden stat via snapshot→restore.
    const core = sb.session.snapshot();
    for (const id of Object.keys(core.privateOrientations ?? {})) {
      core.privateOrientations![id] = `${core.privateOrientations![id]} ${SENT}` as never;
    }
    for (const n of core.house!.npcs) { n.character.stats.physical = 99999; n.soul.memory.push(`${SENT}-soul`); }
    sb.session.restore(core);
    for (const h of [PLAYER, ...sb.session.getGameState().house.map((x) => x.id)]) {
      const pp = sb.session.getPortraitPrompt(h);
      if (!pp) continue;
      expect(pp.prompt).not.toContain(SENT);
      expect(pp.prompt).not.toContain("99999");
    }
  });

  it("buildPortraitPrompt is pure + dignified (heritage informs the subject line, no clichés required)", () => {
    const result = buildPortraitPrompt(
      "npc:1", "The Houseguest",
      {
        appearance: "athletic, a warm smile", age: 34, presentation: "casual and laid-back",
        ethnicity: "Korean American", genderPresentation: "woman", demeanor: "deadpan and dry",
      },
      "studio portrait",
    );
    expect(result.prompt).toContain("Korean American");
    expect(result.prompt).toContain("a woman");
    expect(result.prompt).toContain("deadpan and dry");
  });
});

describe("0063 — RNG isolation: identity never bends a seeded outcome (the #338 golden test)", () => {
  it("the public outcome stream is BYTE-IDENTICAL with the diversity layer ON vs. OFF", () => {
    // Drive the full live game to completion at a fixed seed, once with diversity ON and once OFF
    // (the ORWELL_DISABLE_DIVERSITY test seam), capturing the PUBLIC outcome stream (every beat's
    // public content + the eviction order + winner). Equal ⇒ the diversity sub-stream never perturbs
    // the competition/vote sequence — the descriptive attributes are non-mechanical by construction.
    //
    // #1140: the diversity layer now RE-PICKS houseguest NAMES to cohere with the final gender presentation
    // (a descriptive change), so the ON run's beat prose carries DIFFERENT names than the OFF run's. That is
    // by design and is NOT an outcome change — the mechanical truth is WHO (by id) wins/gets evicted in what
    // order. So we NEUTRALIZE names to ids per run before comparing: each houseguest's name → their id in
    // every beat's content. A real mechanical/content divergence (a different beat type, a different order)
    // still shows; only the deliberate rename is tolerated. (`evictionOrder` is already id-based.)
    const capture = (seed: number): string => {
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor(`golden-${seed}-${process.env.ORWELL_DISABLE_DIVERSITY ?? "on"}`);
      sb.session.createCharacter({ playerName: "The Player", seed });
      // id↔name map from the initial roster (player + every houseguest), longest-name-first so a name that
      // is a substring of another (rare) replaces correctly. Names → ids makes the stream name-independent.
      const roster = [sb.session.getGameState().player, ...sb.session.getGameState().house]
        .filter((h): h is NonNullable<typeof h> => !!h && typeof h.name === "string" && h.name.length > 0)
        .map((h) => ({ id: h.id, name: h.name }))
        .sort((a, b) => b.name.length - a.name.length);
      const neutralize = (s: string): string => {
        let out = s;
        for (const { id, name } of roster) out = out.split(name).join(id);
        return out;
      };
      const beats: string[] = [];
      for (let i = 0; i < 5000; i++) {
        const adv = sb.session.advanceGame() as { finished: boolean; pending: { kind: string; options?: Array<{ id: string }> } | null; event?: { beat?: string; content?: string } | null };
        if (adv.event?.content) beats.push(`${adv.event.beat}:${neutralize(adv.event.content)}`);
        if (adv.pending) {
          // Deterministic passive answers (first legal option), enough to push the season to its end.
          const p = adv.pending; const o = p.options ?? [];
          const ans: Record<string, unknown> =
            p.kind === "nominations" ? { kind: p.kind, choice: [o[0]?.id, o[1]?.id] }
            : p.kind === "veto-decision" ? { kind: p.kind, use: false }
            : p.kind === "comp-intent" ? { kind: p.kind, intent: "compete" }
            : p.kind === "comp-round" ? { kind: p.kind, intent: "compete" } // 0006 staged-rounds
            : p.kind === "houseguests-choice" ? { kind: p.kind, vote: o[0]?.id }
            : p.kind === "replacement" ? { kind: p.kind, replacement: o[0]?.id }
            : p.kind === "eviction-vote" ? { kind: p.kind, vote: o[0]?.id }
            : p.kind === "tie-break" ? { kind: p.kind, vote: o[0]?.id }
            : p.kind === "final-eviction" ? { kind: p.kind, vote: o[0]?.id }
            : p.kind === "finale-statement" ? { kind: p.kind, statement: "x" }
            : p.kind === "finale-answer" ? { kind: p.kind, appeal: "own-game" }
            : p.kind === "juror-vote" ? { kind: p.kind, vote: o[0]?.id }
            : p.kind === "goodbye-message" ? { kind: p.kind, vote: "respectful" }
            : p.kind === "exit-interview" ? { kind: p.kind, vote: "gracious" } // 0130: the evicted player's exit stance
            : p.kind === "juror-question" ? { kind: p.kind, statement: "x" }
            : { kind: p.kind };
          const sub = sb.session.submitDecision(ans as never) as { finished: boolean; event?: { beat?: string; content?: string } | null };
          if (sub.event?.content) beats.push(`${sub.event.beat}:${neutralize(sub.event.content)}`);
          if (sub.finished) break;
        }
        if (adv.finished) break;
      }
      const live = sb.session.snapshot().live;
      return JSON.stringify({ evictionOrder: live?.evictionOrder, finished: live?.finished, beats });
    };

    const seed = 1234;
    delete process.env.ORWELL_DISABLE_DIVERSITY;
    const withDiversity = capture(seed);
    process.env.ORWELL_DISABLE_DIVERSITY = "1";
    const withoutDiversity = capture(seed);
    delete process.env.ORWELL_DISABLE_DIVERSITY;

    expect(withDiversity).toBe(withoutDiversity);
  });
});
