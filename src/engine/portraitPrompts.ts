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
  FACIAL_STRUCTURE_VARIANTS, LIGHTING_VARIANTS, STYLE_ANCHOR_VARIANTS, WORN_TEXTURE_VARIANTS,
} from "./imageConstants";

/**
 * ORW-361: the two wardrobe/on-camera fields ORW-360 adds to the facet. Read through this local type
 * (defensively) so this prompt works before and after that card lands; absent fields fall back.
 */
type PortraitLook = PhysicalCharacteristics & { wardrobe?: readonly string[]; onCamera?: string };

/** Ages the skin only when the written age-look says so. */
const WORN_AGE_LOOK = /\b(weathered|worn|lived-in|sun-creased|craggy|rough|tired|haggard|older than)\b/i;

const FRAME_RULES = "The only person in the frame. No text, logos, badges or screens, and no photos on the walls. At home in the Orwell house, not at work";

const isRealMark = (m: string | undefined): m is string => !!m && m.trim() !== "" && !/^none\b/i.test(m.trim());

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
  const look = physicalCharacteristics as PortraitLook | undefined;
  const wardrobe = Array.isArray(look?.wardrobe)
    ? look!.wardrobe!.filter((w): w is string => typeof w === "string").map((w) => w.trim()).filter((w) => w !== "")
    : [];
  const onCamera = typeof look?.onCamera === "string" ? look.onCamera.trim() : "";
  const writtenFace = typeof look?.facialFeatures === "string" && look.facialFeatures.trim() !== "";
  // Older saves stored the anchor with the real show name in it; never send that to a provider.
  const anchor = styleAnchor.replace(/Big Brother/g, "Orwell");
  const shot = fnv1a(`${houseguestId}|${styleAnchor}`);
  const expression = EXPRESSION_VARIANTS[shot % EXPRESSION_VARIANTS.length]!;
  const framing = FRAMING_VARIANTS[(shot >>> 8) % FRAMING_VARIANTS.length]!;
  const backdrop = BACKDROP_VARIANTS[(shot >>> 16) % BACKDROP_VARIANTS.length]!;
  const facialStructure = FACIAL_STRUCTURE_VARIANTS[(shot >>> 24) % FACIAL_STRUCTURE_VARIANTS.length]!;
  // #1317: a SECOND hash-seeded pick off the first hash, so lighting draws from fresh bits.
  const shot2 = fnv1a(`${shot}|v2`);
  const lighting = LIGHTING_VARIANTS[shot2 % LIGHTING_VARIANTS.length]!;
  // The anchor's own index picks its parallel worn-texture cue; an old stored anchor falls back to a hash pick.
  const anchorIdx = STYLE_ANCHOR_VARIANTS.indexOf(anchor as typeof STYLE_ANCHOR_VARIANTS[number]);
  const wornTexture = WORN_TEXTURE_VARIANTS[anchorIdx >= 0 ? anchorIdx : shot2 % WORN_TEXTURE_VARIANTS.length]!;
  const isWorn = !!look && WORN_AGE_LOOK.test(look.ageLook ?? "");
  const skinLine = isWorn ? wornTexture : "natural, healthy skin with real texture";
  // L29: the written facet AUTHORS the physical line. `physicalFacetToAppearance` (the narrator's
  // verbatim string) is unchanged; the portrait line is built separately: no mark, no style.
  const physical = look
    ? [look.heightBuild, look.skinTone, look.hair, look.facialFeatures, look.ageLook].join(", ")
    : appearance;
  // #1317 Fix C: a SEPARATE gendered build/hair clause (additive; the stored facet stays neutral).
  const genderedStyling = look ? genderedBuildHairClause(look, genderPresentation, shot) : undefined;
  const mark = look?.distinguishingMark;
  const hasMark = isRealMark(mark);
  // Clothing: written wardrobe, else the written style, else the legacy presentation. Never two styles.
  const clothingLine = wardrobe.length > 0
    ? `Wearing: ${wardrobe.join(", ")}`
    : `Presentation style: ${look?.style ? look.style : presentation}`;
  const genderPhrase = genderPresentation ? genderPresentationPhrase(genderPresentation) : undefined;
  // The gender phrase leads, the name trails (de-bias, #1140); the age is explicit (ORW-361).
  const subjectParts: string[] = [];
  if (genderPhrase) subjectParts.push(genderPhrase);
  subjectParts.push(`${genderPhrase ? "" : "a person "}who looks exactly ${age} years old`);
  if (ethnicity) subjectParts.push(`of ${ethnicity} heritage`);
  subjectParts.push(`named ${name}`);
  const expressionLine = demeanor ? `${expression}, ${demeanor}` : expression;
  const closeLine = look
    ? (writtenFace ? `Distinctive look: ${look.facialFeatures}`
      : `Distinctive look: ${facialStructure}${hasMark ? `, ${mark}` : ""}`)
    : `Distinctive look: ${physical}`;
  const prompt = [
    `Subject: ${subjectParts.join(", ")}`,
    `Physical appearance: ${physical}`,
    ...(genderedStyling ? [`Build & hair styling: ${genderedStyling}`] : []),
    ...(hasMark ? [`Mark (subtle: faint, small and long-healed, never a fresh wound, bruise or stain): ${mark}`] : []),
    clothingLine,
    // The authored story sentence stays unless an on-camera line replaces it.
    ...(!onCamera && identityConcept ? [`Character: ${identityConcept} — reflect this in wardrobe, grooming, and attitude`] : []),
    ...(vocation ? [`Occupation: ${vocation}`] : []),
    anchor,
    `Skin: ${skinLine}`,
    FRAME_RULES,
    ...(look && writtenFace ? [] : [`Facial structure: ${facialStructure}`]),
    ...(onCamera ? [] : [`Expression: ${expressionLine}`]),
    `Lighting: ${lighting}`,
    `Framing: ${framing}`,
    ...(onCamera ? [] : [`Setting: ${backdrop}`]),
    ...(onCamera ? [] : [closeLine]),
    ...(onCamera ? [`On camera: ${onCamera}`] : []),
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
