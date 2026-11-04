import type { EntityId } from "../domain/ids";

/**
 * B6 / #2017 slice 1 (design S5) - NPC<->NPC LOBBYING of the HOH before nominations. A non-HOH NPC with a stake issues a `Pitch`; the HOH folds a bounded per-week `pitchTilt(subject)`
 * into the nomination score (the same additive slot as the campaign / memory / belief pushes - no new decision shape). The tilt is weighted by how CREDIBLE the HOH finds the pitcher
 * (the caller reads that from the HOH's own edges/memory/deal history) and is capped BELOW the bloc term so lobbying can tilt but never dictate. Pure and deterministic - no rng, no I/O,
 * no Vault. Wiring (the off-screen tick, recording, NPC deals, surfacing via pathways only) is slice 2, flag-off.
 */
export type OfferKind = "safety" | "deal" | "favor" | "info" | "threat";

export interface Pitch {
  from: EntityId;
  kind: OfferKind;
  /** 0..1 - how hard the pitcher pushes. */
  strength: number;
  /** Who the pitch asks the HOH to leave alone (the pitcher themself, or an ally). */
  protects?: EntityId;
  /** Who the pitch steers the HOH toward (an information / threat pitch names a rival). */
  targets?: EntityId;
}

export const LOBBY = {
  /** The most a single houseguest's nomination score can move from all pitches (kept well below the bloc term). */
  maxTilt: 0.18,
  /** Per-kind weight of a full-strength, fully-credible pitch. */
  kindWeight: { safety: 0.14, deal: 0.16, favor: 0.1, info: 0.12, threat: 0.08 } as Readonly<Record<OfferKind, number>>,
} as const;

const clamp = (x: number, lo: number, hi: number): number => (Number.isNaN(x) ? lo : Math.max(lo, Math.min(hi, x)));

/** The signed nomination-score tilt for `subject`: negative = protected by pitches, positive = steered toward. `credibility(pitcher)` is the HOH's trust in the pitcher, 0..1. */
export function pitchTilt(subject: EntityId, pitches: readonly Pitch[], credibility: (pitcher: EntityId) => number): number {
  let sum = 0;
  for (const p of pitches) {
    const w = LOBBY.kindWeight[p.kind] * clamp(p.strength, 0, 1) * clamp(credibility(p.from), 0, 1);
    if (p.protects === subject) sum -= w;
    if (p.targets === subject) sum += w;
  }
  return clamp(sum, -LOBBY.maxTilt, LOBBY.maxTilt);
}

/** The pitcher's own best response by personality: loyal => a safety offer, cunning => trade information, chaotic => a threat. Ties break loyal > cunning > chaos. */
export function chooseOffer(p: { loyalty: number; cunning: number; chaos: number }): OfferKind {
  if (p.loyalty >= p.cunning && p.loyalty >= p.chaos) return "safety";
  if (p.cunning >= p.chaos) return "info";
  return "threat";
}
