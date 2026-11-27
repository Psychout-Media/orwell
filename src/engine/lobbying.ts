import type { EntityId } from "../domain/ids";
import { clampGuarded } from "../domain/num";

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

const clamp = clampGuarded;

/** The signed nomination-score tilt for `subject`: negative = protected by pitches, positive = steered toward. `credibility(pitcher)` is the HOH's trust in the pitcher, 0..1.
 *  ORW-694 / B1-9: `standing(pitcher)` weighs a pitch by the pitcher's standing in the house (1 = ordinary; a leader's / lieutenant's pitch carries more). Absent => 1, byte-identical. */
export function pitchTilt(subject: EntityId, pitches: readonly Pitch[], credibility: (pitcher: EntityId) => number, standing?: (pitcher: EntityId) => number): number {
  let sum = 0;
  for (const p of pitches) {
    const w = LOBBY.kindWeight[p.kind] * clamp(p.strength, 0, 1) * clamp(credibility(p.from), 0, 1) * (standing ? Math.max(0, standing(p.from)) : 1);
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

/**
 * ORW-779 (Ryne 2026-11-26: "Social play can definitely work") - the HOH's PRIVATE ANSWER to a plea for safety. A pitch used to be only a score nudge (about 0.05 against a typical
 * 0.27 gap to the next candidate), so talk never saved anybody. Now the HOH decides: leave them off, or not. Never certain, nothing for a distrustful or hostile HOH, and a yes can
 * be faked (a cunning HOH says yes and puts them up anyway). The two dice are fixed per reign by the caller, so asking again can never re-roll them: more talk only helps by the
 * trust it earns.
 */
export const PITCH_ANSWER = {
  /** Below this trust in the asker the HOH does not agree at all (a typical newcomer reads 0.25). */
  trustFloor: 0.25,
  /** The chance at the floor, and what full trust (`trustFull`) adds on top. */
  chanceAtFloor: 0.35,
  chanceAdded: 0.35,
  trustFull: 0.75,
  /** Above this threat read the chance falls, by as much as the read exceeds it. */
  threatEase: 0.6,
  /** How often the most cunning HOH's yes is a fake one. */
  fakeAtFullCunning: 0.4,
} as const;

export interface PitchAnswerInputs { trust: number; threat: number; cunning: number; hostile: boolean }

/** The chance this HOH says yes (0 for a hostile or distrustful one; at most `chanceAtFloor + chanceAdded`). */
export function pitchAgreeChance(i: PitchAnswerInputs): number {
  const A = PITCH_ANSWER;
  if (i.hostile || !(i.trust >= A.trustFloor)) return 0;
  const warmth = clamp((i.trust - A.trustFloor) / (A.trustFull - A.trustFloor), 0, 1);
  return (A.chanceAtFloor + A.chanceAdded * warmth) * (1 - clamp(i.threat - A.threatEase, 0, 1));
}

export function pitchAnswer(i: PitchAnswerInputs, rolls: { agree: number; fake: number }): { agreed: boolean; sincere: boolean } {
  const agreed = rolls.agree < pitchAgreeChance(i);
  return { agreed, sincere: agreed && !(rolls.fake < PITCH_ANSWER.fakeAtFullCunning * clamp(i.cunning, 0, 1)) };
}
