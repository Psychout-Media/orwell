import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";
import type { BondReader } from "./bonds";
import type { EvictionManner } from "./jury";

/**
 * Theme 3 slice 15 (ORW-567, feature 0185) - MOOD CONTAGION. A shocking eviction rattles the evictee's close allies most and the house a little; a big
 * win lifts the winner's circle a little. This module only works out HOW MUCH of the original mood impulse each houseguest catches (a 0..1 scale); the
 * adapter applies it through `evolveEmotion`'s `scale` option. Nothing here writes, rolls or shows anything.
 *
 * ENGINE-ONLY (Vault class: it reads bonds and the hidden eviction-manner record). Pure: no I/O, no rng, deterministic, ids walked in sorted order.
 * The scale is never projected: the only thing that ever surfaces is the existing mood word, through the channels that already read the soul.
 */
export const MOOD_CONTAGION = {
  /** The share of the impulse the whole house catches, even a stranger (a house-wide ripple). */
  HOUSE_SHARE: 0.06,
  /** How much a friend-of-a-friend link counts against a direct tie. */
  HOP_DECAY: 0.5,
  /** The ceiling on any one houseguest's scale. */
  MAX_SCALE: 0.8,
  /** The size of the good-mood impulse after a win, against a full shock of 1. */
  WIN_MAGNITUDE: 0.35,
  /** Culture dials are held to this band even if a caller hands in more (mirrors the culture bound). */
  MAX_FACTOR: 1.35,
} as const;

/** The culture dials the spread reads; each is exactly 1 with no culture. */
export interface ContagionDials { paranoia?: number; bonding?: number; loyalty?: number }

const band = (x: number | undefined): number => {
  const v = x === undefined || !Number.isFinite(x) ? 1 : x;
  return Math.min(MOOD_CONTAGION.MAX_FACTOR, Math.max(1 / MOOD_CONTAGION.MAX_FACTOR, v));
};

/** How shocking an eviction was: the worst blindsided/betrayed read the evictee holds toward anyone (0..1). An expected or respected exit is 0. */
export function shockOf(manner: Readonly<Record<EntityId, EvictionManner>> | undefined): number {
  let s = 0;
  for (const id of Object.keys(manner ?? {}).sort()) {
    const m = manner![id];
    if (!m || !(m.blindsided || m.betrayed)) continue;
    const i = m.intensity === undefined || !Number.isFinite(m.intensity) ? 1 : clamp01(m.intensity);
    if (i > s) s = i;
  }
  return s;
}

/** How close `h` is to `source`: the stronger of the direct tie and a discounted two-step tie through anyone else living. 0..1. */
export function exposureOf(reader: BondReader, h: EntityId, source: EntityId, loyalty = 1): number {
  const direct = clamp01(reader.tie(h, source) * band(loyalty));
  let hop = 0;
  for (const k of [...reader.living()].sort()) {
    if (k === h || k === source) continue;
    const v = reader.tie(h, k) * reader.tie(k, source);
    if (v > hop) hop = v;
  }
  return Math.max(direct, MOOD_CONTAGION.HOP_DECAY * hop);
}

export interface CatchInput {
  reader: BondReader;
  /** Whose mood moved: the evictee, or the winner. */
  source: EntityId;
  /** The size of the original impulse, 0..1 (the shock, or the win magnitude). 0 spreads nothing. */
  magnitude: number;
  /** "bad" for a rattle (paranoia scales it), "good" for a lift (bonding scales it). */
  mood: "bad" | "good";
  /** Who can catch it: the NPCs still in the house (the caller leaves out the source, the player and anyone already hit). */
  candidates: readonly EntityId[];
  dials?: ContagionDials;
}

/** Each candidate's catch scale in 0..1, in sorted id order. Empty when the magnitude is 0. */
export function catchScales(input: CatchInput): Array<{ id: EntityId; scale: number }> {
  const out: Array<{ id: EntityId; scale: number }> = [];
  const m0 = clamp01(input.magnitude);
  if (!(m0 > 0)) return out;
  const d = input.dials ?? {};
  const m = m0 * band(input.mood === "bad" ? d.paranoia : d.bonding);
  const H = MOOD_CONTAGION.HOUSE_SHARE;
  for (const id of [...input.candidates].sort()) {
    if (id === input.source) continue;
    const e = exposureOf(input.reader, id, input.source, d.loyalty);
    const scale = Math.min(MOOD_CONTAGION.MAX_SCALE, clamp01(m * (H + (1 - H) * e)));
    if (scale > 0) out.push({ id, scale });
  }
  return out;
}
