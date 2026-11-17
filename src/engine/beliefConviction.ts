import type { EntityId } from "../domain/ids";
import { agendaRoll } from "./agenda";
import { evidenceKey, type BeliefClaim } from "./beliefStore";

/**
 * Feature 0160 / ORW-330 - CONVICTION (Ryne's ruling on Theme 2 question 2, 2026-11-16: "how much that I believe it depends on how much
 * I act on it... If I don't believe it, then maybe I'm testing and I'm looking for evidence for or against it... it depends on the person,
 * how gullible they are, how open they are, how distrusting they are").
 *
 * A belief's `confidence` IS its conviction. It comes from the source (trust in the teller and corroboration, as before) scaled by the
 * holder's CREDULITY - their own sheet: disposition (clash = distrusting, bond = open), temperament drift (burned houseguests grow wary) and
 * archetype (calculating types question more), with a small fixed personal offset. Then:
 *  - conviction >= `asFact`: they act on it as a fact (full weight in decisions, `beliefDecisions.ts`);
 *  - a lower conviction on something that matters is TESTED: it becomes an open question (the agenda's find-out goal) and each night the
 *    evidence they have gathered THROUGH PATHWAYS (others telling them the same, or the opposite; catching the source lying) moves the conviction;
 *    with nothing new, the doubt fades - until it is a fact to them or they let it go (refuted). ORW-585: never the engine's hidden truth.
 * Pure rules: no I/O; the only randomness is the caller's seeded roll. ENGINE-ONLY.
 */
export const CONVICTION = {
  /** At or above this, a belief is acted on as fact. */
  asFact: 0.7,
  /** Below this the holder no longer believes it (the belief is refuted). */
  dropBelow: 0.15,
  /** How far one night's evidence moves a tested conviction. */
  step: 0.12,
  /** ORW-585: a doubt with no new evidence either way fades by this much a night (until it is let go). */
  fade: 0.03,
  /** Credulity's reach: a fully credulous holder takes a tale at (0.5 + 1) x, a fully suspicious one at 0.5 x. */
  credulityFloor: 0.5,
  /** How hard a houseguest pursues testing a doubted belief (the find-out goal's weight; a vote question's is 0.5). Tuned to the agreed house mix. */
  testDrive: 0.5,
  /**
   * Whether testing is VISIBLE: a doubted belief becomes a find-out goal (asking around: fish / test-a-rumor scenes). ON (Ryne 2026-11-16,
   * on the gossipier week 1 this makes: "is a gossipy house that big of a deal? I don't think it is"). Off = quiet testing: the evidence
   * still moves the conviction each night, with no asking-around scenes.
   */
  askAround: true,
  /** A small fixed personal offset, so two of the same type are not identical (+/- this). */
  personalSpread: 0.08,
} as const;

/** How readily a type takes a tale as true (archetype lean, -..+). */
const ARCHETYPE_LEAN: Readonly<Record<string, number>> = {
  mastermind: -0.12, analyst: -0.12, villain: -0.08, "comp-beast": -0.02, wildcard: 0,
  floater: 0.04, underdog: 0.04, flirt: 0.06, loyalist: 0.08, hothead: 0.08, "social-butterfly": 0.1, peacemaker: 0.1,
};
const DISPOSITION_LEAN: Readonly<Record<string, number>> = { clash: -0.15, neutral: 0, bond: 0.15 };

export interface CredulitySheet { archetype: string; disposition?: string; temperamentDrift?: number }

/** 0..1: how readily this houseguest believes what they are told (0.5 = takes a tale at its source's word). Deterministic per person. */
export function credulityOf(sheet: CredulitySheet, owner: EntityId, seed: number): number {
  const personal = (agendaRoll(seed, owner, "credulity") * 2 - 1) * CONVICTION.personalSpread;
  const drift = Math.max(-1, Math.min(1, sheet.temperamentDrift ?? 0)); // + toward clash-paranoia, - toward bond-trust
  const c = 0.5 + (ARCHETYPE_LEAN[sheet.archetype] ?? 0) + (DISPOSITION_LEAN[sheet.disposition ?? "neutral"] ?? 0) - 0.1 * drift + personal;
  return Math.max(0, Math.min(1, c));
}

/** The conviction a holder takes a told tale at: the source's confidence scaled by their credulity (0.5 = unchanged). */
export function convictionFor(sourceConfidence: number, credulity: number): number {
  const scale = CONVICTION.credulityFloor + Math.max(0, Math.min(1, credulity));
  return Math.max(0, Math.min(1, sourceConfidence * scale));
}

/** The belief kinds worth testing: the ones that move decisions (grievances) and the alliances a houseguest reads others by. */
const TESTABLE = new Set<BeliefClaim["kind"]>(["targets-me", "voted-against-me", "lied-to-me", "allied-with", "heard-rumor"]);

/** Is this belief one the holder is still testing? (Believed, not refuted, testable, below a fact.) */
export function underTest(b: BeliefClaim): boolean {
  return b.value && !b.refuted && TESTABLE.has(b.kind) && b.confidence < CONVICTION.asFact && b.confidence >= CONVICTION.dropBelow;
}

/** The open-question ref for testing a belief (the agenda's find-out goal answers it). */
export const testRef = (b: Pick<BeliefClaim, "id">): string => `belief:${b.id}`;

/**
 * ORW-585 (Fable T2): one night's evidence comes ONLY from what the holder has come to hold through pathways - never the engine's hidden truth (a sealed
 * ballot, a goal, the lie log). The holder weighs their OWN store:
 *  - support: other sources who told them the same thing (the same kind, subject and object, from a different source), each counted once;
 *  - against: what they were told that contradicts it (the same claim held as NOT so; for "voted against me", being told that person voted to keep them),
 *    and having caught the original source lying to them;
 *  - nothing either way: an unconfirmed doubt fades (`fade`), until they let it go.
 * Returns the night's change in conviction. Pure.
 */
export function pathwayEvidence(b: BeliefClaim, held: readonly BeliefClaim[], holder: EntityId): number {
  const same = (c: BeliefClaim) => c.id !== b.id && c.kind === b.kind && c.subject === b.subject && (c.object ?? null) === (b.object ?? null);
  const support = new Set(held.filter((c) => same(c) && c.value && !c.refuted && c.source !== undefined && c.source !== b.source).map((c) => c.source)).size;
  // ORW-591: a denial repeated by one source is one piece of evidence against, just as a repeat is one piece for (`evidenceKey`).
  const contradicts = new Set(held.filter((c) => !c.refuted && (
    (same(c) && !c.value)
    || (b.kind === "voted-against-me" && c.kind === "heard-rumor" && c.nature === "voted-to-keep" && c.subject === b.subject && c.object === holder && c.value)
  )).map(evidenceKey)).size;
  const sourceLied = b.source !== undefined && held.some((c) => c.kind === "lied-to-me" && c.subject === b.source && c.value && !c.refuted) ? 1 : 0;
  const net = support - contradicts - sourceLied;
  return net > 0 ? CONVICTION.step : net < 0 ? -CONVICTION.step : -CONVICTION.fade;
}

/** 0160 / Ryne's Q3 ruling ("Low trust in the person would create a low trust deal"): a deal is a claim, and it weighs as far as its holder
 *  trusts the other party - full at `DEAL_TRUST.full` trust or more, proportionally less below, nothing at no trust. */
export const DEAL_TRUST = { full: 0.5 } as const;
export function dealTrust(trustInOther: number): number {
  return Math.max(0, Math.min(1, trustInOther / DEAL_TRUST.full));
}
