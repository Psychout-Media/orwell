/**
 * ORW-480: the casting-director table and its tagger (TypeScript half). The data lives in `castRealism.json` (mirrored in
 * frontend/src/cast_realism.json); the Python half is frontend/src/orwell_cast_realism.py. Both must tag the cases in
 * tests/fixtures/orw480_tag_cases.json identically. Pure, deterministic, public card text only.
 */
import table from "./castRealism.json";

export interface CapSpec { share: number; min: number }
export interface ValueDef { words: string[]; cap?: CapSpec }
export interface KindDef {
  field: string; multi: boolean; cap: CapSpec; note?: string; scope?: string; rule?: string; fallback?: string;
  values?: Record<string, ValueDef>;
  rules?: Array<{ sector: string; any: string[]; not?: string[] }>;
  generic?: string[]; "generic-cap"?: CapSpec;
}
export const CAST_REALISM = table as unknown as { kinds: Record<string, KindDef>; "unreal-clothes": { words: string[] }; "garment-nouns": string[]; "garment-groups": Record<string, string[]>; "garment-joiners": string[] };

/** The public card text the kinds read (a subset of the house card). */
export interface RealismCard {
  vocation?: string;
  distinguishingMark?: string;
  physicalCharacteristics?: { onCamera?: string; wardrobe?: readonly string[]; distinguishingMark?: string } | undefined;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRes = new Map<string, RegExp>();
function wordRe(w: string): RegExp {
  let r = wordRes.get(w);
  if (!r) {
    // a space in a table word also matches a hyphen ("home health" reads "home-health")
    const sp = (x: string): string => esc(x).replace(/ /g, "[ -]");
    r = w.endsWith("*") ? new RegExp(`\\b${sp(w.slice(0, -1))}`, "i") : new RegExp(`\\b${sp(w)}(?:s|es)?\\b`, "i");
    wordRes.set(w, r);
  }
  return r;
}

function earliest(def: ValueDef, text: string): number | undefined {
  let best: number | undefined;
  for (const w of def.words) {
    const m = wordRe(w).exec(text);
    if (m && (best === undefined || m.index < best)) best = m.index;
  }
  return best;
}

function fieldText(card: RealismCard, field: string, firstItem: boolean): string {
  const phys = card.physicalCharacteristics ?? {};
  if (field === "vocation") return String(card.vocation ?? "");
  if (field === "distinguishingMark") return String(card.distinguishingMark ?? phys.distinguishingMark ?? "");
  if (field === "onCamera") return String(phys.onCamera ?? "");
  if (field === "lookSignature") return String((phys as { lookSignature?: unknown }).lookSignature ?? "");
  if (field === "wardrobe") {
    const items = Array.isArray(phys.wardrobe) ? phys.wardrobe.map(String) : [];
    return firstItem ? (items[0] ?? "") : items.join(" | ");
  }
  return "";
}

/** The values of one kind a card carries ([] when none). */
export function tagKind(kindId: string, card: RealismCard): string[] {
  const kind = CAST_REALISM.kinds[kindId]!;
  const text = fieldText(card, kind.field, kind.scope === "first-item");
  if (text.trim() === "") return [];
  if (kind.rule === "rules") {
    for (const rule of kind.rules ?? []) {
      if (rule.any.some((w) => wordRe(w.trim()).test(text)) && !(rule.not ?? []).some((w) => wordRe(w.trim()).test(text))) return [rule.sector];
    }
    return ["other"];
  }
  if (kind.rule === "head-noun") {
    const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
    return words.length > 0 ? [words[words.length - 1]!] : [];
  }
  const hits: Array<[string, number]> = [];
  for (const [v, def] of Object.entries(kind.values ?? {})) {
    const pos = earliest(def, text);
    if (pos !== undefined) hits.push([v, pos]);
  }
  if (kind.multi) return hits.map(([v]) => v);
  if (hits.length > 0) {
    if (kind.rule === "earliest") return [hits.reduce((a, b) => (b[1] < a[1] ? b : a))[0]];
    return [hits[0]![0]];
  }
  return kind.fallback ? [kind.fallback] : [];
}

export type CardTags = Record<string, string[]>;
export function tagCard(card: RealismCard): CardTags {
  const out: CardTags = {};
  for (const k of Object.keys(CAST_REALISM.kinds)) {
    const v = tagKind(k, card);
    if (v.length > 0) out[k] = v;
  }
  return out;
}

export function capFor(kindId: string, value: string, n: number): number {
  const kind = CAST_REALISM.kinds[kindId]!;
  const cap = kind.rule === "head-noun" && kind.generic?.includes(value) ? kind["generic-cap"]! : (kind.values?.[value]?.cap ?? kind.cap);
  return Math.max(cap.min, Math.ceil(cap.share * n));
}

export function countValues(tags: readonly CardTags[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const t of tags) for (const [k, vals] of Object.entries(t)) for (const v of new Set(vals)) {
    out[k] ??= {};
    out[k]![v] = (out[k]![v] ?? 0) + 1;
  }
  return out;
}

/** {kind: {value: count}} for every value on more cards than its cap allows in a cast of `n` (default: the list length). */
export function overCap(tags: readonly CardTags[], n: number = tags.length): Record<string, Record<string, number>> {
  const found: Record<string, Record<string, number>> = {};
  for (const [k, vals] of Object.entries(countValues(tags))) for (const [v, c] of Object.entries(vals)) {
    if (v !== "other" && c > capFor(k, v, n)) (found[k] ??= {})[v] = c;
  }
  return found;
}

/** The values a card would add beyond the cap, given the tags of the cards already accepted (only LATER cards are named). */
export function offendersFor(tags: CardTags, earlier: readonly CardTags[], n: number): Record<string, string[]> {
  const counts = countValues(earlier);
  const out: Record<string, string[]> = {};
  for (const [k, vals] of Object.entries(tags)) for (const v of vals) {
    if (v !== "other" && (counts[k]?.[v] ?? 0) >= capFor(k, v, n)) (out[k] ??= []).push(v);
  }
  return out;
}

/** The unreal-clothes words found in a wardrobe piece or the style line. */
export function unrealClothes(text: string): string[] {
  return CAST_REALISM["unreal-clothes"].words.filter((w) => new RegExp(`\\b${esc(w)}`, "i").test(text));
}

/** True when a wardrobe piece names a garment or accessory noun a shop sells. */
export function isGarment(item: string): boolean {
  return CAST_REALISM["garment-nouns"].some((n) => new RegExp(`\\b${esc(n)}s?\\b`, "i").test(item));
}

/** The garment groups a single wardrobe piece names; two groups in one piece means it is two things. */
export function garmentGroups(item: string): string[] {
  return Object.entries(CAST_REALISM["garment-groups"]).filter(([, nouns]) => nouns.some((n) => new RegExp(`\\b${esc(n).replace(/ /g, "[ -]")}s?\\b`, "i").test(item))).map(([g]) => g);
}
export function isMultiGarment(item: string): boolean {
  const groups = garmentGroups(item).filter((g) => g !== "belt-scarf");
  if (groups.length < 2) return false;
  return new RegExp(`\\b(?:${CAST_REALISM["garment-joiners"].map(esc).join("|")})\\b|,`, "i").test(item);
}
