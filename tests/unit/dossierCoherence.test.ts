import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateDossierCoherence,
  repairDossierCoherence,
  scrubSelfReferentialPronouns,
  type DossierForCoherence,
} from "../../src/engine/castingIntake";
import { buildPortraitPrompt } from "../../src/engine/portraitPrompts";
import { genderPresentationPhrase } from "../../src/domain/gender";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/**
 * Feature 0116 / RC5 — cast-identity coherence.
 *
 * A model-authored dossier is assembled from three model calls, so a houseguest can ship INTERNALLY
 * CONTRADICTORY (the live bundle: `genderPresentation:'man'` with `she`/`her` self-references and a
 * `his forearm` mark — Lily Evans npc:13; a "spent thirty years / grandmother" bio on a 22-year-old —
 * Donna; a public vocation disagreeing with the cover-story vocation — concierge/bar). The validator is
 * the enforcement spine: the pinned `genderPresentation` is authoritative and every self-referential
 * field must agree with it. Roles only — no fixture names ingested as data.
 */

/** A clean, coherent dossier the validator must pass. Roles only, no ingested identities. */
function coherentDossier(gender: "man" | "woman" | "nonbinary", i: number): DossierForCoherence {
  const p = gender === "man" ? "he" : gender === "woman" ? "she" : "they";
  const poss = gender === "man" ? "his" : gender === "woman" ? "her" : "their";
  return {
    genderPresentation: gender,
    appearance: `athletic build; ${poss} hair is close-cropped`,
    demeanor: `warm but guarded — ${p} keeps the room at arm's length`,
    distinguishingMark: `a small scar on ${poss} left forearm`,
    biography: `Grew up on a farm and moved to the city for work. Spent ${2 + (i % 5)} years bartending before the show.`,
    age: 24 + (i % 30),
    vocation: "court reporter",
    coverVocation: "court reporter",
    physicalCharacteristics: {
      distinguishingMark: `a faint scar on ${poss} jaw`,
      facialFeatures: "strong brow, easy smile",
      hair: "close-cropped",
      heightBuild: "tall and lean",
    },
  };
}

describe("validateDossierCoherence — the Lily Evans internal-contradiction fixture", () => {
  it("REJECTS a 'man' dossier carrying 'her shyness' + 'his forearm'", () => {
    // The Lily Evans object shape (genderPresentation:'man' + 'her shyness' + 'his forearm'): the mark
    // agrees with the pin, the demeanor contradicts it — one person called both he and she.
    const lily: DossierForCoherence = {
      genderPresentation: "man",
      demeanor: "quiet — her shyness reads as aloofness",
      distinguishingMark: "a tattoo running down his left forearm",
      appearance: "slight build, watchful eyes",
      age: 27,
    };
    const res = validateDossierCoherence(lily);
    expect(res.ok).toBe(false);
    expect(res.contradictions.some((c) => c.severity === "hard")).toBe(true);
    // The contradicting field (the demeanor, opposite the pinned 'man') is flagged for re-author; the
    // mark ('his', consistent with the pin) is NOT cleared.
    expect(res.repairFields).toContain("demeanor");
    expect(res.repairFields).not.toContain("distinguishingMark");
  });

  it("repair clears ONLY the contradicting field and never the pinned gender spine", () => {
    const lily: DossierForCoherence = {
      genderPresentation: "man",
      demeanor: "her shyness reads as aloofness",
      distinguishingMark: "a scar on his forearm",
      age: 30,
    };
    const { repaired, repairedFields } = repairDossierCoherence(lily);
    expect(repairedFields).toEqual(["demeanor"]);
    expect(repaired.demeanor).toBeUndefined();
    expect(repaired.genderPresentation).toBe("man"); // spine preserved
    expect(repaired.distinguishingMark).toBe("a scar on his forearm"); // consistent field kept
    // The repaired dossier is now coherent.
    expect(validateDossierCoherence(repaired).ok).toBe(true);
  });

  it("REJECTS a field that mixes both masculine and feminine self-references", () => {
    const res = validateDossierCoherence({
      genderPresentation: "nonbinary",
      appearance: "his broad shoulders and her delicate hands", // one field, both genders
      age: 25,
    });
    expect(res.ok).toBe(false);
    expect(res.repairFields).toContain("appearance");
  });
});

describe("validateDossierCoherence — age vs biography year-spans (Donna)", () => {
  it("REJECTS 'spent thirty years / grandmother' on a 22-year-old", () => {
    const donna: DossierForCoherence = {
      genderPresentation: "woman",
      biography: "A devoted grandmother who spent thirty years running a diner in her hometown.",
      age: 22,
    };
    const res = validateDossierCoherence(donna);
    expect(res.ok).toBe(false);
    expect(res.repairFields).toContain("biography");
  });

  it("accepts a plausible span (20 years at age 45)", () => {
    const res = validateDossierCoherence({
      genderPresentation: "woman",
      biography: "Spent twenty years as a nurse before applying.",
      age: 45,
    });
    expect(res.ok).toBe(true);
  });
});

describe("validateDossierCoherence — vocation vs cover-story vocation", () => {
  it("REJECTS a public vocation that shares no word with the cover story (concierge vs bar)", () => {
    const res = validateDossierCoherence({
      genderPresentation: "man",
      vocation: "hotel concierge",
      coverVocation: "bartender at a downtown bar",
      age: 34,
    });
    expect(res.ok).toBe(false);
    expect(res.repairFields).toContain("vocation");
  });

  it("accepts a vocation that overlaps the cover story (ER nurse / nurse)", () => {
    const res = validateDossierCoherence({
      genderPresentation: "woman",
      vocation: "ER nurse",
      coverVocation: "nurse",
      age: 31,
    });
    expect(res.ok).toBe(true);
  });
});

describe("validateDossierCoherence — name/ethnicity divergence is SOFT (never rejected)", () => {
  it("a gendered-name/gender mismatch does not fail ok (the engine allows the name to diverge)", () => {
    // A unisex/flipped name is a deliberate diversity choice; the validator must not hard-reject on it.
    const res = validateDossierCoherence({
      genderPresentation: "woman",
      appearance: "she wears her hair long", // self-references agree with the pin
      demeanor: "she is warm and open",
      age: 29,
      vocation: "teacher",
    });
    expect(res.ok).toBe(true);
  });
});

describe("F5 — name↔gender is asserted as a SOFT flag (surfaced, never rejected)", () => {
  it("a given name reading the OPPOSITE binary gender is a SOFT contradiction, ok stays true", () => {
    // A man-reading given name pinned 'woman' — surfaced (the #1140 re-pick that should have cohered it
    // upstream degraded), but SOFT so the dossier is not rejected and no re-author is forced.
    const res = validateDossierCoherence({ genderPresentation: "woman", name: "James Rivera", age: 29 });
    const flag = res.contradictions.find((c) => c.field === "name");
    expect(flag).toBeTruthy();
    expect(flag!.severity).toBe("soft");
    expect(res.ok).toBe(true); // soft never fails ok
    expect(res.repairFields).not.toContain("name"); // and never enters the repair set
  });

  it("a UNISEX name never trips the assertion (coherent with any presentation)", () => {
    for (const g of ["man", "woman", "nonbinary"] as const) {
      const res = validateDossierCoherence({ genderPresentation: g, name: "Jordan Rivera", age: 30 });
      expect(res.contradictions.some((c) => c.field === "name")).toBe(false);
    }
  });

  it("a NONBINARY pin is never flagged for a gendered name (nonbinary is never flattened)", () => {
    const res = validateDossierCoherence({ genderPresentation: "nonbinary", name: "James Rivera", age: 26 });
    expect(res.contradictions.some((c) => c.field === "name")).toBe(false);
    expect(res.ok).toBe(true);
  });

  it("a same-gender name is clean", () => {
    expect(validateDossierCoherence({ genderPresentation: "man", name: "James Rivera", age: 33 }).ok).toBe(true);
  });
});

describe("F5 — appearance / distinguishing-mark self-pronouns are SCRUBBED to the pin (not blanked)", () => {
  it("scrubSelfReferentialPronouns rewrites opposite-gender pronouns, preserving detail + case", () => {
    // woman pin: masculine → feminine, keeping the descriptive detail and leading-cap.
    expect(scrubSelfReferentialPronouns("His left eyebrow is scarred; he squints.", "woman"))
      .toBe("Her left eyebrow is scarred; she squints.");
    // man pin: feminine → masculine; a matching pronoun is left alone.
    expect(scrubSelfReferentialPronouns("her hazel eyes and his easy smile", "man"))
      .toBe("his hazel eyes and his easy smile");
    // nonbinary pin: BOTH genders neutralized to singular they/their — never flattened to a binary.
    expect(scrubSelfReferentialPronouns("his broad shoulders and her delicate hands", "nonbinary"))
      .toBe("their broad shoulders and their delicate hands");
  });

  it("repair SCRUBS the appearance pronoun instead of clearing the field, and re-validates clean", () => {
    const d: DossierForCoherence = {
      genderPresentation: "woman",
      appearance: "athletic build; his left eyebrow carries a faint scar",
      age: 28,
    };
    const { repaired, repairedFields } = repairDossierCoherence(d);
    expect(repairedFields).toContain("appearance");
    // The descriptive detail SURVIVES with the corrected pronoun — the field is NOT blanked.
    expect(repaired.appearance).toBe("athletic build; her left eyebrow carries a faint scar");
    expect(validateDossierCoherence(repaired).ok).toBe(true);
  });

  it("repair SCRUBS the structured distinguishing mark the portrait prompt reads", () => {
    const d: DossierForCoherence = {
      genderPresentation: "man",
      physicalCharacteristics: { distinguishingMark: "a tattoo running down her left forearm" },
      age: 31,
    };
    const { repaired } = repairDossierCoherence(d);
    expect(repaired.physicalCharacteristics?.distinguishingMark).toBe("a tattoo running down his left forearm");
    expect(validateDossierCoherence(repaired).ok).toBe(true);
  });
});

describe("nonbinary pin — a lone BINARY self-pronoun is flagged for repair (SOFT, ok stays true)", () => {
  it("flags a nonbinary appearance carrying a masculine self-pronoun, without failing ok", () => {
    // Greptile P1: a nonbinary pin has no OPPOSITE binary gender, so the man/woman branch never fires — yet
    // "his left eyebrow" ships a binary pronoun on a nonbinary houseguest. It must be flagged for repair.
    const res = validateDossierCoherence({
      genderPresentation: "nonbinary",
      appearance: "his left eyebrow is scarred",
      age: 26,
    });
    expect(res.ok).toBe(true); // SOFT — never fails ok (the dossier is not rejected)
    expect(res.repairFields).toContain("appearance");
    const flag = res.contradictions.find((c) => c.field === "appearance");
    expect(flag).toBeTruthy();
    expect(flag!.severity).toBe("soft");
  });

  it("flags a feminine self-pronoun on a nonbinary pin the same way", () => {
    const res = validateDossierCoherence({
      genderPresentation: "nonbinary",
      distinguishingMark: "a scar on her left forearm",
      age: 30,
    });
    expect(res.ok).toBe(true);
    expect(res.repairFields).toContain("distinguishingMark");
  });

  it("repair SCRUBS a nonbinary appearance's binary pronoun to singular they/their, keeping the detail", () => {
    const d: DossierForCoherence = {
      genderPresentation: "nonbinary",
      appearance: "his left eyebrow is scarred",
      age: 26,
    };
    const { repaired, repairedFields } = repairDossierCoherence(d);
    expect(repairedFields).toContain("appearance");
    expect(repaired.appearance).toBe("their left eyebrow is scarred");
    // The repaired dossier no longer flags the field.
    expect(validateDossierCoherence(repaired).repairFields).not.toContain("appearance");
  });

  it("ALREADY-neutral nonbinary prose is untouched (no false repair)", () => {
    const d: DossierForCoherence = {
      genderPresentation: "nonbinary",
      appearance: "their left eyebrow is scarred",
      demeanor: "they keep the room at arm's length",
      distinguishingMark: "a scar on their forearm",
      age: 26,
    };
    const res = validateDossierCoherence(d);
    expect(res.ok).toBe(true);
    expect(res.repairFields).toHaveLength(0);
    expect(res.contradictions).toHaveLength(0);
    // Repair is a byte-neutral no-op.
    const { repaired, repairedFields } = repairDossierCoherence(d);
    expect(repairedFields).toHaveLength(0);
    expect(repaired.appearance).toBe("their left eyebrow is scarred");
  });
});

describe("validateDossierCoherence — N generated coherent casts pass clean", () => {
  it("zero cross-field contradictions across a swept, gender-mixed cast", () => {
    const genders: Array<"man" | "woman" | "nonbinary"> = ["man", "woman", "nonbinary"];
    for (let i = 0; i < 45; i++) {
      const d = coherentDossier(genders[i % 3]!, i);
      const res = validateDossierCoherence(d);
      expect(res.ok, `dossier ${i} (${genders[i % 3]}) should be coherent: ${JSON.stringify(res.contradictions)}`).toBe(true);
      expect(res.contradictions.filter((c) => c.severity === "hard")).toHaveLength(0);
    }
  });
});

describe("RC5 — the validator is REACHED IN PRODUCTION at game start (not just the pure fn)", () => {
  // The whole point of the wiring lane: `validateDossierCoherence`/`repairDossierCoherence` are no longer
  // DEAD CODE — `GameSessionAdapter.createCharacter` runs them over the fully-assembled cast at every game
  // start, BEFORE the season-start persist. This drives the ACTUAL commit path (preSeedCast → recordCastGenesis
  // fold → createCharacter adopt), injecting the Lily-Evans-shaped contradiction through the real write-back,
  // and asserts the COMMITTED live cast is coherent (repaired) with the pinned gender spine preserved.
  const freshDir = (): string => mkdtempSync(join(tmpdir(), "orwell-rc5-"));
  const liveRuntime = (): ReturnType<typeof composeRuntime> =>
    composeRuntime({ saveStore: new FileSaveStore(freshDir()), clock: new FakeClock() });

  it("game start REPAIRS a 'man' dossier whose demeanor says 'her', keeps the consistent appearance, and preserves the pin", () => {
    const runtime = liveRuntime();
    const sb = runtime.registry.sandboxFor("u");
    const SEED = 424242;

    // 1) Warm the floor cast (seeds each NPC's genderPresentation), then pick a binary-gendered NPC so the
    //    "opposite pronoun" contradiction is unambiguous (a nonbinary pin isn't contradicted by a lone pronoun).
    const warm = sb.session.preSeedCast({ seed: SEED });
    const target = warm.house.find((c) => c.genderPresentation === "man" || c.genderPresentation === "woman");
    expect(target, "the warmed cast should carry a binary-gendered houseguest").toBeTruthy();
    const pin = target!.genderPresentation as "man" | "woman";
    const oppPoss = pin === "man" ? "her" : "his"; // the CONTRADICTING self-reference
    const samePoss = pin === "man" ? "his" : "her"; // a CONSISTENT self-reference (must be kept)

    // 2) Fold the Lily-Evans-shaped prose through the REAL genesis write-back: a demeanor that self-references
    //    the OPPOSITE gender ("her shyness" against a 'man' pin) beside a same-gender appearance ("his forearm").
    const contradictingDemeanor = `quiet — ${oppPoss} shyness reads as aloofness`;
    const consistentAppearance = `slight build; a tattoo runs down ${samePoss} left forearm`;
    const gen = sb.session.recordCastGenesis({
      npcs: [{ id: target!.id, demeanor: contradictingDemeanor, appearance: consistentAppearance }],
    });
    expect(gen.accepted).toBe(true);
    expect(gen.committed).toBeGreaterThanOrEqual(1);

    // 3) Finalize — adopts the warmed cast (same seed) and runs the coherence gate at game start.
    const view = sb.session.createCharacter({
      playerName: "Player One", seed: SEED,
      backstory: "grew up on the coast", motivation: "to prove myself", personaArchetype: "underdog",
    });

    // The COMMITTED live cast is coherent: the contradicting demeanor was cleared (repaired), the pin stands,
    // and the consistent appearance is kept.
    const live = sb.session.snapshot().house!.npcs.find((n) => n.id === target!.id)!;
    expect(live.character.genderPresentation).toBe(pin);            // spine preserved
    expect(live.character.demeanor ?? "").not.toMatch(new RegExp(`\\b${oppPoss}\\b`, "i")); // contradiction gone
    expect(live.character.appearance).toContain(samePoss);          // consistent self-ref kept

    // And it validates clean now — the validator is genuinely REACHED (repaired in production), not dead code.
    expect(validateDossierCoherence({
      genderPresentation: live.character.genderPresentation,
      demeanor: live.character.demeanor,
      appearance: live.character.appearance,
      biography: live.character.biography,
      age: live.character.age,
    }).ok).toBe(true);

    // #1599 — the auto-correction is SURFACED (Vault-free) on the create result, never silently swallowed.
    expect(view.castCoherence).toBeTruthy();
    expect(view.castCoherence!.repaired).toBeGreaterThanOrEqual(1);
    const hit = view.castCoherence!.houseguests.find((h) => h.id === target!.id);
    expect(hit, "the corrected houseguest is named in the coherence summary").toBeTruthy();
    expect(hit!.action).toBe("repaired");
    expect(hit!.fields).toContain("demeanor");
  });

  it("a clean floor cast start reports NO coherence correction (byte-neutral no-op)", () => {
    const runtime = liveRuntime();
    const sb = runtime.registry.sandboxFor("u");
    // A plain floor start (no model-authored genesis) — the deterministic cast is always coherent.
    const view = sb.session.createCharacter({
      playerName: "Player Two", seed: 77,
      backstory: "small-town start", motivation: "the money", personaArchetype: "strategist",
    });
    expect(view.castCoherence).toBeUndefined();
  });
});

describe("portrait pins gender to the facet, never to contradictory prose (S4a)", () => {
  it("renders the pinned gender phrase even when appearance/identity prose leans the other way", () => {
    // A dossier whose PROSE mentions the opposite gender must not flip the portrait — the portrait reads
    // ONLY the pinned `genderPresentation` pair, so words and picture cannot diverge.
    const result = buildPortraitPrompt(
      "npc:7",
      "The Nominee",
      {
        appearance: "slight build; her expression is watchful",
        age: 28,
        presentation: "casual and understated",
        genderPresentation: "man",
        identityConcept: "a quiet strategist who lets her rivals underestimate her",
        vocation: "court reporter",
      },
      "editorial studio portrait, soft key light",
    );
    // The SUBJECT line carries the pinned 'man' phrase, not the prose's 'her'.
    expect(result.prompt).toContain("28-year-old man");
    expect(result.prompt).not.toContain("woman");
  });
});
