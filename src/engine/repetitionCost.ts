import type { EdgeSignals } from "./relationshipConstants";
import { scaleImpact } from "./relationshipConstants";
import { NO_HARD_CAPS } from "./noHardCapsConstants";

/**
 * B49 - the pure REPETITION COST that replaces the hard per-season counts when `ORWELL_NO_HARD_CAPS` is on. No rng, no I/O, no Vault handle; nothing numeric ever crosses to the player.
 */
const fin = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);

/** The extra-cost multiplier for the next use, given how many times the same actor already used it this season: 0 for the first use, rising linearly, saturating at `repetitionMax`. */
export function repetitionFactor(priorUses: number): number {
  const n = Math.max(0, Math.floor(fin(priorUses, 0)));
  return Math.min(NO_HARD_CAPS.repetitionMax, n * NO_HARD_CAPS.repetitionPerUse);
}

/** The recipient scale in `[floor, floor + span]`: how much a repeat stings THIS holder, by how much they trusted the actor. */
export function recipientSting(trust: number): number {
  const t = Math.max(0, Math.min(1, fin(trust, 0.5)));
  return NO_HARD_CAPS.recipientStingFloor + NO_HARD_CAPS.recipientStingSpan * t;
}

/** The extra edge impact the `priorUses`-th repeat costs with a holder who trusted the actor by `recipientTrust`: the base backlash scaled by repetition x recipient. Empty on the first use. */
export function repetitionImpact(base: Partial<EdgeSignals>, priorUses: number, recipientTrust: number): Partial<EdgeSignals> {
  const f = repetitionFactor(priorUses);
  return f > 0 ? scaleImpact(base, f * recipientSting(recipientTrust)) : {};
}

/** The scale on an NPC's confide-lie roll after it has already lied `priorLies` times this season: 1 for a fresh liar, shrinking but floored (frequency, not a count). */
export function lieProbScale(priorLies: number): number {
  const n = Math.max(0, Math.floor(fin(priorLies, 0)));
  return Math.max(NO_HARD_CAPS.lieRepeatFloor, Math.pow(NO_HARD_CAPS.lieRepeatDecay, n));
}
