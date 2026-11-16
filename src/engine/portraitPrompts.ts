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
import { dealPortraitPlans, faceSentence, type PortraitPlan, type ShotSheet } from "./shotCards";

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
  /** ORW-480: the casting type (label and read) and the voice's energy line: the PUBLIC sheet reads the shot card's moment comes from. */
  castingType?: { label?: string; read?: string };
  voiceEnergy?: string;
}

/**
 * ORW-380: the three look fields the writer authors (ORW-360 wardrobe/onCamera, ORW-380 photoHair). Read
 * through this local type (defensively) so a facet without them still builds.
 */
type PortraitLook = PhysicalCharacteristics & { wardrobe?: readonly string[]; onCamera?: string; photoHair?: string };

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

/** A generated portrait prompt ready to hand to an image provider. */
export interface PortraitPromptResult {
  houseguestId: string;
  name: string;
  prompt: string;
}

type Gender = "man" | "woman" | "nonbinary";

const SIGNATURE_MARK_RE = /\b(?:tattoo\w*|piercing\w*|nose ring|nose stud|stud|studs|hoop|hoops|earrings?|glasses|freckles?|dimples?|beauty mark|gap)\b/i;
const NOT_SENT_MARK_RE = /\b(?:scars?|scarred|birthmarks?|burns?|burned|chipped)\b/i;
const AGE_LOOK_BLOCK_RE = /\b(?:weathered|worn|tired|haggard|lived-in|rough|rugged|craggy|sun-creased|older than)\b/i;
const WORN_WORD_RE = /\b(?:weathered|worn|tired|haggard|lived-in|rough|rugged|craggy)\b/gi;
const HAIR_WORD_RE = /\b(?:hair(?:cut|style|do)?|curls?|curly|waves?|wavy|braids?|braided|bun|ponytail|fade|crop|cropped|locs|afro|bob|buzz\w*|bald|mohawk|pixie|lob|bangs?|fringe)\b/i;
const HAIR_CUT_MARKERS = [", usually", " usually", " that ", " by ", " until "] as const;

const PRONOUNS: Record<Gender | "none", { subj: string; obj: string; plural: boolean }> = {
  man: { subj: "He", obj: "him", plural: false },
  woman: { subj: "She", obj: "her", plural: false },
  nonbinary: { subj: "They", obj: "them", plural: true },
  none: { subj: "They", obj: "them", plural: true },
};


const sentence = (t: string): string => {
  const x = t.trim().replace(/[\s.]+$/, "");
  return x === "" ? "" : `${x}.`;
};
const upperFirst = (t: string): string => (t === "" ? t : t[0]!.toUpperCase() + t.slice(1));

/** The written hair cut at the first "usually / that / by / until" clause, ready to take ", neatly styled". */
export function trimWrittenHair(hair: string): string {
  let cut = hair.length;
  for (const m of HAIR_CUT_MARKERS) {
    const i = hair.indexOf(m);
    if (i >= 0 && i < cut) cut = i;
  }
  return hair.slice(0, cut).replace(/[\s,;.]+$/, "").trim();
}

/** Strip the aging / rough words from a written facet part (the ageLook is dropped whole instead). */
export function stripWornWords(t: string): string {
  const had = WORN_WORD_RE.test(t);
  WORN_WORD_RE.lastIndex = 0;
  // a list of worn words ("rough or worn") goes whole, joiner included
  t = t.replace(/\b(?:weathered|worn|tired|haggard|lived-in|rough|rugged|craggy)\b(?:\s*,\s*|\s+(?:and|or)\s+)(?=(?:weathered|worn|tired|haggard|lived-in|rough|rugged|craggy)\b)/gi, "");
  let out = t.replace(WORN_WORD_RE, "").replace(/\s{2,}/g, " ").replace(/\s+([,;.])/g, "$1").replace(/(?:,\s*){2,}/g, ", ")
    .replace(/^[\s,;]+|[\s,;]+$/g, "").trim();
  if (had) {
    // ORW-437: removing "rugged" from "rugged and tall" must not leave "and tall"; drop the orphaned joiner at either end.
    out = out.replace(/^(?:and|or)\s+/i, "").replace(/[\s,]+(?:and|or)$/i, "").replace(/\b(and|or)\s+(?:and|or)\b/gi, "$1")
      .replace(/\s+(?:and|or)\s*(?=[,;])/gi, "").replace(/,\s+(and|or)\b/gi, " $1").replace(/^[\s,;]+|[\s,;]+$/g, "").trim();
  }
  return out;
}

/** The prose `appearance` of a legacy character: cut like hair (no "usually ..." clauses), scar / birthmark / burn parts and worn words removed. */
export function legacyAppearance(appearance: string): string {
  // ORW-437: only a HAIR fragment is cut at "usually / that / by / until"; other clauses keep their full words.
  const parts = appearance.split(/,|;/).map((x) => (HAIR_WORD_RE.test(x) ? trimWrittenHair(x.trim()) : x.trim()))
    .filter((x) => x !== "" && !NOT_SENT_MARK_RE.test(x));
  return stripWornWords(parts.join(", "));
}

/** Keep only the signature parts of a (possibly compound) distinguishing mark; scars, birthmarks, burns and chipped teeth are not sent. */
export function signatureMarkClause(mark: string | undefined): string {
  if (!isRealMark(mark)) return "";
  // ORW-437: also split a compound joined by ", and a ..." / " and a ...", so a signature part survives next to an excluded one.
  const parts = mark.split(/;|,\s*plus\b|,?\s+and\s+(?=(?:an?|the)\s)/i).map((p) => p.replace(/^[\s,]*(?:and\s+)?/i, "").trim()).filter((p) => p !== "");
  // "a tattoo and chipped teeth": an unarticled "and" inside a part that carries an excluded detail splits it too
  const split = parts.flatMap((p) => (NOT_SENT_MARK_RE.test(p) ? p.split(/\s+and\s+/i).map((x) => x.trim()).filter((x) => x !== "") : [p]));
  const kept = split.filter((p) => SIGNATURE_MARK_RE.test(p) && !NOT_SENT_MARK_RE.test(p));
  return kept.length === 0 ? "" : sentence(upperFirst(kept.join(", ")));
}

const SHOT_OPENER = "An official cast photo for a reality show, made by the production's unit photographer during the season: "
  + "the person knows they are being photographed and is presented well, and it is a real photograph, not a stock headshot or a snapshot";
/**
 * The shared closing asks (ORW-480). They replace the old studio recipe (shallow depth of field, "softly out of focus behind"):
 * a production's cast photo: the person reads as their stated age, groomed and at their best, natural (not plastic) skin, a readable
 * place; the hard protections stay (the only person in frame, no text or logos).
 */
const REAL_PHOTO_TAIL =
  "Keep the stated age and build exactly: the person reads as that age and looks their best on the day, groomed, with hair and makeup done for the shoot, "
  + "flattering but real. Natural skin texture, not plastic and not airbrushed. The face stays large, sharp and clear, also in a square crop. "
  + "The place behind stays readable but is never the subject. Natural hands "
  + "with five fingers, ordinary real garments with proper seams and fit, nothing held beyond what is stated. "
  + "The only person in the frame; no text or logos.";

/**
 * Build the photo-brief v4 prompt (ORW-480): ONE paragraph from the public facets and the SHOT CARD and FACE CARD dealt
 * across the cast (`dealPortraitPlans`). The place, time of day, framing, angle, light, the moment (what the person is
 * doing, derived from their casting read, demeanor, voice energy), the gaze and any held prop come from the shot card;
 * the face structure from the face card. No name, no job, no season anchor (still stored by the adapter, ignored here).
 * `plan` is the cast's deal for this person; without it the person is dealt alone (the same output for the same person
 * only when they are the whole cast), so a caller with the roster should always pass the cast's plan.
 *
 * The name is accepted for the stable call signature and for the result record; it is not sent.
 */
export function buildPortraitPrompt(
  houseguestId: string,
  name: string,
  facets: PublicAppearanceFacets,
  _styleAnchor: string,
  plan?: PortraitPlan,
): PortraitPromptResult {
  const { appearance, age, physicalCharacteristics, ethnicity, genderPresentation, presentation } = facets;
  const look = physicalCharacteristics as PortraitLook | undefined;
  const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const pr = PRONOUNS[genderPresentation ?? "none"];
  const sheet = sheetOf(houseguestId, name, facets);
  const card = plan ?? dealPortraitPlans([sheet]).get(houseguestId)!;
  const { shot, face } = card;

  // 2. Who: age, heritage, gender, then the build and skin; the face comes from the face card.
  const noun = genderPresentation === "man" ? "man" : genderPresentation === "woman" ? "woman"
    : genderPresentation === "nonbinary" ? "nonbinary person with a soft androgynous look" : "person";
  const article = age === 8 || age === 11 || age === 18 || (age >= 80 && age <= 89) ? "an" : "a";
  const who = `The subject is ${article} ${age}-year-old ${ethnicity ? `${ethnicity} ` : ""}${noun}`;
  let withClause: string;
  let faceLine = "";
  if (look) {
    const ageLook = clean(look.ageLook);
    const bits = [look.skinTone, look.heightBuild].map((x) => stripWornWords(clean(x))).filter((x) => x !== "");
    if (ageLook !== "" && !AGE_LOOK_BLOCK_RE.test(ageLook)) bits.push(ageLook);
    withClause = bits.length > 0 ? ` with ${bits.join(", ")}` : "";
    faceLine = faceSentence(face);
  } else {
    const prose = legacyAppearance(appearance);
    withClause = prose !== "" ? ` with ${prose}` : "";
    faceLine = faceSentence(face);
  }

  // 3. Hair: the shoot-day line, or the written cut trimmed and neatened.
  const photoHair = stripWornWords(clean(look?.photoHair));
  const writtenHair = look ? stripWornWords(trimWrittenHair(clean(look.hair))) : "";
  const hairLine = photoHair !== "" ? sentence(writtenHair !== "" && !photoHair.toLowerCase().includes(writtenHair.toLowerCase())
      ? `Hair: ${photoHair} (the cut as written: ${writtenHair}; keep exactly that length and volume, no longer or bigger)` : `Hair: ${photoHair}`)
    : writtenHair !== "" ? sentence(`Hair: ${writtenHair}, neatly styled`) : "";

  // 4. Signature features only.
  const markLine = signatureMarkClause(look?.distinguishingMark);

  // 5. Clothes.
  const wardrobe = Array.isArray(look?.wardrobe)
    ? look!.wardrobe!.filter((w): w is string => typeof w === "string").map((w) => stripWornWords(w.trim())).filter((w) => w !== "")
    : [];
  const styleText = stripWornWords(clean(look?.style) !== "" ? clean(look?.style) : presentation.trim());
  const clothesLine = wardrobe.length > 0 ? sentence(`Wearing ${wardrobe.join(", ")}`)
    : sentence(`Wearing clothes in this style: ${styleText}`);

  // 6. The shot: place and light, then the moment and any prop.
  const settingLine = `${sentence(`Setting: ${shot.place}`)} ${sentence(`Light: ${shot.light}`)}`;
  const momentLine = sentence(`The moment: ${shot.moment}`);
  const propLine = shot.prop !== undefined ? sentence(`${pr.subj} ${pr.plural ? "are" : "is"} ${shot.prop}`) : "";

  const prompt = [
    sentence(`${SHOT_OPENER}: ${shot.framing}, ${shot.angle}, on ${shot.lens}`),
    sentence(`${who}${withClause}`),
    faceLine, hairLine, markLine, clothesLine, settingLine, momentLine, propLine, REAL_PHOTO_TAIL,
  ].filter((x) => x !== "").join(" ");

  return { houseguestId, name, prompt };
}

/** The sheet the shot and face deals read: public facets only. */
function sheetOf(id: string, name: string, f: PublicAppearanceFacets): ShotSheet {
  const look = f.physicalCharacteristics;
  return {
    id, name, age: f.age,
    ...(f.genderPresentation !== undefined ? { genderPresentation: f.genderPresentation } : {}),
    ...(f.demeanor !== undefined ? { demeanor: f.demeanor } : {}),
    ...(f.castingType?.read !== undefined ? { castingRead: f.castingType.read } : {}),
    ...(f.castingType?.label !== undefined ? { castingLabel: f.castingType.label } : {}),
    ...(f.voiceEnergy !== undefined ? { energy: f.voiceEnergy } : {}),
    ...(f.vocation !== undefined ? { vocation: f.vocation } : {}),
    ...(f.identityConcept !== undefined ? { identityConcept: f.identityConcept } : {}),
    ...(look?.facialFeatures !== undefined ? { facialFeatures: look.facialFeatures } : {}),
    ...(look?.heightBuild !== undefined ? { heightBuild: look.heightBuild } : {}),
    ...(look !== undefined ? { clothes: [...(Array.isArray((look as { wardrobe?: unknown }).wardrobe) ? (look as { wardrobe: string[] }).wardrobe : []), look.style ?? ""].join(" ; ") } : {}),
  };
}

type CastEntry = Parameters<typeof buildCastPortraitPrompts>[0][number];
/** The deal sheet of one cast entry (ORW-480). Exported so a report can deal exactly what the prompts were built from. */
export function castSheetOf(hg: CastEntry): ShotSheet {
  return sheetOf(hg.id, hg.name, {
    appearance: hg.appearance ?? "", age: hg.age ?? 0, presentation: hg.presentation ?? "",
    ...(hg.physicalCharacteristics !== undefined ? { physicalCharacteristics: hg.physicalCharacteristics } : {}),
    ...(hg.genderPresentation !== undefined ? { genderPresentation: hg.genderPresentation } : {}),
    ...(hg.demeanor !== undefined ? { demeanor: hg.demeanor } : {}),
    ...(hg.identityConcept !== undefined ? { identityConcept: hg.identityConcept } : {}),
    ...(hg.vocation !== undefined ? { vocation: hg.vocation } : {}),
    ...(hg.castingType !== undefined ? { castingType: hg.castingType } : {}),
    ...(hg.voiceEnergy !== undefined ? { voiceEnergy: hg.voiceEnergy } : {}),
  });
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
    castingType?: { label?: string; read?: string };
    voiceEnergy?: string;
  }>,
  styleAnchor: string,
): PortraitPromptResult[] {
  const complete = houseguests.filter((hg) => hg.appearance && hg.age !== undefined && hg.presentation);
  // ORW-480: the shot and face cards are dealt ACROSS the whole cast (caps per value), then each prompt is built from its own.
  const plans = dealPortraitPlans(complete.map((hg) => castSheetOf(hg)));
  return complete
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
          ...(hg.castingType !== undefined ? { castingType: hg.castingType } : {}),
          ...(hg.voiceEnergy !== undefined ? { voiceEnergy: hg.voiceEnergy } : {}),
        },
        styleAnchor,
        plans.get(hg.id),
      ),
    );
}
