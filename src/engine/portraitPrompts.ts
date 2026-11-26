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

import { COMMON_WORD_NAMES } from "./commonWordNames";
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
  /** ORW-480: the PUBLIC hometown ("City, State") and biography: the place is somewhere from the person's ordinary day, looking like where they live. */
  hometown?: string;
  biography?: string;
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

/**
 * ORW-953: the staleness key of one face. Only the inputs that change how THIS person looks: age, gender presentation, heritage,
 * the structured physical description (build, skin, hair, features, mark, age look, style, wardrobe, signature), job and hometown
 * (they dress and groom the person), and the prose appearance when there is no structured one. NOT the voice, biography, demeanor,
 * casting read or identity concept (they only steer the dealt shot card), and NOT the dealt shot or face card: those are dealt across the
 * whole cast under per-value caps, so another houseguest's repair can move one person's card while their own look is unchanged.
 * A repair to someone's voice or biography, or to another houseguest, therefore never changes anyone's key.
 */
export function portraitLookKey(facets: PublicAppearanceFacets): string {
  const look = facets.physicalCharacteristics as PortraitLook | undefined;
  const t = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const lookPart = look === undefined ? null : [
    t(look.heightBuild), t(look.skinTone), t(look.hair), t(look.photoHair), t(look.facialFeatures), t(look.distinguishingMark),
    t(look.ageLook), t(look.style), Array.isArray(look.wardrobe) ? look.wardrobe.map(t) : [], t(look.lookSignature),
  ];
  return JSON.stringify([
    facets.age, t(facets.genderPresentation), t(facets.ethnicity), t(facets.vocation), t(facets.hometown),
    lookPart ?? [t(facets.appearance), t(facets.presentation)],
  ]);
}

/** A generated portrait prompt ready to hand to an image provider. */
export interface PortraitPromptResult {
  houseguestId: string;
  name: string;
  prompt: string;
  /** ORW-953: the canonical text of the inputs that change how THIS person looks (see `portraitLookKey`). The staleness fingerprint is taken from it, never from the prompt. */
  lookKey: string;
}

type Gender = "man" | "woman" | "nonbinary";

const SIGNATURE_MARK_RE = /\b(?:tattoo\w*|piercing\w*|nose ring|nose stud|stud|studs|hoop|hoops|earrings?|glasses|freckles?|dimples?|beauty mark)\b/i;
const NOT_SENT_MARK_RE = /\b(?:scars?|scarred|birthmarks?|burns?|burned|chipped|gap-toothed|gap between|tooth gap|teeth gap|gapped)\b/i;
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
const lowerFirst = (t: string): string => (t === "" ? t : t[0]!.toLowerCase() + t.slice(1));
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

/** A word run that already carries its own grammatical subject: ", she stands", ". He grins", "; her gaze stays". */
const OWN_SUBJECT_RE = /(?:^|[,.;\u2014\u2013-])\s*(?:(?:he|she|they|the houseguest)\s+[a-z]+|(?:his|her|their)\s+[a-z]+\s+(?:[a-z]+s|is|are|was|were|has|have|stay|rest|stand)\b)/i; // a possessive is a subject only with its verb ("her gaze stays"), never "hands in his pockets" (review of #2781)
const OPENS_WITH_SPOT_RE = /^(?:kitchen|living room|dining room|backyard|lounge|bedroom)\b/i;

/** Words ending in -s that are never a third-person verb after a name ("always stands"): a they/them line keeps them as they are. */
const S_ADVERBS: ReadonlySet<string> = new Set([
  "always", "sometimes", "perhaps", "nevertheless", "besides", "otherwise", "towards", "afterwards", "backwards", "forwards", "upwards",
  "downwards", "regardless", "nowadays", "indoors", "outdoors", "overseas", "mostly", "thus", "anyways", "nonetheless", "meanwhile",
]);
/** The plural form of a third-person singular verb ("stands" to "stand"), or undefined when it cannot be done safely. */
export function pluralVerb(v: string): string | undefined {
  const w = v.toLowerCase();
  if (S_ADVERBS.has(w)) return undefined;
  const irregular: Record<string, string> = { is: "are", has: "have", does: "do", goes: "go", was: "were" };
  if (irregular[w] !== undefined) return irregular[w];
  if (!/^[a-z]+s$/.test(w) || /(?:ss|us|ous|ics)$/.test(w) || w.length < 4) return undefined;
  if (w.length === 4 && /ies$/.test(w)) return w.slice(0, -1); // lies, ties, dies, vies: "lie", not "ly" (review of #2781)
  if (/[^aeiou]uses$/.test(w) && w.length > 4) return undefined; // focuses, pauses, abuses: "focus" or "pause" cannot be told apart safely: the caller says "the houseguest"
  if (/[^aeiou]ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(?:ch|sh|x|z|ss|o)es$/.test(w)) return w.slice(0, -2);
  return w.slice(0, -1);
}

/** After a "they" that stands where a name was, the verb must agree ("they stand"); else the safe wording "the houseguest". */
function theyThenVerb(rest: string): { text: string; ok: boolean } {
  if (/^\s*,/.test(rest)) return { text: rest, ok: false }; // "Name, arms folded, stands ...": the verb is not next, use "the houseguest"
  const m = /^(\s+)((?:(?:[A-Za-z]+ly|always|sometimes|often|never|perhaps)\s+)?)([A-Za-z]+)/.exec(rest);
  if (m === null) return { text: rest, ok: true }; // "they." or end of text: nothing to agree
  const pv = pluralVerb(m[3]!);
  if (pv === undefined) return { text: rest, ok: false };
  const keep = /^[A-Z]/.test(m[3]!) ? pv[0]!.toUpperCase() + pv.slice(1) : pv;
  return { text: m[1]! + m[2]! + keep + rest.slice(m[0].length), ok: true };
}

/** Words after which a name is the subject of a new clause ("... and Namea stands"). */
const SUBJECT_INTRODUCERS: ReadonlySet<string> = new Set(["and", "but", "while", "as", "then", "when", "because", "so", "if", "that", "where", "though", "until"]);

/** The houseguest's own first name never reaches the image provider: it becomes the pronoun (or the possessive). */
function dropOwnName(t: string, ownName: string | undefined, subj: string): string {
  const first = (ownName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first === "") return t;
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const poss = subj === "He" ? "his" : subj === "She" ? "her" : "their";
  const plural = subj === "They";
  // case-insensitive ("namea stands"), except for a given name that is also an everyday word ("May", "Will"): there only the capitalised form is the name
  const flags = COMMON_WORD_NAMES.has(first.toLowerCase()) ? "u" : "iu";
  let out = t.replace(new RegExp(`\\b${esc}(?:'s|\u2019s)(?![\\p{L}])`, `g${flags}`), poss);
  const re = new RegExp(`\\b${esc}(?![\\p{L}\\p{N}_-])`, flags);
  for (let guard = 0, m = re.exec(out); m !== null && guard < 20; guard++, m = re.exec(out)) {
    const head = out.slice(0, m.index);
    const initial = head.trim() === "" || /[.!?]\s+$/.test(head);
    let rest = out.slice(m.index + m[0].length);
    // the name is a SUBJECT at the start of a sentence or clause; after a verb or preposition ("the camera catches Namea") a subject pronoun would be ungrammatical, so use the safe wording
    const prev = /([A-Za-z]+)\s*$/.exec(head)?.[1]?.toLowerCase();
    const subjectPosition = initial || /[,;:\u2014\u2013(-]\s*$/.test(head) || (prev !== undefined && SUBJECT_INTRODUCERS.has(prev));
    let word: string;
    if (!subjectPosition) word = "the houseguest";
    else if (!plural) word = initial ? subj : subj.toLowerCase();
    else {
      const r = theyThenVerb(rest);
      if (r.ok) { word = initial ? "They" : "they"; rest = r.text; } else word = initial ? "The houseguest" : "the houseguest";
    }
    out = head + word + rest;
  }
  return out;
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
  if (/^(?:he|she|they|his|her|their|the houseguest)\b/i.test(t)) return sentence(upperFirst(t));
  if (OWN_SUBJECT_RE.test(t)) return sentence(upperFirst(t));
  if (OPENS_WITH_SPOT_RE.test(t)) return sentence(`${subj} ${be} in the ${lowerFirst(t)}`);
  if (/^[A-Za-z-]+ing\b/.test(t) || /^(?:on|in|at|by|near|beside|against|under|over|inside|outside|behind|with)\b/i.test(t)) {
    return sentence(`${subj} ${be} ${lowerFirst(t)}`);
  }
  return sentence(`${subj} ${be} photographed with ${lowerFirst(t)}`);
}

/** The realism wording (ORW-480 A/B): (A) a press-kit photograph, (B) a plain documentary portrait of a resident (the default, picked by the owner), (C) a minimal candid photograph. */
export type RealismVariant = "press" | "documentary" | "minimal";

const OPENER: Record<RealismVariant, string> = {
  press: "An unretouched photograph from a reality show's press kit, shot on location by a staff photographer with a full-frame camera, on an ordinary day in the person's own life",
  documentary: "A plain, honest portrait of a local resident by a newspaper documentary photographer, taken where they live on an ordinary day",
  minimal: "A candid photograph",
};
const TAIL: Record<RealismVariant, string> = {
  press: "An ordinary member of the public, not a model or an actor: natural asymmetry, visible pores and uneven skin tone with a little shine, ordinary teeth, flyaway hairs, "
    + "clothes that have been worn and washed, with creases. The place is in normal focus with its real clutter, lit by the ordinary available light there, with its mixed colour, a little sensor grain. "
    + "Keep the stated age exactly. The picture runs to all four edges: no frame, border, black edge, vignette or film-scan rim. Clothes are worn the way this person would on an ordinary day. The only person in the frame; no text or logos.",
  documentary: "Taken the way a local paper would: available light, the real place in normal focus, nothing retouched, the person looking like themselves, real skin and hair, worn everyday clothes. "
    + "Keep the stated age exactly. The picture runs to all four edges: no frame, border, black edge, vignette or film-scan rim. Clothes are worn the way this person would on an ordinary day. The only person in the frame; no text or logos.",
  minimal: "The picture runs to all four edges: no frame or border. Clothes are worn the way this person would on an ordinary day. The only person in the frame; no text or logos.",
};

/** Words from the cards that push a glossy, catalogue look: never passed on (the person is ordinary, not polished). */
/** A clothing item that is work gear or a badge is never passed on (a lanyard, scrubs, an apron: the job does not define the photo). */
const WORK_GEAR_RE = /\b(?:lanyard|badge|name ?tag|scrubs|uniform|apron|stethoscope|hard hat|turnout|high-vis)\b/i;
/** Accessories follow the place: never sunglasses (the eyes must show); hats, scarves, gloves and heavy outerwear only outdoors. */
const ALWAYS_OUT_RE = /\b(?:sunglasses|shades|goggles)\b/i;
const INDOOR_OUT_RE = /\b(?:hat|cap|beanie|fedora|visor|bonnet|scarf|gloves?|coat|parka|puffer|trench|anorak|poncho|windbreaker)\b/i;
const GLOSS_WORD_RE = /\b(?:glossy|sleek|polished|immaculate|pristine|flawless|perfect|perfectly|stunning|gorgeous|glamorous|glam|camera-ready|airbrushed|designer|sharp|neat|neatly|crisp)\b/gi;
export function stripGlossWords(t: string): string {
  return stripWornWords(t.replace(GLOSS_WORD_RE, "").replace(/[\s,]+(?:and|or)\s*(?=[,;.]|$)/gi, "").replace(/^\s*(?:and|or)\s+/i, "").replace(/\b(and|or)\s+(?:and|or)\b/gi, "$1").replace(/\s{2,}/g, " ").replace(/(?:\b(?:a|an|the|with|of|to|in|and|or)\s*)+(?=[,;.])/gi, "").replace(/\s+([,;.])/g, "$1").replace(/(?:,\s*){2,}/g, ", ").replace(/^[\s,;]+|[\s,;]+$/g, "").trim());
}

/**
 * Build the photo-brief v4 prompt (ORW-480): ONE paragraph from the public facets and the SHOT CARD and FACE CARD dealt
 * across the cast (`dealPortraitPlans`). One portrait format for everyone; the place (somewhere from the person's ordinary day), the light,
 * the performance (expression, posture, hands, from their casting read, demeanor, voice energy) from the shot card; the face structure from
 * the face card; a line saying the person is ordinary and their grooming, hands, build and clothes fit their life; a minor mark inside the
 * face sentence (never a tooth gap, never twice). No name, no season anchor (still stored by the adapter, ignored here).
 * `variant` is the realism wording (documentary by default: the owner picked it in the A/B of 2026-11-16). `plan` is the cast's deal; without it the person is dealt alone.
 */
export function buildPortraitPrompt(
  houseguestId: string,
  name: string,
  facets: PublicAppearanceFacets,
  _styleAnchor: string,
  plan?: PortraitPlan,
  variant: RealismVariant = "documentary",
): PortraitPromptResult {
  const { appearance, age, physicalCharacteristics, ethnicity, genderPresentation, vocation, hometown } = facets;
  const look = physicalCharacteristics as PortraitLook | undefined;
  const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const pr = PRONOUNS[genderPresentation ?? "none"];
  const sheet = sheetOf(houseguestId, name, facets);
  const card = plan ?? dealPortraitPlans([sheet]).get(houseguestId)!;
  const { shot, face } = card;

  // Who: age, heritage, gender, build and skin; the face comes from the face card.
  const noun = genderPresentation === "man" ? "man" : genderPresentation === "woman" ? "woman"
    : genderPresentation === "nonbinary" ? "nonbinary person with a soft androgynous look" : "person";
  const article = age === 8 || age === 11 || age === 18 || (age >= 80 && age <= 89) ? "an" : "a";
  const who = `The subject is ${article} ${age}-year-old ${ethnicity ? `${ethnicity} ` : ""}${noun}`;
  let withClause: string;
  if (look) {
    const bits = [look.skinTone, look.heightBuild].map((x) => stripGlossWords(clean(x))).filter((x) => x !== "");
    // the age is exact in the sentence; no ageing descriptor and no beautifying word reaches the image model
    bits.push(`looks ${genderPresentation === "man" ? "his" : genderPresentation === "woman" ? "her" : "their"} age`);
    withClause = bits.length > 0 ? ` with ${bits.join(", ")}` : "";
  } else {
    const prose = stripGlossWords(legacyAppearance(appearance));
    withClause = prose !== "" ? ` with ${prose}` : "";
  }
  // The person looks like their life: an ordinary person, not a model.
  const job = clean(vocation), town = clean(hometown);
  const lifeLine = sentence(`An ordinary person, not a model${job !== "" || town !== "" ? `: a ${age}-year-old ${job !== "" ? job : "resident"}${town !== "" ? ` from ${town}` : ""}` : ""}; `
    + "their grooming, hands, build and clothes fit that life");

  // A minor mark goes inside the face sentence, once (a tooth gap is never sent).
  const markPhrase = signatureMarkClause(look?.distinguishingMark).replace(/\.$/, "").toLowerCase();
  const faceLine = faceSentence(face, markPhrase !== "" ? markPhrase : undefined);

  // Hair: the shoot-day line, or the written cut trimmed; the written length and volume stated plainly.
  const photoHair = stripGlossWords(clean(look?.photoHair));
  const writtenHair = look ? stripGlossWords(trimWrittenHair(clean(look.hair))) : "";
  const hairLine = photoHair !== "" ? sentence(writtenHair !== "" && !photoHair.toLowerCase().includes(writtenHair.toLowerCase())
      ? `Hair: ${photoHair} (the cut as written: ${writtenHair}; exactly that length and volume, no longer or bigger)` : `Hair: ${photoHair}`)
    : writtenHair !== "" ? sentence(`Hair: ${writtenHair}`) : "";

  // Clothes: what the card says they wear (as worn).
  const wardrobe = Array.isArray(look?.wardrobe)
    ? look!.wardrobe!.filter((w): w is string => typeof w === "string").map((w) => stripGlossWords(w.trim())).filter((w) => w !== "" && !WORK_GEAR_RE.test(w) && !ALWAYS_OUT_RE.test(w) && (shot.outdoor || !INDOOR_OUT_RE.test(w)))
    : [];
  const styleText = stripGlossWords(clean(look?.style) !== "" ? clean(look?.style) : facets.presentation.trim());
  const clothesLine = wardrobe.length > 0 ? sentence(`Wearing ${wardrobe.join(", ")}, in their own everyday clothes and never a uniform, scrubs, apron, badge or work gear`)
    : sentence(`Wearing everyday clothes in this style: ${styleText}`);

  // The shot: place, light, the performance, any prop.
  const settingLine = sentence(`Setting: ${shot.place}`);
  const lightLine = variant === "minimal" ? "" : sentence(`Light: ${shot.light}`);
  // ORW-441: a person dealt alone (no cast plan) whose card carries the cast writer's own onCamera moment keeps that moment, made a sentence with a subject and no name;
  // inside a cast deal the dealt performance stands (one pose per person, spread across the cast)
  const ownMoment = plan === undefined && clean(look?.onCamera) !== "" ? momentSentence(clean(look?.onCamera), pr.subj, pr.plural, name) : "";
  // (only the dealt expression stays then, so the writer's pose and the dealt posture never double up)
  const momentLine = sentence(`The moment: ${ownMoment !== "" ? (shot.moment.split(";")[0] ?? shot.moment).trim() : shot.moment}`);
  const propLine = shot.prop !== undefined ? sentence(`${pr.subj} ${pr.plural ? "are" : "is"} ${shot.prop}`) : "";
  const format = sentence(`Framing, the same for the whole series: ${shot.framing}, ${shot.angle}, on ${shot.lens}`);

  const opener = variant === "minimal" ? sentence(OPENER.minimal) : sentence(OPENER[variant]);
  const prompt = [
    opener, sentence(`${who}${withClause}`), lifeLine, faceLine, hairLine, clothesLine, ownMoment, settingLine, lightLine, momentLine, propLine, format, TAIL[variant],
  ].filter((x) => x !== "").join(" ");

  return { houseguestId, name, prompt, lookKey: portraitLookKey(facets) };
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
    ...(f.hometown !== undefined ? { hometown: f.hometown } : {}),
    ...(f.biography !== undefined ? { biography: f.biography } : {}),
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
    ...(hg.hometown !== undefined ? { hometown: hg.hometown } : {}),
    ...(hg.biography !== undefined ? { biography: hg.biography } : {}),
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
    hometown?: string;
    biography?: string;
  }>,
  styleAnchor: string,
  variant: RealismVariant = "documentary",
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
          ...(hg.hometown !== undefined ? { hometown: hg.hometown } : {}),
          ...(hg.biography !== undefined ? { biography: hg.biography } : {}),
        },
        styleAnchor,
        plans.get(hg.id),
        variant,
      ),
    );
}
