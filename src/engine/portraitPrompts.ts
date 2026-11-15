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

/** The spots a moment can name, in the words the Setting line uses. Order is the order the text is searched. */
const SPOTS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "kitchen", re: /\bkitchen\b/i },
  { name: "living room", re: /\bliving[- ]room\b/i },
  { name: "dining room", re: /\bdining[- ]room\b/i },
  { name: "backyard", re: /\b(?:backyard|back yard)\b/i },
  { name: "lounge", re: /\blounge\b/i },
  { name: "bedroom", re: /\bbedroom\b/i },
];
/** The fallback rooms, dealt by houseguest-id hash when the moment names none. */
const FALLBACK_ROOMS = ["kitchen", "living room", "dining room", "backyard", "lounge", "bedroom"] as const;

const LIGHT_BY_SPOT: Record<string, readonly [string, string]> = {
  backyard: ["warm golden-hour light", "soft open shade in late afternoon"],
  kitchen: ["bright soft window light from the side", "bright, airy morning light"],
  "dining room": ["bright soft window light from the side", "bright, airy morning light"],
  "living room": ["soft window light from the side with gentle fill", "warm lamps glowing in the background, soft key light on the face"],
  lounge: ["soft window light from the side with gentle fill", "warm lamps glowing in the background, soft key light on the face"],
  bedroom: ["soft window light from the side with gentle fill", "warm lamps glowing in the background, soft key light on the face"],
};

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

const BRIEF_TAIL =
  "Hair and makeup done for the shoot, well groomed and camera-ready, but a real, believable person and not a model: "
  + "keep the stated age and build exactly, with natural skin that is not airbrushed. Shot at eye level on a full-frame "
  + "camera with an 85mm portrait lens, shallow depth of field, crisp focus on the eyes, soft flattering light, "
  + "true-to-life colour. The only person in the frame; no text or logos.";

const sentence = (t: string): string => {
  const x = t.trim().replace(/[\s.]+$/, "");
  return x === "" ? "" : `${x}.`;
};
const upperFirst = (t: string): string => (t === "" ? t : t[0]!.toUpperCase() + t.slice(1));
const lowerFirst = (t: string): string => (t === "" ? t : t[0]!.toLowerCase() + t.slice(1));

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

function spotOf(onCamera: string): string | undefined {
  let best: { name: string; at: number } | undefined;
  for (const sp of SPOTS) {
    const m = sp.re.exec(onCamera);
    if (m && (best === undefined || m.index < best.at)) best = { name: sp.name, at: m.index };
  }
  return best?.name;
}

/** A word run that already carries its own grammatical subject: ", she stands", ". He grins", "; her gaze stays". */
const OWN_SUBJECT_RE = /(?:^|[,.;\u2014\u2013-])\s*(?:he|she|they|his|her|their)\s+[a-z]+/i;
const OPENS_WITH_SPOT_RE = /^(?:kitchen|living room|dining room|backyard|lounge|bedroom)\b/i;

/** The houseguest's own first name never reaches the image provider: it becomes the pronoun (or the possessive). */
function dropOwnName(t: string, ownName: string | undefined, subj: string): string {
  const first = (ownName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first === "") return t;
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const poss = subj === "He" ? "his" : subj === "She" ? "her" : "their";
  return t
    .replace(new RegExp(`\\b${esc}(?:'s|\u2019s)(?![\\p{L}])`, "gu"), poss)
    .replace(new RegExp(`(^|[.!?]\\s+)${esc}(?![\\p{L}\\p{N}_-])`, "gu"), (_m, pre: string) => `${pre}${subj}`)
    .replace(new RegExp(`\\b${esc}(?![\\p{L}\\p{N}_-])`, "gu"), subj.toLowerCase());
}

/**
 * Make the moment a sentence with a subject. A line that already carries one (it opens with a pronoun, or has a
 * ", she stands" / ". He grins" / ", her gaze stays" clause) is kept; an -ing or preposition opener gets "He is" in front;
 * a spot word ("Backyard, perched ...") gets "He is in the"; any other fragment (the writer's new openings: "Hands loose
 * at his sides ...", "Gaze straight into the lens ...", "A heavy mug in one hand ...") gets "He is photographed with".
 * The card's own first name is replaced by the pronoun first (review of #2781).
 */
function momentSentence(onCamera: string, subj: string, plural: boolean, ownName?: string): string {
  const t = dropOwnName(onCamera.trim(), ownName, subj);
  const be = plural ? "are" : "is";
  if (/^(?:he|she|they|his|her|their)\b/i.test(t)) return sentence(upperFirst(t));
  if (OWN_SUBJECT_RE.test(t)) return sentence(upperFirst(t));
  if (OPENS_WITH_SPOT_RE.test(t)) return sentence(`${subj} ${be} in the ${lowerFirst(t)}`);
  if (/^[A-Za-z-]+ing\b/.test(t) || /^(?:on|in|at|by|near|beside|against|under|over|inside|outside|behind|with)\b/i.test(t)) {
    return sentence(`${subj} ${be} ${lowerFirst(t)}`);
  }
  return sentence(`${subj} ${be} photographed with ${lowerFirst(t)}`);
}

function fallbackPose(demeanor: string | undefined, plural: boolean): string {
  const d = (demeanor ?? "").toLowerCase();
  if (/\b(?:warm|bubbly|loud|chatty)\b/.test(d)) return plural ? "lean in with a big open smile" : "leans in with a big open smile";
  if (/\b(?:guarded|cold|quiet|watchful|steady)\b/.test(d)) {
    return plural ? "sit back, composed, with a small closed-mouth smile" : "sits back, composed, with a small closed-mouth smile";
  }
  return plural ? "stand relaxed with an easy half-smile" : "stands relaxed with an easy half-smile";
}

/**
 * Build the photo-brief v3 prompt (ORW-380): ONE paragraph, in a fixed order, from the public facets only.
 * No name, no job, no season anchor (still stored by the adapter, ignored here), no random expression,
 * framing, lighting or backdrop lines. The pose and the room come from the writer's `onCamera` moment, or
 * (absent) from the demeanor and a houseguest-id hash, so the same houseguest always gets the same shot.
 *
 * The name is accepted for the stable call signature and for the result record; it is not sent.
 */
export function buildPortraitPrompt(
  houseguestId: string,
  name: string,
  facets: PublicAppearanceFacets,
  _styleAnchor: string,
): PortraitPromptResult {
  const { appearance, age, physicalCharacteristics, ethnicity, genderPresentation, demeanor, presentation } = facets;
  const look = physicalCharacteristics as PortraitLook | undefined;
  const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const pr = PRONOUNS[genderPresentation ?? "none"];
  const idHash = fnv1a(houseguestId);

  // 2. Who: age, heritage, gender, then the written face.
  const noun = genderPresentation === "man" ? "man" : genderPresentation === "woman" ? "woman"
    : genderPresentation === "nonbinary" ? "nonbinary person with a soft androgynous look" : "person";
  const article = age === 8 || age === 11 || age === 18 || (age >= 80 && age <= 89) ? "an" : "a";
  const who = `Waist-up portrait of ${article} ${age}-year-old ${ethnicity ? `${ethnicity} ` : ""}${noun}`;
  let withClause: string;
  if (look) {
    const ageLook = clean(look.ageLook);
    const bits = [look.skinTone, look.heightBuild, look.facialFeatures].map((x) => stripWornWords(clean(x))).filter((x) => x !== "");
    if (ageLook !== "" && !AGE_LOOK_BLOCK_RE.test(ageLook)) bits.push(ageLook);
    withClause = bits.length > 0 ? ` with ${bits.join(", ")}` : "";
  } else {
    const prose = legacyAppearance(appearance);
    withClause = prose !== "" ? ` with ${prose}` : "";
  }

  // 3. Hair: the shoot-day line, or the written cut trimmed and neatened.
  const photoHair = stripWornWords(clean(look?.photoHair));
  const writtenHair = look ? stripWornWords(trimWrittenHair(clean(look.hair))) : "";
  const hairLine = photoHair !== "" ? sentence(`Hair: ${photoHair}`)
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

  // 6 + 7. The moment and the room.
  const onCamera = clean(look?.onCamera);
  const spot = (onCamera !== "" ? spotOf(onCamera) : undefined) ?? FALLBACK_ROOMS[idHash % FALLBACK_ROOMS.length]!;
  const momentLine = onCamera !== "" ? momentSentence(onCamera, pr.subj, pr.plural, name)
    : sentence(`${pr.subj} ${fallbackPose(demeanor, pr.plural)}, looking into the camera`);
  const settingLine = `Setting: the house ${spot}, softly out of focus behind ${pr.obj}.`;

  // 8. Light, chosen for the spot (the two choices split by the id hash).
  const lights = LIGHT_BY_SPOT[spot]!;
  const lightLine = `Light: ${lights[idHash % 2]!}.`;

  const prompt = [
    "Official cast portrait of a contestant on a reality TV show, photographed by the show's photographer inside the house where the show is filmed.",
    sentence(`${who}${withClause}`),
    hairLine, markLine, clothesLine, momentLine, settingLine, lightLine, BRIEF_TAIL,
  ].filter((x) => x !== "").join(" ");

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
