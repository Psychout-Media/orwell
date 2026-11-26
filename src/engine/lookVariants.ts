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

export const SKIN_TAILS: readonly string[] = [
  "with a warm undertone", "with a cool undertone", "with a golden undertone", "with a healthy glow", "with a smooth matte finish", "with a slight sheen",
  "that photographs well", "that shows every blush", "with a flush that comes and goes", "that looks different in every light", "that has seen some sun", "with an even finish",
];
export const BUILD_TAILS: readonly string[] = [
  "who carries it lightly", "with a loose easy stride", "with a slight forward lean", "who stands very straight", "who takes up space easily",
  "who moves without hurry", "who looks quicker than they seem", "with a rolling easygoing walk", "who fills a doorway quietly", "with the carriage of someone used to being looked at",
];
export const HAIR_TAILS: readonly string[] = [
  "freshly cut", "a week past a trim", "kept the same for years", "recently changed", "styled with care", "left to do its own thing", "worn practical", "catching the light",
];
export const FACIAL_TAILS: readonly string[] = [
  "and an expression that gives little away", "and a face that is easy to read", "and eyes that crinkle when amused", "and a jaw that tightens when thinking",
  "and a brow that furrows easily", "and a mouth that rests in a half-smile", "and a gaze that holds a beat too long", "and a face that lights up mid-sentence",
  "and a calm unreadable look", "and a look of constant mild curiosity",
];
export const STYLE_ACCENTS: readonly string[] = [
  "scuffed everyday shoes", "a watch worn on the wrong wrist", "a well-used tote", "a belt with a plain buckle", "a thin scarf", "a canvas cap",
  "clean white sneakers", "a pair of worn boots", "a loop of keys on a lanyard", "a single bracelet", "a faded backpack", "a collar that never quite sits flat",
];
export const AGE_LOOK_TAILS: readonly string[] = [
  "a loose easy stance", "a steady direct gaze", "a ready half-smile", "a slight tilt of the head", "a brisk walk", "a relaxed jaw",
  "a measured way of looking around", "hands that are never still", "a habit of leaning in to listen", "a straight-backed bearing",
  "a quick glance at every exit", "an unhurried way of taking a room in",
];
export const AGE_LOOK_TAILS_2: readonly string[] = [
  "a taste for the last word", "a laugh that arrives early", "a habit of going quiet first", "an easy way with strangers", "a guarded kind of charm",
  "a patient way of waiting", "a sideways look when amused", "a nod that means more than yes", "a way of standing near the door", "a voice that carries without trying",
  "a knack for being underestimated", "a slow, careful blink",
];

export interface LookTails { skin: string; build: string; hair: string; facial: string; style: string; ageLook: string }

/** One tail per houseguest per axis, each used at most once per cast while the axis has enough tails. */
export function dealLookTails(rng: RandomnessSource, count: number): LookTails[] {
  const vr = new SeededRandom(hashSeed(`look-tails:${rng.int(1_000_000_000)}`));
  const cap = (n: number): number => Math.max(1, Math.ceil(count / n));
  const skin = spreadFacet(vr, SKIN_TAILS, count, cap(SKIN_TAILS.length));
  const build = spreadFacet(vr, BUILD_TAILS, count, cap(BUILD_TAILS.length));
  const hair = spreadFacet(vr, HAIR_TAILS, count, cap(HAIR_TAILS.length));
  const facial = spreadFacet(vr, FACIAL_TAILS, count, cap(FACIAL_TAILS.length));
  const style = spreadFacet(vr, STYLE_ACCENTS, count, cap(STYLE_ACCENTS.length));
  const ageLook = spreadFacet(vr, AGE_LOOK_TAILS, count, cap(AGE_LOOK_TAILS.length));
  const ageLook2 = spreadFacet(vr, AGE_LOOK_TAILS_2, count, cap(AGE_LOOK_TAILS_2.length));
  return Array.from({ length: count }, (_, i) => ({ skin: skin[i]!, build: build[i]!, hair: hair[i]!, facial: facial[i]!, style: style[i]!, ageLook: `and ${ageLook[i]!} and ${ageLook2[i]!}` }));
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
