/**
 * ORW-508: composed look axes. The character-facing look lists (skin tone, build, hair, face, style, age look)
 * were short pools dealt one value per houseguest, so the same wording came back within a few seasons. Each base
 * value is now extended by an independent second axis (a tail of its own), so a field is base x tail values
 * (hundreds) instead of a dozen. The base list keeps its own cast-wide cap, so the tails are an addition and
 * never replace a fitting rule (age, gender, heritage, band). Tails are neutral (no height, colour, age, mark or
 * flaw word), which is what lets every base stay valid with every tail. Pure; deterministic off the rng it is given.
 */
import { SeededRandom } from "../adapters/random/SeededRandom";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { hashSeed, spreadFacet } from "./characterFactory";

// The narrator prompt carries the build, skin, hair, face and age-look lines of all 16 cards and has a hard character budget
// (tests/unit/promptBudget.test.ts), so the tails on those lines are ONE short word each. The style line is not in that prompt, so its accent can be a phrase.
export const SKIN_TAILS: readonly string[] = ["warm", "cool", "soft", "even", "clear", "matte", "dewy", "rosy", "bright", "smooth"];
export const HAIR_TAILS: readonly string[] = ["tidy", "fresh", "neat", "soft", "shiny", "clean", "easy", "sleek", "styled", "brushed"];
export const FACIAL_TAILS: readonly string[] = ["calm", "wry", "open", "alert", "earnest", "guarded", "amused", "bright"];
export const STYLE_ACCENTS: readonly string[] = [
  "scuffed everyday shoes", "a watch worn on the wrong wrist", "a well-used tote", "a belt with a plain buckle", "a thin scarf", "a canvas cap",
  "clean white sneakers", "a pair of worn boots", "a loop of keys on a lanyard", "a single bracelet", "a faded backpack", "a collar that never quite sits flat",
];
export const AGE_LOOK_TAILS: readonly string[] = ["brisk", "poised", "relaxed", "upright", "easygoing", "watchful", "alert", "graceful", "steady", "lively", "composed", "restless"];

export interface LookTails { skin: string; hair: string; facial: string; style: string; ageLook: string; ageLookPick: number }

/** One tail per houseguest per axis, each used at most about once per cast while the axis has enough tails. The build has no tail (see above). */
export function dealLookTails(rng: RandomnessSource, count: number): LookTails[] {
  const vr = new SeededRandom(hashSeed(`look-tails:${rng.int(1_000_000_000)}`));
  const cap = (n: number): number => Math.max(1, Math.ceil(count / n));
  const skin = spreadFacet(vr, SKIN_TAILS, count, cap(SKIN_TAILS.length));
  const hair = spreadFacet(vr, HAIR_TAILS, count, cap(HAIR_TAILS.length));
  const facial = spreadFacet(vr, FACIAL_TAILS, count, cap(FACIAL_TAILS.length));
  const style = spreadFacet(vr, STYLE_ACCENTS, count, cap(STYLE_ACCENTS.length));
  const ageLook = spreadFacet(vr, AGE_LOOK_TAILS, count, cap(AGE_LOOK_TAILS.length));
  // the wording of the age look is picked per person; within a cast neighbours in the same band get different wordings through the shared index stream
  return Array.from({ length: count }, (_, i) => ({ skin: skin[i]!, hair: hair[i]!, facial: facial[i]!, style: style[i]!, ageLook: ageLook[i]!, ageLookPick: vr.int(1_000_000) }));
}

// ── Marks: composed from kind templates, so the named pool is in the hundreds (was 43) ──
const FRAMES = ["round", "square", "rectangular", "oval", "cat-eye", "aviator-style", "browline", "wire-rimmed", "oversized round", "thin-framed", "angular", "half-rim"];
const FRAME_COLOURS = ["tortoiseshell", "black", "clear", "gold", "silver", "navy", "burgundy", "olive", "translucent pink", "matte grey", "brown", "two-tone"];
const EAR_TYPES = ["stud earring", "hoop earring", "huggie earrings", "drop earrings", "cartilage piercing"];
const EAR_METALS = ["gold", "silver", "rose-gold", "pearl", "tiny diamond", "black", "turquoise", "jade"];
const EAR_SIDES = ["in the left ear", "in the right ear", "in each ear"];
const NOSE_TYPES = ["nose stud", "nose ring"];
const NOSE_METALS = ["tiny gold", "small silver", "small diamond", "thin gold", "tiny turquoise", "thin silver"];
const NOSE_SIDES = ["on the left", "on the right"];
const FRECKLE_DENSITY = ["a dusting of", "a few", "heavy", "faint", "scattered", "dense"];
const FRECKLE_AREAS = ["across the nose", "across the cheeks", "under one eye", "on the shoulders", "across the nose and forehead", "along the jaw", "on the forearms", "on the nose and temples", "on the backs of the hands", "on the upper chest"];
const DIMPLE_KINDS = ["deep", "faint", "soft", "pronounced", "boyish", "shallow", "uneven"];
const DIMPLE_WHEN = ["dimples when talking", "dimples when smiling", "dimples in both cheeks", "dimples that show when they laugh"];
const BEAUTY_SIZES = ["a beauty mark", "a small beauty mark", "a faint beauty mark", "a dark beauty mark"];
const BEAUTY_SPOTS = ["on one cheek", "above the lip", "near one eye", "on the chin", "on the left cheekbone", "on the right cheekbone", "by the left eyebrow", "by the right eyebrow", "on the jaw", "at the corner of the mouth", "on the temple", "beside the nose"];
const TATTOO_SIZES = ["small", "tiny", "delicate", "thin-lined", "simple"];
const TATTOO_SPOTS = ["wrist", "inner forearm", "ankle", "collarbone", "upper-arm", "forearm", "back-of-the-neck", "behind-the-ear"];

/** The composed named marks (no "none"). Every entry carries a word the casting-director tagger reads for its kind. */
export function composedMarks(): string[] {
  const out: string[] = [];
  for (const f of FRAMES) for (const c of FRAME_COLOURS) out.push(`${f} ${c} glasses`);
  for (const t of EAR_TYPES) for (const m of EAR_METALS) for (const s of EAR_SIDES) out.push(`a ${m} ${t} ${s}`);
  for (const t of NOSE_TYPES) for (const m of NOSE_METALS) for (const s of NOSE_SIDES) out.push(`a ${m} ${t} ${s}`);
  out.push("a tiny eyebrow piercing", "a small eyebrow piercing on the left", "a small eyebrow piercing on the right");
  for (const d of FRECKLE_DENSITY) for (const a of FRECKLE_AREAS) out.push(`${d} freckles ${a}`);
  for (const k of DIMPLE_KINDS) for (const w of DIMPLE_WHEN) out.push(`${k} ${w}`);
  out.push("a single dimple on the left cheek", "a single dimple on the right cheek", "a dimpled chin", "a cleft chin with a dimple");
  for (const s of BEAUTY_SIZES) for (const p of BEAUTY_SPOTS) out.push(`${s} ${p}`);
  for (const s of TATTOO_SIZES) for (const p of TATTOO_SPOTS) out.push(`a ${s} ${p.replace(/-/g, " ")} tattoo`);
  out.push("a half-sleeve tattoo");
  return out;
}

/**
 * Age-look wordings per age band (same length as the single line they sit beside, so the prompt budget does not move). Index 0 of each band is the
 * wording `ageLookFor` always returned; every wording names the decade the band covers, so the look still agrees with the age.
 */
export const AGE_LOOK_BANDS: readonly (readonly string[])[] = [
  ["fresh, early-twenties energy", "bright-eyed, early-twenties and quick to grin", "early-twenties, restless and eager", "young early-twenties glow, a little scrappy",
    "scrappy, early-twenties hunger in the eyes", "early-twenties, bouncy and open-faced", "early-twenties and newly confident", "easy early-twenties charm, still growing into it"],
  ["bright, late-twenties look", "late-twenties and sharp-eyed", "late-twenties, relaxed and camera-ready", "settled late-twenties polish",
    "late-twenties, quick and self-assured", "late-twenties with a ready smile", "late-twenties, a little driven", "put-together late-twenties, easy on the eyes"],
  ["polished, thirties poise", "thirties, composed and watchful", "thirties ease, comfortable in their skin", "sharp, well-rested thirties look",
    "thirties, confident with a tired smile", "thirties, polished with a hint of mischief", "grounded thirties presence", "thirties, practiced calm and a direct look"],
  ["fit and well-kept, forties ease, a few laugh lines", "forties, steady and self-possessed", "forties, lived-in in a good way", "well-kept forties, easy authority",
    "forties, sharp eyes and a few laugh lines", "forties, relaxed and quietly commanding", "fit forties, lived-in charm", "forties, calm and a little knowing"],
  ["distinguished, fit fifties, laugh lines and presence", "fifties, silver-touched and self-assured", "fifties, easy charm and poise", "fit fifties, steady and unhurried",
    "fifties, a face that has seen things", "distinguished fifties, warm and commanding", "fifties, lined and lively", "fifties, composed with a sly grin"],
];
export function ageLookVariant(age: number, pick: number): string {
  const band = age < 25 ? 0 : age < 32 ? 1 : age < 40 ? 2 : age < 50 ? 3 : 4;
  const list = AGE_LOOK_BANDS[band]!;
  return list[pick % list.length]!;
}
