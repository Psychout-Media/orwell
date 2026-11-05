/**
 * Vault-free portrait prompt builder (0051).
 *
 * Takes ONLY a houseguest's PUBLIC appearance facets (the same fields the visible
 * projection already exports on `HouseguestCard`: appearance, age, presentation)
 * and the per-season style anchor. NO hidden stats, NO soul content, NO relationship
 * values, NO engine-only store imports — structurally enforced by dependency-cruiser.
 *
 * The E11/E15 discipline applies: a sentinel sweep over assembled prompts must find
 * no hidden-layer content. This module is the gate; the tests are the proof.
 */

import type { PhysicalCharacteristics } from "../domain/physicalCharacteristics";
import { genderPresentationPhrase } from "../domain/gender";
import { fnv1a } from "../domain/num";

export { genderPresentationPhrase };

/** The public appearance facets available on the Vault-free HouseguestCard (B61). */
export interface PublicAppearanceFacets {
  /** e.g. "athletic, close-cropped hair, a warm smile" */
  appearance: string;
  /** e.g. 27 */
  age: number;
  /** e.g. "casual and laid-back" */
  presentation: string;
  /**
   * L29/L23/0058: the STRUCTURED physical facet — the SINGLE source of truth shared by the portrait
   * prompt AND the text narration, so the face always matches the person (height/build, skin tone,
   * hair, facial features, distinguishing mark, age-look, style). When present it AUTHORS the physical
   * description (richer + more differentiating than the prose `appearance`); when absent we fall back
   * to the prose line. All facets are PUBLIC (already on the card) — no hidden content ever rides here.
   */
  physicalCharacteristics?: PhysicalCharacteristics;
  /**
   * Feature 0063 — the PUBLIC diversity + personality facets that make each shot uniquely THIS person.
   * ALL are PUBLIC (already on the HouseguestCard): the heritage / cultural identity (`ethnicity` —
   * grounds an authentic, accurate likeness so the face matches who the character is), how they present
   * (`genderPresentation`), and their observable DEMEANOR (`demeanor` — expression / vibe / energy, the
   * L28 register). A PRIVATELY-held orientation is NOT in this type and MUST NEVER enter a prompt — only
   * public facets feed the shot (the §5 Vault rule). Identity informs a dignified, authentic likeness —
   * never a caricature: the appearance is built from the grounded physical facet + heritage + demeanor,
   * not from clichés.
   */
  ethnicity?: string;
  genderPresentation?: "man" | "woman" | "nonbinary";
  demeanor?: string;
  /**
   * The AUTHORED storyline facets (owner report 2026-07-13: "portraits don't match people's
   * storylines or aesthetics") — both PUBLIC HouseguestCard fields, so Vault-free by construction:
   * - `identityConcept` (feature 0116): the model-authored FREEFORM identity in the model's own
   *   words ("a chaos-agent podcaster who treats the house like a live show"). It is the single
   *   strongest storyline/aesthetic signal the engine holds, so the shot's wardrobe/grooming/
   *   attitude read as THAT person, not a generic contestant. C8-capped at genesis commit; absent
   *   on a deterministic floor cast (where the archetype is the identity, and the prompt stays
   *   byte-identical to before).
   * - `vocation` (L28/0058): the public occupation noun phrase ("ER nurse") — a concrete grounding
   *   cue for dress/grooming an image model reads well.
   * NEVER a hidden element, stat, or soul field — the §5 Vault rule holds unchanged.
   */
  identityConcept?: string;
  vocation?: string;
}

import {
  EXPRESSION_VARIANTS, FRAMING_VARIANTS, BACKDROP_VARIANTS,
  FACIAL_STRUCTURE_VARIANTS, LIGHTING_VARIANTS,
} from "./imageConstants";

/**
 * Compose the structured physical facet into a single rich appearance clause (L29). Skips a
 * "none notable" distinguishing mark so it never reads as a literal instruction to the image model.
 * Pure string assembly over PUBLIC fields — no hidden content.
 */
export function physicalFacetToAppearance(p: PhysicalCharacteristics): string {
  const parts = [p.heightBuild, p.skinTone, p.hair, p.facialFeatures];
  if (p.distinguishingMark && !/^none\b/i.test(p.distinguishingMark.trim())) parts.push(p.distinguishingMark);
  parts.push(p.ageLook);
  return parts.join(", ");
}

// ── #1317 (cast portraits converge, root cause 3) — gender-aware BUILD/HAIR phrasing at
// PROMPT-ASSEMBLY time only ──────────────────────────────────────────────────────────────────────
// The STORED `physicalCharacteristics` facet (heightBuild/hair) is deliberately gender-NEUTRAL — it
// never encodes `genderPresentation`, so the same pool serves every gender and the stored facet stays
// byte-stable (0007/0031; never mutated here). Before this fix the ONLY gender cue an image model saw
// was the repeated directive `genderPresentationPhrase` in the Subject line — the build/hair VOCABULARY
// itself never shifted, so a man and a woman dealt the same stored build/hair phrase rendered near-
// identically apart from the name/phrase cue. These pools map facet → a short, hash-seeded gendered
// CLAUSE appended at prompt-assembly time (never replacing the stored phrase, never touching storage),
// so the same stored facet now visibly reads differently across presentations.
const BUILD_GENDER_CUES: Record<"man" | "woman" | "nonbinary", readonly string[]> = {
  man: ["reads distinctly masculine", "carries a masculine presence", "a build that reads masculine"],
  woman: ["reads distinctly feminine", "carries a feminine presence", "a build that reads feminine"],
  nonbinary: ["reads androgynous", "carries a gender-neutral presence", "a build that resists easy gendering"],
};
const HAIR_GENDER_CUES: Record<"man" | "woman" | "nonbinary", readonly string[]> = {
  man: ["styled with masculine grooming", "cut with a masculine edge", "groomed in a masculine style"],
  woman: ["styled with feminine flair", "finished with feminine styling", "worn with a feminine touch"],
  nonbinary: ["styled in a gender-neutral way", "cut with an androgynous edge", "styled without a strong gender cue"],
};

function genderCue(
  pool: Record<"man" | "woman" | "nonbinary", readonly string[]>,
  gender: "man" | "woman" | "nonbinary",
  seed: number,
): string {
  const cues = pool[gender];
  return cues[((seed % cues.length) + cues.length) % cues.length]!;
}

/**
 * Compose a SEPARATE gendered build/hair clause for the prompt — deliberately NOT folded into the
 * `Physical appearance:` line itself. `Physical appearance:` is `physicalFacetToAppearance(p)` verbatim,
 * a load-bearing invariant (L29, `momentOrchestration.test.ts`): the narrator context and the portrait
 * prompt must share the EXACT SAME appearance clause byte-for-byte, so words and picture can never
 * diverge. Splicing a gender cue into heightBuild/hair before that call would break the shared-string
 * containment check, so instead the cue rides as its own trailing clause — additive, portrait-only,
 * and it never touches `p` (no mutation; the stored facet stays gender-neutral and byte-stable).
 */
function genderedBuildHairClause(
  p: PhysicalCharacteristics,
  gender: "man" | "woman" | "nonbinary" | undefined,
  shot: number,
): string | undefined {
  if (!gender) return undefined;
  const buildCue = genderCue(BUILD_GENDER_CUES, gender, shot);
  const hairCue = genderCue(HAIR_GENDER_CUES, gender, shot >>> 20);
  return `the build ${buildCue}, the hair ${hairCue}`;
}

/** A generated portrait prompt ready to hand to an image provider. */
export interface PortraitPromptResult {
  houseguestId: string;
  name: string;
  prompt: string;
}

// The per-subject shot key (G24) is `fnv1a` from src/domain/num.ts (FNV-1a 32-bit): the same (houseguestId, season anchor) pair always yields the same hash, so a houseguest re-renders as the same
// shot across restarts and backfills, while different houseguests land on different picks.

/**
 * Build a photorealistic portrait prompt for one houseguest using ONLY their
 * public appearance facets and the season-level style anchor. The output is
 * safe to send to any image provider — it carries no hidden game state.
 *
 * G24: expression, framing, and backdrop vary PER SUBJECT (hash-seeded off the
 * houseguest id + the season anchor) instead of every portrait sharing one
 * identical pose/crop — the cast stops looking like a grid of siblings while
 * the season anchor keeps the set cohesive.
 *
 * The name is included in the prompt purely for identification of the subject
 * in the output; it is a public fact (the player knows every houseguest's name).
 */
export function buildPortraitPrompt(
  houseguestId: string,
  name: string,
  facets: PublicAppearanceFacets,
  styleAnchor: string,
): PortraitPromptResult {
  const { appearance, age, presentation, physicalCharacteristics, ethnicity, genderPresentation, demeanor,
    identityConcept, vocation } = facets;
  const shot = fnv1a(`${houseguestId}|${styleAnchor}`);
  const expression = EXPRESSION_VARIANTS[shot % EXPRESSION_VARIANTS.length]!;
  const framing = FRAMING_VARIANTS[(shot >>> 8) % FRAMING_VARIANTS.length]!;
  const backdrop = BACKDROP_VARIANTS[(shot >>> 16) % BACKDROP_VARIANTS.length]!;
  const facialStructure = FACIAL_STRUCTURE_VARIANTS[(shot >>> 24) % FACIAL_STRUCTURE_VARIANTS.length]!;
  // #1317: a SECOND hash-seeded pick — same fnv1a discipline, salted off the first hash rather than a
  // shared/external stream — so lighting draws from fresh bits instead of reusing the (already fully
  // spoken-for) low 32 bits of `shot`. Still pure + deterministic per (houseguestId, styleAnchor); no
  // rng is consumed from any shared stream.
  const shot2 = fnv1a(`${shot}|v2`);
  const lighting = LIGHTING_VARIANTS[shot2 % LIGHTING_VARIANTS.length]!;
  // L29: prefer the STRUCTURED facet (distinct faces, one source of truth with the narration); fall
  // back to the prose `appearance` for pre-0058 saves that never seeded a facet. This EXACT string
  // (`physicalFacetToAppearance(physicalCharacteristics)`) is the one the narrator context ALSO voices
  // verbatim (`momentOrchestration.test.ts` L29) — never altered here.
  const physical = physicalCharacteristics ? physicalFacetToAppearance(physicalCharacteristics) : appearance;
  // #1317 Fix C (closes the #1140 deferral): a SEPARATE gendered build/hair clause, hash-seeded per
  // subject — the stored facet itself stays gender-neutral and untouched (byte-stable, 0007/0031); this
  // additive clause is the only place the extra cue rides (see `genderedBuildHairClause` above).
  const genderedStyling = physicalCharacteristics
    ? genderedBuildHairClause(physicalCharacteristics, genderPresentation, shot)
    : undefined;
  // #1317 (root cause 4) — the strongest per-subject differentiator, restated near the END of the
  // prompt (the composition re-weight below leads with it too): most image models over-weight both
  // the first AND the last tokens, so repeating the one clause that most distinguishes this face from
  // the rest of the cast at the close counters the shared style anchor's dominance in the middle.
  const distinguishingMark = physicalCharacteristics?.distinguishingMark;
  const hasMark = distinguishingMark && !/^none\b/i.test(distinguishingMark.trim());
  const distinctiveClose = physicalCharacteristics
    ? `${facialStructure}${hasMark ? `, ${distinguishingMark}` : ""}`
    : physical;
  const styleLine = physicalCharacteristics?.style
    ? `${presentation}, ${physicalCharacteristics.style}`
    : presentation;
  // 0063 + #1140 Fix B: build a SUBJECT line that reflects the unique person — how they present + their
  // heritage (an authentic, accurate likeness, never a caricature) + age. The skin tone in `physical` is
  // already grounded in this same heritage, so the description is internally consistent and dignified.
  //
  // De-bias the NAME: lead with the GENDER phrase (the directive cue), not the bare proper noun. A NAME can
  // read gendered to an image model (a unisex/flipped/AI-overridden name like "Marlon" on a woman), and if
  // it's the FIRST/strongest token the model renders the NAME's gender, contradicting the stored facet. So
  // the gender phrase comes FIRST, the name trails as a plain identification tag, and the directive phrase
  // is REPEATED right after the name so the cue still flanks it. The engine carries `genderPresentation` for
  // the whole cast, so the lead phrase is effectively always present (the `if` only guards a legacy absence).
  const genderPhrase = genderPresentation ? genderPresentationPhrase(genderPresentation) : undefined;
  const subjectParts: string[] = [];
  if (genderPhrase) subjectParts.push(genderPhrase);
  subjectParts.push(`${age} years old`);
  if (ethnicity) subjectParts.push(`of ${ethnicity} heritage`);
  // The name LAST, as a plain identifier. Bundle-audit fix (2026-07-13, owner-ruled): the #1140 form
  // re-stated the gender cue in a parenthetical after the name ("named X (a woman (feminine
  // presentation))"), but the gender phrase ALWAYS leads the subject clause above (pushed first the
  // moment `genderPresentation` is set — which the engine carries for the whole cast), so the
  // parenthetical was a pure in-line duplicate. It rides plain: the lead phrase already flanks the
  // name from the front, and the #1317 `Build & hair styling:` clause carries per-facet gender cues
  // further down the prompt. (A legacy no-gender card emits this same plain form — byte-identical to
  // before the #1140 parenthetical, and to the dedup guard this replaced, which was unreachable
  // because the lead phrase is unconditionally present whenever it is defined.)
  subjectParts.push(`named ${name}`);
  // 0063: the observable DEMEANOR colors the EXPRESSION line — the face matches the personality (a blunt
  // person reads guarded, a warm one reads open) instead of every portrait sharing one default affect.
  const expressionLine = demeanor ? `${expression}, ${demeanor}` : expression;
  // #1317 (root cause 1 — composition re-weight): the ~24-word shared style anchor used to lead the
  // prompt, dominating the token budget before any subject-specific content appeared. Distinguishing
  // clauses (identity, then the physical facet, then presentation) now come FIRST; the shared anchor is
  // KEPT (never trimmed — every anchor still appears in full, `buildPortraitPrompt`'s Vault-free-anchor
  // callers still find it verbatim) but MOVED past them, and the strongest per-subject differentiator is
  // restated once more at the very end (`distinctiveClose`) so it lands on both the primacy AND recency
  // positions a subject-agnostic anchor used to monopolize alone.
  const prompt = [
    `Subject: ${subjectParts.join(", ")}`,
    `Physical appearance: ${physical}`,
    // #1317 Fix C — additive only: present iff a gender + a structured facet are both available;
    // absent entirely (byte-identical to pre-#1317) otherwise.
    ...(genderedStyling ? [`Build & hair styling: ${genderedStyling}`] : []),
    `Presentation style: ${styleLine}`,
    // The AUTHORED storyline facets (2026-07-13) — the strongest per-subject aesthetic signals, so
    // they ride BEFORE the shared season anchor (the #1317 composition re-weight: subject-specific
    // content leads, the anchor follows). Additive only: a floor cast without them is byte-identical.
    ...(identityConcept ? [`Character: ${identityConcept} — reflect this in wardrobe, grooming, and attitude`] : []),
    ...(vocation ? [`Occupation: ${vocation}`] : []),
    styleAnchor,
    `Facial structure: ${facialStructure}`,
    `Expression: ${expressionLine}`,
    `Lighting: ${lighting}`,
    `Framing: ${framing}`,
    `Setting: ${backdrop}`,
    `Distinctive look: ${distinctiveClose}`,
  ].join(". ");

  return { houseguestId, name, prompt };
}

/**
 * Build portrait prompts for a full cast from the public visible projection.
 * Called by `GameSessionAdapter.createCharacter` after the house is generated.
 *
 * `houseguests` is the Vault-free `house` array from `GameStateView` — only
 * public fields; hidden elements, stats, and soul never reach this function.
 */
export function buildCastPortraitPrompts(
  houseguests: ReadonlyArray<{
    id: string;
    name: string;
    appearance?: string;
    age?: number;
    presentation?: string;
    physicalCharacteristics?: PhysicalCharacteristics;
    ethnicity?: string;
    genderPresentation?: "man" | "woman" | "nonbinary";
    demeanor?: string;
    identityConcept?: string;
    vocation?: string;
  }>,
  styleAnchor: string,
): PortraitPromptResult[] {
  return houseguests
    .filter((hg) => hg.appearance && hg.age !== undefined && hg.presentation)
    .map((hg) =>
      buildPortraitPrompt(
        hg.id,
        hg.name,
        {
          appearance: hg.appearance!,
          age: hg.age!,
          presentation: hg.presentation!,
          ...(hg.physicalCharacteristics !== undefined ? { physicalCharacteristics: hg.physicalCharacteristics } : {}),
          ...(hg.ethnicity !== undefined ? { ethnicity: hg.ethnicity } : {}),
          ...(hg.genderPresentation !== undefined ? { genderPresentation: hg.genderPresentation } : {}),
          ...(hg.demeanor !== undefined ? { demeanor: hg.demeanor } : {}),
          ...(hg.identityConcept !== undefined ? { identityConcept: hg.identityConcept } : {}),
          ...(hg.vocation !== undefined ? { vocation: hg.vocation } : {}),
        },
        styleAnchor,
      ),
    );
}
