import type { EntityId } from "../domain/ids";
import { claimsOf, type BeliefStore } from "./beliefStore";

/**
 * B48 / #2017 section 14.5(3) READ side - CREDIBILITY MEMORY (behind `ORWELL_CREDIBILITY_MEMORY`, default OFF, never-flipped).
 *
 * The belief store already records, per holder, `lied-to-me` (a lie the holder caught - B23, the B4 broken assurance) and `assured-me` (a promise the holder believes). Until now NO decision read
 * either. This is the pure rule that turns them into one signed, bounded, deterministic tilt: `credibilityTilt(store, holder, subject, week, ...)` is how much LESS `holder` believes `subject`
 * (+ = act against them, so a vote/nomination leans toward them, a veto save/Houseguest's Choice pick leans away). It is the LIAR's cost, whoever the liar is (the player or an NPC); the holder is
 * always an NPC (the player's hidden read drives nothing).
 *
 * Shape (limits come from consequences, not counts - the PO direction): every live (un-refuted, believed-true) caught lie contributes `confidence x 0.5^(age/halfLife) x perLie x sting`, stacked with
 * diminishing returns (`1 - prod(1 - w)`), so each further lie costs more but a habitual liar saturates at `max` rather than growing without bound. `sting` is the RELATIONSHIP scale (the closer the
 * holder trusted the liar, the more it hurts) and `decayScale` is the PERSONALITY scale (a grudge-holder forgets a lie slower than a forgiving loyalist - the same disposition factor the memory ledger
 * uses). A believed `assured-me` claim pulls back a LITTLE (bounded by `assuredMax`), and never outweighs a caught lie. Pure: no rng, no I/O, no Vault handle, nothing numeric crosses to the player.
 */
export const CREDIBILITY = {
  /** Weeks for a caught lie's weight to halve (at neutral disposition). Slower than a stale rumor: a lie is a character fact. */
  halfLifeWeeks: 6,
  /** One fully-confident, fresh lie's share of `max` before the sting scale (diminishing when several stack). */
  perLie: 0.6,
  /** The MAX tilt any pile of caught lies adds (a notch above a grudge's cap, below the threat read). */
  max: 0.25,
  /** The relationship sting: `floor + span x trust(holder -> liar)`, so a cold acquaintance shrugs (x0.6) and a close friend is hurt most (x1.4). */
  stingFloor: 0.6,
  stingSpan: 0.8,
  /** One fully-confident, fresh believed assurance's share of `assuredMax`. */
  assuredPerClaim: 0.4,
  /** The MAX credit (a negative tilt) any pile of believed assurances gives; small by design - a promise is cheap, a caught lie is not. */
  assuredMax: 0.05,
} as const;

const fin = (x: number | undefined, fallback: number): number => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export interface CredibilityOpts {
  /** The holder's trust in the subject (their relationship edge), 0..1. Absent => neutral sting. */
  trust?: number;
  /** The holder's disposition decay factor (`dispositionFactors[..].decayScale`): >1 forgets faster, <1 holds on. Absent => 1. */
  decayScale?: number;
}

/** Signed credibility tilt of `holder` AGAINST `subject`: in `[-assuredMax, +max]`; 0 when nothing is on the books. */
export function credibilityTilt(store: BeliefStore | undefined, holder: EntityId, subject: EntityId, week: number, opts: CredibilityOpts = {}): number {
  const decayScale = Math.max(0.01, fin(opts.decayScale, 1));
  const trust = clamp01(fin(opts.trust, 0.5));
  const sting = CREDIBILITY.stingFloor + CREDIBILITY.stingSpan * trust;
  let lieKeep = 1;
  let assuredKeep = 1;
  for (const c of claimsOf(store, holder)) {
    if (c.subject !== subject || c.refuted || !c.value) continue;
    if (c.kind !== "lied-to-me" && c.kind !== "assured-me") continue;
    const age = Math.max(0, fin(week, 0) - fin(c.week, 0)) * decayScale;
    const w = clamp01(fin(c.confidence, 0)) * Math.pow(0.5, age / CREDIBILITY.halfLifeWeeks);
    if (c.kind === "lied-to-me") lieKeep *= 1 - Math.min(1, w * CREDIBILITY.perLie * sting);
    else assuredKeep *= 1 - Math.min(1, w * CREDIBILITY.assuredPerClaim);
  }
  const lied = CREDIBILITY.max * (1 - lieKeep);
  const assured = CREDIBILITY.assuredMax * (1 - assuredKeep);
  return Math.max(-CREDIBILITY.assuredMax, Math.min(CREDIBILITY.max, lied - assured));
}
