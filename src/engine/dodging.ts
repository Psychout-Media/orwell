import { clamp01 } from "../domain/num";

/**
 * 0196 / ORW-630 - dodging the question. When a houseguest is pressed and the engine has already decided they do not give the thing up (the A52 `deflect`), this decides HOW they turn it aside: what they do with the question,
 * how their carriage reads while they do it, and whether they hand it back to the asker. The narrator authors every word; the engine hands it only this third-person, number-free fact. Pure and deterministic given the
 * three supplied rolls (the caller owns a dedicated keyed side stream, never the shared rng); no I/O, no Vault, no content of what they hold. Engine-only enum keys, composed from independent axes (never a dealt line).
 */
export type DodgeApproach = "change-subject" | "ask-back" | "laugh-off" | "go-quiet" | "narrow-answer" | "stall";
export type DodgeOpenness = "firm" | "uneasy" | "easy";

export interface DodgeFact {
  approach: DodgeApproach;
  /** How their carriage reads while they dodge (a public tell, never why). */
  openness: DodgeOpenness;
  /** They turn the question around on the asker. */
  pushesBack: boolean;
}

export interface DodgeInput {
  /** 0..1 - the houseguest's guile (their public strategy style). */
  cunning: number;
  /** 0..1 - how readily they leak under pressure (public style plus temperament). */
  leakiness: number;
  /** 0..1 - how shaken they are right now (soul volatility above the middle). */
  rattled: number;
  /** 0..1 - their trust in the ASKER (the bond; never shown). */
  trustInAsker: number;
  /** 0..1 - the stakes of the question for them (what telling could cost). */
  stakes: number;
}

/**
 * ORW-798: the stakes of a dodged question come from what the houseguest actually holds and where they stand, never a literal. `severity` is the public severity of the kind of thing they are keeping (leverage.severityOf, never its
 * text) and `onTheBlock` is whether they are nominated right now (a slip would cost a vote they cannot spare). Bounded to [0,1]; no draw, so every seeded stream is untouched.
 */
export function dodgeStakes(severity: number, onTheBlock: boolean, powerHolder = false): number {
  // ORW-802 (Coordinator default 2026-11-26, Ryne may change it): the HOH or the veto holder is watched more, so a dodge is noticed more; the same for any houseguest. Bounded; no draw.
  return clamp01(0.75 * clamp01(severity) + (onTheBlock ? 0.25 : 0) + (powerHolder ? DODGE_POWER_HOLDER : 0));
}
/** ORW-802: how much a power holder's dodge adds to its stakes. */
export const DODGE_POWER_HOLDER = 0.15;

const APPROACHES: readonly DodgeApproach[] = ["change-subject", "ask-back", "laugh-off", "go-quiet", "narrow-answer", "stall"];

/** Relative weight of each approach from the character, the bond and the stakes (every one stays possible). */
export function approachWeights(i: DodgeInput): Record<DodgeApproach, number> {
  const c = clamp01(i.cunning), t = clamp01(i.trustInAsker), r = clamp01(i.rattled), s = clamp01(i.stakes);
  return {
    "change-subject": 0.5,
    "ask-back": 0.2 + 0.8 * c,
    "laugh-off": 0.15 + 0.8 * t * (1 - s),
    "go-quiet": 0.15 + 0.8 * (1 - t) * (1 - c),
    "narrow-answer": 0.1 + 0.7 * c * t,
    stall: 0.15 + 0.9 * r,
  };
}

/** `rolls` are three independent draws in [0,1) from the caller's keyed side stream: approach, openness jitter, push-back. */
export function decideDodge(i: DodgeInput, rolls: readonly [number, number, number]): DodgeFact {
  const w = approachWeights(i);
  const total = APPROACHES.reduce((n, a) => n + w[a], 0);
  let at = clamp01(rolls[0]) * total;
  let approach: DodgeApproach = "change-subject";
  for (const a of APPROACHES) { if (at < w[a]) { approach = a; break; } at -= w[a]; }
  const strain = 0.55 * clamp01(i.rattled) + 0.45 * clamp01(i.leakiness) + 0.25 * clamp01(i.stakes) * (1 - clamp01(i.cunning)) + 0.3 * (clamp01(rolls[1]) - 0.5);
  const openness: DodgeOpenness = strain > 0.45 ? "uneasy" : clamp01(i.cunning) >= 0.55 && strain < 0.3 ? "easy" : "firm";
  const pBack = clamp01(0.1 + 0.4 * clamp01(i.cunning) + 0.25 * (1 - clamp01(i.trustInAsker)));
  return { approach, openness, pushesBack: clamp01(rolls[2]) < pBack };
}
