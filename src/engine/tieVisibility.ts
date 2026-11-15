import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { StrategyStyle } from "./characterFactory";
import type { PreGameTie, TieNature, TieVisibility } from "./seededRelationships";
import { TIE_AFFINITY_BIAS, TIE_LOAD_PROB } from "./seededRelationships";

/**
 * ORW-132 (Ryne's ruling, 2026-11-06): "depends on the pair for sure ... this is a huge minority, and should be similar to reserve twists. These should noted as starting out as a secret, or publically shared from the
 * beginning." Pure (no I/O, no store, no clock, no Vault). Three small things live here, every magnitude in ONE place:
 *  1. RARITY: `TIE_LOAD_PROB` (defined next to the loader) - the chance a budgeted tie slot actually loads (ASSUMED 0.25, pending Ryne; reserve twists load at 0.5 per slot, so ties are rarer than twists, a "huge minority").
 *  2. VISIBILITY: every tie is marked `secret` or `public` AT SEASON START by a dedicated seeded draw whose chance depends on WHAT the pair is to each other (`PUBLIC_TIE_CHANCE`, ASSUMED pending Ryne): siblings and
 *     former teammates are naturally out in the open, an ex or a rival is far more often kept quiet. A public tie is a settled house fact from Day 1; a secret one stays sealed and spreads only by the normal rules.
 *  3. HOSTILITY: an `ex` or a `rival` starts COLD, not warm, and HOW cold is each person's own temperament (`tieDirectedBias`): a prickly, volatile houseguest holds the bad blood harder; an easy-going one barely does.
 *     Every other nature keeps the original small warm bias, byte-identical.
 */
export { TIE_LOAD_PROB };

/** ASSUMED pending Ryne: the chance a tie of this nature is PUBLICLY known from Day 1 (otherwise it starts secret). */
export const PUBLIC_TIE_CHANCE: Readonly<Record<TieNature, number>> = {
  "family": 0.8,
  "former-teammate": 0.7,
  "shared-hometown": 0.6,
  "casting-callback": 0.6,
  "online-acquaintance": 0.5,
  "old-friend": 0.5,
  "rival": 0.4,
  "mutual-friend": 0.3,
  "old-acquaintance": 0.3,
  "ex": 0.25,
  "prior-romance": 0.2,
};

/** ASSUMED pending Ryne: how cold a hostile tie starts. A houseguest's own prickliness in [0,1] scales the span between the two ends. */
export const TIE_HOSTILITY = { base: 0.05, span: 0.12 } as const;
export const HOSTILE_NATURES: readonly TieNature[] = ["ex", "rival"];

/** ASSUMED pending Ryne: how prickly (how hard they hold bad blood) each strategy style is, 0..1. */
const PRICKLE_BY_STYLE: Readonly<Record<StrategyStyle, number>> = {
  aggressive: 0.9, strategic: 0.7, emotional: 0.6, social: 0.35, "under-the-radar": 0.3, loyal: 0.2,
};
/** A volatile temperament holds a grudge harder: up to this much more prickly at volatility 1. */
const PRICKLE_VOLATILITY_WEIGHT = 0.3;

export function tiePrickle(style: StrategyStyle | undefined, volatility: number): number {
  const base = style ? PRICKLE_BY_STYLE[style] ?? 0.5 : 0.5;
  const v = Number.isFinite(volatility) ? Math.max(0, Math.min(1, volatility)) : 0.3;
  return Math.max(0, Math.min(1, base * (1 - PRICKLE_VOLATILITY_WEIGHT) + v * PRICKLE_VOLATILITY_WEIGHT));
}

/** The standing affinity `holder` starts with toward their tied partner: warm (the original small bias) for friendly natures, COLD and personality-scaled for an ex or a rival. */
export function tieDirectedBias(nature: TieNature, style: StrategyStyle | undefined, volatility: number): number {
  if (!HOSTILE_NATURES.includes(nature)) return TIE_AFFINITY_BIAS;
  return -(TIE_HOSTILITY.base + TIE_HOSTILITY.span * tiePrickle(style, volatility));
}

/** Mark each tie `secret` | `public` from a DEDICATED seeded draw (one `next()` per tie, in tie order). A tie that already carries a mark keeps it (never re-decided). Returns NEW tie objects. */
export function markTieVisibility(ties: readonly PreGameTie[], rng: RandomnessSource): PreGameTie[] {
  return ties.map((t) => {
    const roll = rng.next(); // always drawn, so the stream shape never depends on prior marks
    if (t.visibility) return { ...t };
    const visibility: TieVisibility = roll < PUBLIC_TIE_CHANCE[t.nature] ? "public" : "secret";
    return { ...t, visibility };
  });
}

/** The prose a PUBLIC tie is announced with on Day 1 (Vault-free: it is, by construction, a public fact). */
export function publicTieAnnouncement(nameA: string, nameB: string, prose: string): string {
  return `It is known in the house: ${nameA} and ${nameB} ${prose}.`;
}

export type { EntityId };
