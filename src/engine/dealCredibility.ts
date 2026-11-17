import type { EntityId } from "../domain/ids";
import { ASSURANCE } from "./assurances";
import { breakSeverityScale, type Deal } from "./deals";
import { clamp01Raw as clamp01 } from "../domain/num";

/**
 * ORW-545 - A BROKEN DEAL COSTS THE BREAKER CREDIBILITY (pure: no I/O, no rng, no Vault, no clock). A broken formal deal counts against the breaker the way a caught lie does: the houseguest it was
 * broken to (and, at the existing witness factor, the houseguests who watched it made) holds a `lied-to-me` claim about the breaker, which `credibility()` (B48) already reads. This module only DECIDES
 * the claim: its id (one claim per deal per holder, so the same break counted twice is counted once) and its confidence (the severity credibility weighs). A kept deal writes nothing; nothing here can
 * RAISE credibility. No new belief kind, no new scale.
 */
export const DEAL_BREAK_CREDIBILITY = {
  /** The wronged party's confidence the breaker lied (same weight as a broken casual assurance): scaled by how much of the deal's term was left. */
  wrongedConfidence: 0.8,
  /** A witness of the break weighs it at this share of the wronged party's weight (the existing assurance witness factor). */
  witnessFactor: ASSURANCE.witnessFactor,
} as const;

/** One claim per (holder, breaker, deal): `recordClaim` keeps the first and never double-counts a repeat. */
export function brokenDealClaimId(holder: EntityId, breaker: EntityId, deal: Pick<Deal, "id">): string {
  return `${holder}|lied-to-me|${breaker}|deal:${deal.id}`;
}

/** 0..1 severity credibility will weigh for this break, by deal kind/term (`breakSeverityScale`: a vague deal softens, a long remaining term sharpens) and the holder's role. */
export function brokenDealLieConfidence(deal: Deal, currentWeek: number | undefined, role: "wronged" | "witness"): number {
  const base = DEAL_BREAK_CREDIBILITY.wrongedConfidence * breakSeverityScale(deal, currentWeek);
  return clamp01(role === "witness" ? base * DEAL_BREAK_CREDIBILITY.witnessFactor : base);
}
