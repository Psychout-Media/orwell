import type { ConfidenceDecision } from "./confidence";
import type { DisclosureTier } from "./confidenceConstants";
import { disclosureMotive, type ConfidenceSignals } from "./confidence";
import { disclosureDecision, type Disclosure } from "./disclosure";
import { CUNNING, LEAKY } from "./copresenceSpread";
import type { StrategyStyle } from "./characterFactory";

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

/**
 * B33 / D1 - the REAL routing. A played game's confide press and 0092 drip delivery ask `disclosureDecision` (the one holder's-choice authority, #2135) whether the holder shares, slips or holds.
 * The NPC-side inputs are the same Vault-hidden reads the live code already has (the edges, goodwill, the PUBLIC strategy style, the soul's volatility, who is in earshot); the press is the
 * recorded fact that the lever was called (`pressure`), NEVER the wording. `roll` is ONE draw from a dedicated per-(npc, week, phase) side stream the caller derives, so repeated presses in one beat
 * reach the same decision and the shared sim rng is never touched. Pure; no rng handle, no Vault.
 */
export interface RouteCtx {
  signals: ConfidenceSignals;
  style?: StrategyStyle;
  /** The holder's soul volatility 0..1 (absent => 0.3). */
  volatility?: number;
  /** Awake others in earshot besides holder and listener. */
  audience: number;
  /** 0..1 - a recorded press (confide lever = 1, an unprompted drip = 0.5). */
  pressure: number;
  /** Cost of telling (a pressed confidence about oneself ~0.3; a ripe drip ~0.2). */
  risk: number;
  roll: number;
}

export function routeDisclosure(c: RouteCtx): Disclosure {
  const vol = c.volatility ?? 0.3;
  return disclosureDecision({
    motive: disclosureMotive(c.signals),
    holderTrustsListener: c.signals.npcTrust, listenerTrustsHolder: c.signals.playerTrust,
    risk: c.risk, audience: Math.max(0, c.audience), pressure: c.pressure,
    leakiness: (c.style ? LEAKY[c.style] ?? 0.3 : 0.3) + 0.2 * vol,
    cunning: c.style ? CUNNING[c.style] ?? 0.3 : 0.3, rattled: Math.max(0, vol - 0.5) * 2, roll: c.roll,
  }).decision;
}

/** Apply the routed decision to an already-eligible confide result: share => confirm (unchanged); slip => confirm, recorded as a `slip`; hold => the press is deflected. */
export function routeConfide(d: ConfidenceDecision, route: Disclosure): { decision: ConfidenceDecision; event: DisclosureEvent } {
  if (!d.disclosed) return { decision: d, event: confideToDisclosure(d) };
  if (route === "hold") return { decision: { disclosed: false, tier: "none", truthful: true }, event: { outcome: "deflect", via: "confide", truthful: true } };
  const event = confideToDisclosure(d);
  return { decision: d, event: route === "slip" ? { ...event, outcome: "slip" } : event };
}
