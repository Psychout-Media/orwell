/**
 * Features 0093 + 0099 — secrets as power. The PURE decision core (no I/O, no Vault handle): given
 * already-read, Vault-hidden signals (relationship edges + the secret's PUBLIC severity class + soul
 * state), it decides the bounded, seeded MAGNITUDE of using a held secret three ways — LEVERAGE on its
 * subject in a deal, EXPOSE it to the house, or TRADE it to a third-party recipient. Deception is
 * first-class: any use may be truthful or a BLUFF (a fabricated claim). The caller (the adapter) reads
 * the sealed state, validates the player owns the `factId`, and records the consequence; this module
 * only computes amounts. Seeded + deterministic (rng injected); pure ⇒ unit-testable in isolation.
 *
 * The anti-sycophancy spine (ADR 0005 / mandate #3): the model proposes only the SHAPE — which secret,
 * which target, the prose — and the ENGINE owns every magnitude here. No raw number ever crosses to the
 * player OR admin. The severity gloss reads ONLY the public `kind` of the secret, never its sealed text
 * (sibling to 0075's `teaseGloss`): no Vault content informs an amount — so a held secret can never be
 * *pumped* to force a yes or flatten a rival. The ceiling is real-but-recoverable, never deterministic.
 */
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { HiddenElementKind } from "./characterFactory";
import type { EdgeSignals } from "./relationshipConstants";
import { scaleImpact } from "./relationshipConstants";
import { LEVERAGE, SECRET_TRADE } from "./leverageConstants";
import { clamp01Raw as clamp01 } from "../domain/num";

/** A signed, bounded per-moment jitter in [−band, +band] — one rng draw (the temperature seam). */
function jitter(rng: RandomnessSource, band: number): number {
  return (rng.next() - 0.5) * 2 * band;
}

/**
 * The PUBLIC severity of a secret ∈ [0,1] from its `kind` ONLY (never its sealed text). A `trigger`
 * never reaches a usable-secret path (it erupts, it is never learned), so it falls through to the
 * default. A null/unknown kind (a surfaced rumor with no class) reads at the default. Pure read.
 */
export function severityOf(kind: HiddenElementKind | undefined): number {
  if (kind === undefined || kind === "trigger") return LEVERAGE.defaultSeverity;
  return LEVERAGE.severityByKind[kind] ?? LEVERAGE.defaultSeverity;
}

// ── 0093: leverage (pressure on the SUBJECT) ───────────────────────────────────────────────────────

/** The already-read signals leverageStrength is computed from (the adapter fills these; all Vault-hidden). */
export interface LeverageSignals {
  /** The secret's PUBLIC severity (from `severityOf` — its kind, never its text). */
  severity: number;
  /** The subject's soul emotionalState ∈ [0,1] — higher = steadier; vulnerability is 1 − this. */
  subjectEmotionalState: number;
  /** The subject's read of the PLAYER: trust/affinity (warmth) vs. threat (wariness). */
  subjectTrust: number;
  subjectAffinity: number;
  subjectThreat: number;
}

/**
 * leverageStrength ∈ [0,1] (0093) — how much pressure a held secret puts on its SUBJECT, seeded. Reads
 * the secret's severity, the subject's vulnerability (a rattled houseguest folds easier), and the
 * subject's RECEPTIVENESS (their warmth toward the player minus their wariness — a houseguest who
 * already distrusts the player resists the squeeze). Bounded + jittered: a near-tie wobbles, a clear
 * read does not flip. NEVER deterministic — the deal it colors can always be refused (see `dealFactor`).
 */
export function leverageStrength(s: LeverageSignals, rng: RandomnessSource): number {
  const vulnerability = 1 - s.subjectEmotionalState;
  const receptiveness = clamp01((s.subjectTrust + s.subjectAffinity) / 2 - s.subjectThreat + 0.5); // centered
  const raw =
    LEVERAGE.severityWeight * s.severity +
    LEVERAGE.vulnerabilityWeight * vulnerability +
    LEVERAGE.receptivenessWeight * receptiveness;
  return clamp01(raw + jitter(rng, LEVERAGE.jitter));
}

/**
 * The bounded deal-acceptance read AFTER a secret colors it (0093/0099 share this). The pre-offer base
 * is read off the houseguest's SIGNED warmth toward the player ∈ [−1,1] ((trust+affinity)/2 − threat):
 * a hostile (high-threat, low-warmth) houseguest starts NEGATIVE, so the CAPPED secret boost can lift
 * them but never to certainty — a wary subject can still land below `refusalFloor` and REFUSE (the
 * leverage is pressure, never an "I win" button — the recoverable ceiling, owner R1). The engine owns
 * the amount — the model never proposes it.
 */
export function dealAcceptance(signedWarmth: number, boost: number, refusalFloor: number): { accepts: boolean; read: number } {
  // Map signed warmth [−1,1] → a [0,1] base centered at 0.5, scaled by the warmth weight, so a neutral
  // houseguest sits mid-band, a hostile one well below the floor, a warm one above it. Then add the boost.
  const base = clamp01(0.5 + signedWarmth * LEVERAGE.baseAcceptanceFromWarmth) - (1 - LEVERAGE.baseAcceptanceFromWarmth) * Math.max(0, -signedWarmth);
  const read = clamp01(base + boost);
  return { accepts: read >= refusalFloor, read };
}

/** The CAPPED additive boost a leverage strength contributes to a deal-acceptance read (bounded). */
export function leverageDealBoost(strength: number): number {
  return clamp01(strength) * LEVERAGE.dealFactorCap;
}

// ── 0093: expose (out the secret to the house) ─────────────────────────────────────────────────────

export interface ExposeFolds {
  /** The bounded standing hit applied to EACH other houseguest's read of the exposed subject. */
  subjectHit: Partial<EdgeSignals>;
  /** The betrayal-grade hit the SUBJECT takes toward the exposer (the deepest wound). */
  exposerBacklashFromSubject: Partial<EdgeSignals>;
  /** The smaller signed recoil the rest of the house takes toward the exposer (ruthlessness read). */
  exposerBacklashFromHouse: Partial<EdgeSignals>;
  /** Whether a jury-management mark is laid on the subject's eventual jurors. */
  juryMark: boolean;
}

/**
 * exposeOutcome (0093) — the bounded, seeded standing resolution of outing a learned secret. A REAL but
 * RECOVERABLE hit (owner R1): the subject-hit scales by the secret's severity within a seeded band, so a
 * juicier secret lands harder but never game-ending; the exposer takes a betrayal-grade hit from the
 * subject plus a smaller recoil from the house. One rng draw (the band scale). The adapter applies these
 * folds through the 0026 rule + records the exposure as a witnessed pathway event.
 */
export function exposeOutcome(severity: number, rng: RandomnessSource): ExposeFolds {
  const band = LEVERAGE.exposeSubjectHitBand;
  const scale = band.min + (band.max - band.min) * rng.next(); // seeded within [min,max]
  // Severity shades the magnitude (a sharper secret cuts deeper) — still bounded by the band's ceiling.
  const floor = LEVERAGE.severityShadeFloor;
  const sevScaled = scale * (floor + (1 - floor) * clamp01(severity));
  return {
    subjectHit: scaleImpact(LEVERAGE.exposeSubjectHit, sevScaled),
    exposerBacklashFromSubject: { ...LEVERAGE.exposerBacklashFromSubject },
    exposerBacklashFromHouse: { ...LEVERAGE.exposerBacklashFromHouse },
    juryMark: LEVERAGE.exposeLaysJuryMark,
  };
}

// ── 0099: trade (hand the secret to a third-party RECIPIENT) ───────────────────────────────────────

/** The already-read signals tradeValue is computed from (the RECIPIENT's reads — never the subject's). */
export interface TradeSignals {
  /** The secret's PUBLIC severity. */
  severity: number;
  /** The RECIPIENT's directed edge toward the SECRET'S SUBJECT — do they want leverage on them? */
  recipientThreatOfSubject: number;
  recipientAffinityForSubject: number;
  /** The RECIPIENT's read of the PLAYER (the source): a distrusted source's offer is discounted. */
  recipientTrustOfPlayer: number;
}

/**
 * tradeValue ∈ [0,1] (0099) — how much the RECIPIENT values this secret, seeded. The crux that
 * distinguishes a trade from leverage: the value is the recipient's — what THEY would do with it. A
 * secret about a rival the recipient FEARS (high threat, low affinity toward the subject) is worth a
 * lot; a secret about the recipient's ALLY is near-worthless. Discounted by the recipient's distrust of
 * the player. Bounded + jittered. NEVER deterministic — the recipient can always refuse (`dealAcceptance`).
 */
export function tradeValue(s: TradeSignals, rng: RandomnessSource): number {
  // Interest = the recipient WANTS leverage on the subject: their wariness of the subject minus their warmth.
  const interest = clamp01(s.recipientThreatOfSubject - s.recipientAffinityForSubject + 0.25);
  const raw =
    SECRET_TRADE.severityWeight * s.severity +
    SECRET_TRADE.recipientInterestWeight * interest +
    SECRET_TRADE.sourceTrustWeight * s.recipientTrustOfPlayer;
  return clamp01(raw + jitter(rng, SECRET_TRADE.jitter));
}

/** The CAPPED additive boost a tradeValue contributes to the recipient's deal-acceptance read (bounded). */
export function tradeDealBoost(value: number): number {
  return clamp01(value) * SECRET_TRADE.dealFactorCap;
}

export interface TradeFolds {
  accepted: boolean;
  /** The value read (bounded) — engine-internal; the adapter never crosses it to the player. */
  value: number;
  /** The bounded warm/owe fold the recipient registers toward the giver when they take the trade. */
  recipientFold?: Partial<EdgeSignals>;
  /** A bounded sour on the recipient's read of the trader when the trade is refused (peddling reads as untrustworthy). */
  traderBacklash?: Partial<EdgeSignals>;
}

/**
 * tradeOutcome (0099) — whether the recipient takes the trade + the relationship fold it produces. The
 * value colors the recipient's acceptance read (bounded boost off their warmth toward the player); a
 * valued, accepted trade WARMS the recipient toward the giver (they owe them); a refused trade (the
 * secret was worthless / the source distrusted) sours the recipient's read a bounded amount. Seeded.
 */
export function tradeOutcome(value: number, recipientWarmthToPlayer: number, rng: RandomnessSource): TradeFolds {
  const { accepts, read } = dealAcceptance(recipientWarmthToPlayer, tradeDealBoost(value), SECRET_TRADE.refusalFloor);
  // A second seeded draw decides the close on a near-floor read (so a marginal trade genuinely wobbles).
  const closed = accepts && (read >= SECRET_TRADE.refusalFloor + SECRET_TRADE.closeMargin || rng.next() < read);
  if (closed) return { accepted: true, value, recipientFold: { ...SECRET_TRADE.recipientFold } };
  return { accepted: false, value, traderBacklash: { ...SECRET_TRADE.traderBacklash } };
}

// ── 0099 hidden half: the off-screen NPC↔NPC barter (a DRIVER of 0038/0094 diffusion) ──────────────

export interface BarterCandidate {
  recipient: string;
  /** The recipient's reads, as `tradeValue` needs them. */
  signals: TradeSignals;
}

export interface BarterMove {
  recipient: string;
  /** The bounded hidden bond fold the recipient registers toward the giver. */
  bondFold: Partial<EdgeSignals>;
  value: number;
}

/**
 * npcBarterStep (0099 hidden half) — the perspective-bound, seeded choice of whether a holder SPENDS a
 * held fact with one of `candidates` to firm a bond. Picks the recipient who values it MOST (over the
 * floor), gated by a seeded rate roll. Returns the chosen move (the adapter writes the Vault-only
 * transfer + bond), or `undefined` (no barter this step). Rides the dedicated side-rng ⇒ byte-identical
 * when the off-screen flag is off. This is a DRIVER of the existing diffusion (motive + price), not a
 * second diffusion engine.
 */
export function npcBarterStep(candidates: readonly BarterCandidate[], rng: RandomnessSource): BarterMove | undefined {
  // Rate roll FIRST (one draw) so the side-rng advances identically whether or not a candidate qualifies.
  const fires = rng.next() < SECRET_TRADE.barterRate;
  let best: BarterCandidate | undefined;
  let bestValue: number = SECRET_TRADE.barterValueFloor;
  for (const c of candidates) {
    const v = tradeValue(c.signals, rng); // one draw per candidate (deterministic order)
    if (v > bestValue) { bestValue = v; best = c; }
  }
  if (!fires || !best) return undefined;
  return { recipient: best.recipient, bondFold: { ...SECRET_TRADE.barterBondFold }, value: bestValue };
}

// ── deception (owner direction 2026-06-27): any use may be a BLUFF ─────────────────────────────────

/**
 * Whether a BLUFF (a fabricated claim, reading NOTHING from the Vault) is BELIEVED by its target — folds
 * on BELIEF, not truth. Believed when (target's trust in the player × plausibility) clears the floor.
 * Plausibility leans on the target's OWN threat read of the named subject: a claim about a rival the
 * target already fears lands; a claim about their trusted ally bounces. The engine NEVER tells the
 * player whether the bluff happened to match a real truth (the bright line — a bluff reads no Vault).
 * Seeded. A believed bluff folds the SAME shape as the real lever; the passive lie-catch (the adapter)
 * is what later punishes a caught bluffer.
 */
export function bluffBelieved(trustInSource: number, targetThreatOfSubject: number, rng: RandomnessSource): boolean {
  const plausibility = clamp01(0.5 + LEVERAGE.bluffPlausibilityWeight * (targetThreatOfSubject - 0.5));
  const belief = clamp01(trustInSource) * plausibility;
  return belief >= LEVERAGE.bluffBeliefFloor && rng.next() < belief;
}

/** The kinds a usable secret can be (a trigger never reaches here — it erupts, it is never learned). */
export type UsableSecretKind = Exclude<HiddenElementKind, "trigger">;
