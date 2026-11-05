import type { ConfidenceDecision } from "./confidence";
import type { DisclosureTier } from "./confidenceConstants";

/**
 * B33 (design 16.5 D1, "lite") - the ONE closed-set vocabulary for what an NPC did about telling the player something THIS beat: `confirm` (a pressed confidence was given, true or a lie), `slip` (the 0092 drip /
 * a confidant slip delivered something unprompted), `deflect` (a live press the engine declined). `confideToDisclosure` maps today's `decideConfidence` result into it WITHOUT changing the decision (so every
 * existing tier is byte-identical); the 0092 drip keeps its own thread-ranking decision and is RECORDED here as a `slip`. The adapter keeps the latest event per NPC for the current beat only (memory, not
 * persisted) so A52's `npcVoice.disclosable` can hand the narrator exactly what the engine rolled, and nothing it did not. Pure; no rng, no Vault.
 */
export type DisclosureOutcome = "confirm" | "slip" | "deflect";

export interface DisclosureEvent {
  outcome: DisclosureOutcome;
  /** Which engine path produced it. */
  via: "confide" | "drip";
  /** The tier a confirmed confidence reached (absent for slip / deflect). */
  tier?: DisclosureTier;
  /** false => the engine knows it was a lie (never shown to the player). */
  truthful: boolean;
}

/** Map a confide decision onto the closed set. disclosed => confirm (with its tier + truthfulness); not disclosed => deflect. The decision itself is untouched. */
export function confideToDisclosure(d: ConfidenceDecision): DisclosureEvent {
  return d.disclosed
    ? { outcome: "confirm", via: "confide", tier: d.tier, truthful: d.truthful }
    : { outcome: "deflect", via: "confide", truthful: true };
}

/** The 0092 drip / confidant slip delivering something unprompted. */
export function dripToDisclosure(): DisclosureEvent {
  return { outcome: "slip", via: "drip", truthful: true };
}
