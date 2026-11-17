/**
 * ORW-561 / spec 0176 (Theme 3 slice 10, part 1): HOMOPHILY - like attracts like. Pairs who share a look, an age, a part of the country, a kind of job or a temperament bond a little faster
 * and sour a little slower; a mismatched pair the reverse. A nudge on the SPEED of a fold, never a verdict: individuals still surprise.
 *
 * Reads PUBLIC Character facets only (age, presentation label, archetype tag, hometown, vocation). NEVER the Vault: no stats, no hiddenElements, no soul disposition. Pure and deterministic: no rng,
 * no I/O. The similarity and the multiplier are ENGINE-ONLY (listed in the dependency-cruiser engine denylist): they never reach a projection, prompt, tool result or log.
 *
 * `pairBondMult` is a pure magnitude: it scales warming components up and DIVIDES souring ones (the same shape as the house-culture bonding dial), so the fold's jitter draws are untouched.
 */
import { familyForLabel } from "../domain/styleFamilies";
import { tagKind } from "../domain/castRealism";
import { isBigCity, lifeAffluence } from "../domain/styleFit";
import { ARCHETYPES, type Archetype } from "./characterFactory";
import { HOMETOWNS } from "./data/hometowns";
import { HOMOPHILY, STYLE_CLUSTERS } from "./homophilyConstants";

/** The public facets similarity may read. A real `Character` satisfies it structurally; every field may be absent. */
export interface HomophilyFacets { age?: number; presentation?: string; archetype?: string; hometown?: string; vocation?: string }

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const REGION_OF = new Map<string, string>(HOMETOWNS.map((h) => [h.city, h.region]));
const STYLES_OF = new Map<string, readonly string[]>(ARCHETYPES.map((s) => [s.archetype as string, s.styles as readonly string[]]));

function ageSim(a?: number, b?: number): number {
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return HOMOPHILY.NEUTRAL;
  return clamp01(1 - Math.abs(a - b) / HOMOPHILY.AGE_GAP_ZERO);
}

function styleSim(a?: string, b?: string): number {
  const fa = a ? familyForLabel(a) : undefined, fb = b ? familyForLabel(b) : undefined;
  if (!fa || !fb) return HOMOPHILY.NEUTRAL;
  if (fa.id === fb.id) return 1;
  const ca = STYLE_CLUSTERS[fa.id] ?? fa.id, cb = STYLE_CLUSTERS[fb.id] ?? fb.id;
  return ca === cb ? HOMOPHILY.STYLE_SAME_CLUSTER : 0;
}

/** Closeness of two archetype tags by the strategy styles they share (Jaccard); the same archetype is 1. */
function archetypeSim(a?: string, b?: string): number {
  const sa = a ? STYLES_OF.get(a as Archetype) : undefined, sb = b ? STYLES_OF.get(b as Archetype) : undefined;
  if (!sa || !sb) return HOMOPHILY.NEUTRAL;
  if (a === b) return 1;
  const shared = sa.filter((s) => sb.includes(s)).length;
  return shared / new Set([...sa, ...sb]).size;
}

function regionSim(a?: string, b?: string): number {
  const ra = a ? REGION_OF.get(a) : undefined, rb = b ? REGION_OF.get(b) : undefined;
  if (!ra || !rb) return HOMOPHILY.NEUTRAL;
  if (ra === rb) return 1;
  return isBigCity(a) === isBigCity(b) ? HOMOPHILY.REGION_SAME_SIZE_BONUS : 0;
}

function vocationSim(a?: string, b?: string): number {
  if (!a || !b) return HOMOPHILY.NEUTRAL;
  const sa = tagKind("sector", { vocation: a })[0] ?? "other", sb = tagKind("sector", { vocation: b })[0] ?? "other";
  if (sa === sb && sa !== "other") return HOMOPHILY.VOCATION_SAME_SECTOR;
  return clamp01(1 - Math.abs(lifeAffluence({ vocation: a }) - lifeAffluence({ vocation: b })) / 2) * 0.6;
}

/** How alike two houseguests are, 0..1, from public facets only. Symmetric, bounded, deterministic; an unreadable facet counts as neutral. */
export function similarity(a: HomophilyFacets, b: HomophilyFacets): number {
  const W = HOMOPHILY.WEIGHTS;
  const parts: Array<[number, number]> = [
    [W.age, ageSim(a.age, b.age)], [W.style, styleSim(a.presentation, b.presentation)], [W.archetype, archetypeSim(a.archetype, b.archetype)],
    [W.region, regionSim(a.hometown, b.hometown)], [W.vocation, vocationSim(a.vocation, b.vocation)],
  ];
  let num = 0, den = 0;
  for (const [w, v] of parts) { num += w * v; den += w; }
  return clamp01(num / den);
}

/** The per-pair bond-speed multiplier: 1 + (similarity - centre) x span, clamped to [1/F, F]. Exactly 1 for a pair at the centre. Apply it as warm x m, sore / m. */
export function pairBondMult(a: HomophilyFacets, b: HomophilyFacets): number {
  const F = HOMOPHILY.MAX_FACTOR;
  const m = 1 + (similarity(a, b) - HOMOPHILY.CENTER) * HOMOPHILY.SPAN;
  return Math.max(1 / F, Math.min(F, m));
}
