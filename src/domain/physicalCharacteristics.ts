/**
 * The structured PUBLIC physical-characteristics facet (feature 0058 §3/§4).
 *
 * The SINGLE source of truth shared by BOTH the portrait/image-gen prompt (L29) AND the text
 * narration (L23 — stop re-describing bodies): a structured descriptor, distinct from the prose
 * `appearance`/`presentation` blurb, so words and picture never drift. Pure DOMAIN data (no I/O):
 * lives here so the engine factory and any consumer share ONE definition with no import cycle.
 *
 * PUBLIC & Vault-free by construction — every field is a short, gender-neutral English phrase with
 * NO competition-stat-key substring ("physical"/"mental"/"social") and NO bare float, so it can never
 * serialize into the `"physical":`-style key form or the float form the Vault leak-scans hunt for.
 */
export interface PhysicalCharacteristics {
  /** Height + build, e.g. "tall and broad-shouldered". */
  heightBuild: string;
  /** Skin tone / ethnicity cue, e.g. "warm brown skin". */
  skinTone: string;
  /** Hair, e.g. "tight natural curls, jet black". */
  hair: string;
  /** Distinctive facial features, e.g. "a square jaw and deep-set eyes". */
  facialFeatures: string;
  /** A distinguishing mark (scar / tattoo / freckles / piercing), or "none notable". */
  distinguishingMark: string;
  /** An age-appropriate look cue, e.g. "youthful, early-twenties energy". */
  ageLook: string;
  /** Personal style, e.g. "streetwear and bold sneakers". */
  style: string;
  /**
   * ORW-360: 2-3 specific clothing or accessory pieces in the style family (each at most
   * `WARDROBE_ITEM_MAX` chars; no visible words, logos, band or brand names). Optional: seeded floors and
   * older saves omit it.
   */
  wardrobe?: string[];
  /**
   * ORW-360: 1-2 sentences of VISIBLE personality (posture, gaze, expression, grooming, one clothing
   * detail, one spot in the house), at most `ON_CAMERA_MAX` chars. Optional, as `wardrobe`.
   */
  onCamera?: string;
  /**
   * ORW-380: shoot-day hair (the same cut, length and colour as `hair`, styled neat for a photo shoot), at
   * most `PHOTO_HAIR_MAX` chars. Optional, as `wardrobe`.
   */
  photoHair?: string;
  /**
   * ORW-480: the ONE memorable thing about how this person looks or dresses (what you would use to describe them to a friend: a long
   * single braid, a bleached buzz cut and earrings, a shell necklace), authored from their own life, never dealt, at most
   * `LOOK_SIGNATURE_MAX` chars. Optional, as `wardrobe`. The photo prompt reads it from `physicalCharacteristics.lookSignature`.
   */
  lookSignature?: string;
}

export const WARDROBE_ITEM_MAX = 60;
export const WARDROBE_MAX_ITEMS = 3;
export const WARDROBE_MIN_ITEMS = 2;
export const ON_CAMERA_MAX = 240;
export const PHOTO_HAIR_MAX = 90;
export const LOOK_SIGNATURE_MAX = 90;

/** Strip control characters (C0, DEL and the C1 range U+0080-U+009F) and collapse whitespace. */
function cleanText(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

/** Clip to at most `max` CODE POINTS, so a surrogate pair (an emoji) is never cut in half (review of #2716). */
export function clipCodePoints(t: string, max: number): string {
  return t.length <= max ? t : Array.from(t).slice(0, max).join("");
}

/** One clean line clamped to `max` characters, or undefined when nothing is left. */
function cleanLine(v: unknown, max: number): string | undefined {
  const t = clipCodePoints(cleanText(v), max).trim();
  return t.length > 0 ? t : undefined;
}

/** Clean + clamp the authored `wardrobe` (control chars stripped, items clamped, 2 to 3 items: fewer than two is not a facet). */
export function cleanWardrobe(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.map((x) => clipCodePoints(cleanText(x), WARDROBE_ITEM_MAX).trim()).filter((x) => x.length > 0)
    .slice(0, WARDROBE_MAX_ITEMS);
  return items.length >= WARDROBE_MIN_ITEMS ? items : undefined;
}

/** Clean + clamp the authored `onCamera` line. */
export function cleanOnCamera(v: unknown): string | undefined {
  return cleanLine(v, ON_CAMERA_MAX);
}

/** ORW-380: clean + clamp the authored `photoHair` line. */
export function cleanPhotoHair(v: unknown): string | undefined {
  return cleanLine(v, PHOTO_HAIR_MAX);
}

export const STYLE_LINE_MAX = 200;

/** ORW-480: clean + clamp a rewritten `style` line (the line that describes the clothes: it is rewritten with the wardrobe it describes). */
export function cleanStyleLine(v: unknown): string | undefined {
  return cleanLine(v, STYLE_LINE_MAX);
}

/** ORW-480: clean + clamp the authored `lookSignature` line. */
export function cleanLookSignature(v: unknown): string | undefined {
  return cleanLine(v, LOOK_SIGNATURE_MAX);
}
