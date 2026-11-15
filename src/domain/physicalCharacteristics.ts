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
}

export const WARDROBE_ITEM_MAX = 60;
export const WARDROBE_MAX_ITEMS = 3;
export const ON_CAMERA_MAX = 240;

/** Strip control characters and collapse whitespace. */
function cleanText(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

/** Clean + clamp the authored `wardrobe` (control chars stripped, items clamped, at most 3). */
export function cleanWardrobe(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.map((x) => cleanText(x).slice(0, WARDROBE_ITEM_MAX).trim()).filter((x) => x.length > 0)
    .slice(0, WARDROBE_MAX_ITEMS);
  return items.length > 0 ? items : undefined;
}

/** Clean + clamp the authored `onCamera` line. */
export function cleanOnCamera(v: unknown): string | undefined {
  const t = cleanText(v).slice(0, ON_CAMERA_MAX).trim();
  return t.length > 0 ? t : undefined;
}
