import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";
import { JURY_MINDS } from "./juryMindsConstants";

/**
 * 0193 (ORW-623, Ryne OK'd 2026-11-17) - THE ENDGAME CHANGES THE RULES OF TRUST. At four houseguests or fewer every relationship becomes "can I beat you?": each
 * houseguest weighs their own odds against every rival at a final two, and that read pushes their nominations and their vote, tilts how sincerely they reassure
 * someone, and old final-two promises get tested out loud. PURE: no rng, no I/O, no Vault handle. Engine-only: nothing here is ever shown as a number.
 *
 * The read is the houseguest's OWN: the caller passes the bond reader they see (`perceivedBondFor`, never the hidden edge of two others) and the public resume.
 */
export const ENDGAME = {
  /** The endgame begins at this many houseguests left (final four) and runs to the final HOH. */
  atOrBelow: 4,
  /** How hard "I can't beat them" pushes a vote or a nomination, per unit of odds below even (0.5). Signed: odds above even keep them. */
  beatWeight: 1.2,
  /** How far "I can't beat the one I'm reassuring" tilts the reassurance toward faking, per unit of odds below even (only ever adds). */
  fakeLean: 0.8,
} as const;

export const isEndgame = (living: number): boolean => living > 2 && living <= ENDGAME.atOrBelow;

/**
 * `me`'s own estimate of their share of the jury's votes against `rival` at a final two (0..1, 0.5 = even). Each juror leans to whoever they are closer to as `me`
 * reads it, plus the comp record (each win of difference); with no jurors yet, the record alone decides.
 */
export function beatShare(
  me: EntityId, rival: EntityId, jurors: readonly EntityId[],
  bond: (juror: EntityId, finalist: EntityId) => number, resume: (id: EntityId) => number,
): number {
  const resumeTerm = (resume(me) - resume(rival)) * JURY_MINDS.estimate.resumePerWin;
  if (jurors.length === 0) return clamp01(0.5 + resumeTerm);
  let sum = 0;
  for (const j of jurors) sum += clamp01(0.5 + (bond(j, me) - bond(j, rival)) + resumeTerm);
  return sum / jurors.length;
}

/** The push "can I beat you?" puts on evicting or nominating `rival` (+ = I can't beat them, so they go; - = I can, so keep them). */
export const endgamePush = (share: number): number => ENDGAME.beatWeight * (0.5 - share);

/** How much more likely a reassurance is to be faked when the one reassuring can't beat the one they reassure (0 when they can). */
export const endgameFakeLean = (share: number): number => ENDGAME.fakeLean * Math.max(0, 0.5 - share);

