import type { EntityId } from "../domain/ids";
import { RelationshipModel } from "./relationships";
import { blocFor, blocTerm } from "./blocs";
import type { Bloc } from "./blocs";
import { DECISION, NOMINATION_STYLES, NOMINATION_PRESSURE } from "./decisionConstants";
import type { NominationStyle } from "./decisionConstants";
import type { NominationTactic } from "./decisionConstants";
import type { RelationshipDisposition } from "./relationshipConstants";
import { RELATIONSHIP_CONSTANTS } from "./relationshipConstants";

/**
 * Shared season primitives (feature 0011). The weekly loop itself lives in `liveSeason.ts` — the
 * ONE rulebook the live game runs; the seed-deterministic calibration driver over it lives in
 * `calibration.ts` (B55/audit D12: the old parallel `playSeason` sim diverged in rules from the
 * game the player actually plays, so its duplicate decision helpers are gone). What remains here
 * are the pure, relationship-driven decision reads BOTH consume.
 */
export interface Stats {
  physical: number;
  mental: number;
  social: number;
}
export interface SeasonHouseguest {
  id: EntityId;
  stats: Stats;
}

/** Top-2 threats from the HOH's perspective — relationship-driven nominations. */
export function chooseNominations(hoh: EntityId, active: EntityId[], rel: RelationshipModel): [EntityId, EntityId] {
  const ranked = active.filter((h) => h !== hoh).sort((a, b) => rel.edge(hoh, b).threat - rel.edge(hoh, a).threat);
  return [ranked[0]!, ranked[1]!];
}

/** How hard a rattled HOH's paranoia bends the nomination read toward whoever they least trust.
 *  Re-homed into the 0044 constants module (the single tunable sibling of 0026/0028). */
export const NOMINATION_PARANOIA_WEIGHT = DECISION.nomination.paranoiaWeight;

/**
 * Mood-aware nominations: a CALM HOH ranks purely by threat; a RATTLED HOH (emotionalState < 0.5) adds a
 * bounded paranoia term over-weighting whoever they least trust — see `nominationStrategy(…, { mood })`,
 * the single live nomination function (0044). (The former standalone `chooseNominationsWithMood` was a
 * test-only duplicate of that mood path and was removed in the 2026-06-28 PO cleanup; call
 * `nominationStrategy` with a `mood` instead.)
 */

/**
 * The HOH's raw nomination leaning toward one target: threat + the rattled-paranoia term (0041).
 * Exposed so layered reads (the 0043 bloc term) can ADD to the same base instead of forking it.
 */
export function nominationScore(hoh: EntityId, target: EntityId, rel: RelationshipModel, mood: number): number {
  const paranoia = Math.max(0, (0.5 - mood) * 2); // 0 when calm … 1 when fully rattled
  return rel.edge(hoh, target).threat + paranoia * NOMINATION_PARANOIA_WEIGHT * (1 - rel.edge(hoh, target).trust);
}

/**
 * The week's POLITICAL TEMPERATURE (0044): how lopsided the house-wide threat distribution is.
 * Each houseguest's menace is the MEAN threat the rest of the house reads in them; the spread is
 * the gap between the scariest read and the median. A big gap ⇒ a runaway threat ⇒ a "hot" week
 * where every HOH plays direct; a flat distribution ⇒ a quiet week that frees the tactical games.
 */
export function politicalTemperature(active: readonly EntityId[], rel: RelationshipModel): { spread: number; runaway: boolean } {
  const menace = (id: EntityId): number => {
    const readers = active.filter((x) => x !== id);
    if (readers.length === 0) return 0;
    return readers.reduce((sum, r) => sum + rel.edge(r, id).threat, 0) / readers.length;
  };
  const reads = active.map(menace).sort((a, b) => a - b);
  if (reads.length === 0) return { spread: 0, runaway: false };
  // True median over the sorted reads: for an EVEN-length house, average the two central elements
  // (an upper-central pick — `reads[mid]` — biased `spread` DOWN, so `runaway` tripped slightly
  // less often than a real median would). Odd length keeps the single central element.
  const mid = Math.floor(reads.length / 2);
  const median = reads.length % 2 === 0 ? (reads[mid - 1]! + reads[mid]!) / 2 : reads[mid]!;
  const spread = reads[reads.length - 1]! - median;
  return { spread, runaway: spread > DECISION.nomination.runawaySpread };
}

/**
 * How much of a FLOATER a houseguest is (PO ruling 2026-11-02): 1 when nobody in the house holds a
 * bond toward them above the edge baseline, 0 once someone's bond reaches baseline +
 * `floaterBondSpan`. Hidden, engine-only — never crosses to the player.
 */
export function floaterRead(t: EntityId, active: readonly EntityId[], rel: RelationshipModel): number {
  const base = (RELATIONSHIP_CONSTANTS.baseline.trust + RELATIONSHIP_CONSTANTS.baseline.affinity) / 2;
  let maxBond = base;
  for (const o of active) if (o !== t) maxBond = Math.max(maxBond, rel.bondStrength(o, t));
  return Math.max(0, Math.min(1, 1 - (maxBond - base) / DECISION.nomination.floaterBondSpan));
}

/**
 * How locked-in a houseguest is with someone ELSE (PO ruling 2026-11-02, the "break up the duo" read):
 * the strongest MUTUAL bond they share with anyone but the HOH, 0 at the edge baseline → 1 at baseline
 * + `floaterBondSpan`. A tight pair is a threat to an outside HOH. Hidden, engine-only.
 */
export function duoRead(t: EntityId, hoh: EntityId, active: readonly EntityId[], rel: RelationshipModel): number {
  const base = (RELATIONSHIP_CONSTANTS.baseline.trust + RELATIONSHIP_CONSTANTS.baseline.affinity) / 2;
  let best = base;
  for (const o of active) if (o !== t && o !== hoh) best = Math.max(best, Math.min(rel.bondStrength(o, t), rel.bondStrength(t, o)));
  return Math.max(0, Math.min(1, (best - base) / DECISION.nomination.floaterBondSpan));
}

/** The target's tight-pair partner (mutual bond ≥ half the duo span above baseline), if any — not the HOH. */
export function duoPartner(t: EntityId, hoh: EntityId, active: readonly EntityId[], rel: RelationshipModel): EntityId | undefined {
  const base = (RELATIONSHIP_CONSTANTS.baseline.trust + RELATIONSHIP_CONSTANTS.baseline.affinity) / 2;
  let best: EntityId | undefined;
  let bestBond = base + DECISION.nomination.floaterBondSpan / 2;
  for (const o of active) {
    if (o === t || o === hoh) continue;
    const b = Math.min(rel.bondStrength(o, t), rel.bondStrength(t, o));
    if (b > bestBond) { bestBond = b; best = o; }
  }
  return best;
}

/** The signals the strategic nomination read consumes — all optional so it degrades to threat-only. */
export interface NominationRead {
  /** The house's current derived blocs (0043) — bloc-mates are shielded from the block. */
  blocs?: readonly Bloc[];
  /** The HOH's live soul emotional state (0041); rattled ⇒ the paranoia term bends the ranking. */
  mood?: number;
  /** The HOH's static disposition — gates WHICH tactic they play (a loyalist ≠ a schemer). */
  disposition?: RelationshipDisposition;
  /** The HOH's own nomination style (PO 2026-11-02) — weights the floater / duo reads. Absent ⇒ threat hunter. */
  style?: NominationStyle;
  /**
   * The HOH's stored TARGET from nominations (#1948) — `replacementPick` only. Present ⇒ the replacement
   * branches on that identity (target still up ⇒ new pawn; target saved, or a backdoor that kept them off
   * the block ⇒ new target) instead of inferring it from scores. Absent (a human HOH's nominations, a
   * pre-#1948 save) ⇒ the score inference, byte-identical to before.
   */
  target?: EntityId;
  /**
   * #1937 — the bounded, signed CAMPAIGN push on a houseguest as a nominee, from campaigns the HOH is AWARE of
   * (evict adds, protect subtracts; `campaignPushFor`). Added LAST to the strategic score, next to (never over)
   * the style terms. Absent ⇒ +0, byte-identical.
   */
  campaignPush?: (target: EntityId) => number;
  /**
   * 0024 — the bounded RESIDUAL memory tilt on a houseguest as a nominee: this HOH's own grudge toward them (a broken
   * deal, a trusted friend who nominated/replaced them) minus their favor (a veto save), net of what the relationship
   * edge still carries (`memoryTilt`). Added with the campaign push, last. Absent ⇒ +0, byte-identical.
   */
  memoryPush?: (target: EntityId) => number;
  /**
   * B3 / #2017 — the HOH's BELIEF that `target` is targeting them (`targets-me` claims; can be wrong), as a bounded nomination tilt. Reads claims only, never the edge. Absent ⇒ +0, byte-identical.
   */
  beliefPush?: (target: EntityId) => number;
  /** B7 M3 (ORWELL_DEAL_NOMS): the HOH's open PROTECTIVE deal (safety / final-two) with `target` lowers their nomination score (a bounded, negative push). Absent => +0, byte-identical. */
  dealPush?: (target: EntityId) => number;
  /** B4 slice 3 (ORWELL_ASSURANCES): the HOH holds a KEPT casual assurance toward `target` ("you're safe with me") - kept off the block while two legal others remain. Absent => byte-identical. */
  protectedByAssurance?: (target: EntityId) => boolean;
}

/** A nomination pair plus the HOH's actual TARGET (a backdoor leaves the target OFF the block). */
export interface NominationPlan { nominees: [EntityId, EntityId]; target: EntityId }

/**
 * Strategic nominations (feature 0044): the blended, archetype-gated read layered on the built
 * threat-primary ranking. Threat still dominates WHO the target is — but the PAIR reflects a
 * tactic: a loyalist sits a low-read PAWN beside the target; a schemer leaves the real target off
 * the block as a BACKDOOR plan (the veto bait goes up; the replacement read completes it); a hot
 * week (a runaway threat, `politicalTemperature`) forces everyone DIRECT. Bloc-mates are never
 * nominated while two legal others remain (0043). Deterministic: no rng — every input is a
 * computed hidden signal, so the same seed's signals yield the same pair (anti-sycophancy: the
 * engine decides, the narrator only voices it). Legality (0005) still binds downstream.
 */
export function nominationStrategy(
  hoh: EntityId, active: EntityId[], rel: RelationshipModel, read: NominationRead = {},
): [EntityId, EntityId] {
  return nominationPlan(hoh, active, rel, read).nominees;
}

/** `nominationStrategy` plus the HOH's TARGET identity (the top read — on the block unless a backdoor). */
export function nominationPlan(
  hoh: EntityId, active: EntityId[], rel: RelationshipModel, read: NominationRead = {},
): NominationPlan {
  const { blocs = [], mood = 0.5, disposition = "neutral", style = "threat-hunter" } = read;
  const S = NOMINATION_STYLES[style];
  const P = NOMINATION_PRESSURE;
  const W = { floaterWeight: S.floaterWeight * P, pawnSeatFloaterBonus: S.pawnSeatFloaterBonus * P, duoWeight: S.duoWeight * P, duoPartnerBonus: S.duoPartnerBonus * P };
  let cands = active.filter((h) => h !== hoh);
  // Bloc protection (0043): keep bloc-mates off the block entirely while two legal others remain.
  const mates = blocFor(blocs, hoh)?.members ?? [];
  const nonMates = cands.filter((c) => !mates.includes(c));
  if (nonMates.length >= 2) cands = nonMates;
  if (read.protectedByAssurance) { const free = cands.filter((c) => !read.protectedByAssurance!(c)); if (free.length >= 2) cands = free; } // B4: a kept assurance shields the assured
  const N = DECISION.nomination;
  const score = (t: EntityId): number =>
    nominationScore(hoh, t, rel, mood) + blocTerm(blocs, hoh, t) + W.floaterWeight * floaterRead(t, active, rel) +
    W.duoWeight * duoRead(t, hoh, active, rel) + (read.campaignPush?.(t) ?? 0) + (read.memoryPush?.(t) ?? 0) + (read.beliefPush?.(t) ?? 0) + (read.dealPush?.(t) ?? 0);
  const ranked = [...cands].sort((a, b) => score(b) - score(a));
  const tactic: NominationTactic = politicalTemperature(active, rel).runaway
    ? "direct" // a runaway threat ends the tactical games — the house moves on them now
    : DECISION.nomination.tacticFor[disposition];
  if (tactic === "backdoor" && ranked.length >= 3) return { nominees: [ranked[1]!, ranked[2]!], target: ranked[0]! };
  if (tactic === "pawn" && ranked.length >= 3) {
    // The pawn is the biggest FLOATER (nobody fights for them); ties keep the lowest-ranked read.
    const pool = ranked.slice(1).reverse();
    const pawn = pool.reduce((best, c) => (floaterRead(c, active, rel) > floaterRead(best, active, rel) ? c : best), pool[0]!);
    return { nominees: [ranked[0]!, pawn], target: ranked[0]! };
  }
  // The SECOND seat is where pawns come from (PO ruling 2026-11-02, "pawns go home"): the HOH pairs
  // the target with whoever is cheapest to put up — the next read, pulled further toward a floater.
  const rest = ranked.slice(1);
  // Break up the duo (PO 2026-11-02): when the target is locked in a tight pair, the HOH puts the
  // PARTNER up beside them — one of the two goes home unless the veto saves them.
  const partner = duoPartner(ranked[0]!, hoh, active, rel);
  const seat2 = (c: EntityId): number =>
    score(c) + W.pawnSeatFloaterBonus * floaterRead(c, active, rel) + (c === partner ? W.duoPartnerBonus : 0);
  const pawn = rest.reduce((best, c) => (seat2(c) > seat2(best) ? c : best), rest[0]!);
  return { nominees: [ranked[0]!, pawn], target: ranked[0]! };
}

/**
 * The HOH's REPLACEMENT nominee after a veto (0044 §9, PO 2026-11-02). Two cases, read from the HOH's own
 * strategic score: if the houseguest still on the block is the HOH's TARGET (the pawn came down), the
 * replacement is a new PAWN — the same pawn-seat read as nominations (floater / duo-partner pull, by the
 * HOH's style); if the target was saved (or this is a backdoor), the replacement is the new TARGET — the
 * top strategic read among the legal options. Deterministic; legality is the caller's (`options`).
 */
export function replacementPick(
  hoh: EntityId, remaining: EntityId, options: readonly EntityId[], active: EntityId[], rel: RelationshipModel,
  read: NominationRead = {},
): EntityId {
  const { blocs = [], mood = 0.5, style = "threat-hunter", target } = read;
  const S = NOMINATION_STYLES[style];
  const P = NOMINATION_PRESSURE;
  const score = (t: EntityId): number =>
    nominationScore(hoh, t, rel, mood) + blocTerm(blocs, hoh, t) +
    S.floaterWeight * P * floaterRead(t, active, rel) + S.duoWeight * P * duoRead(t, hoh, active, rel) +
    (read.campaignPush?.(t) ?? 0) + (read.memoryPush?.(t) ?? 0) + (read.beliefPush?.(t) ?? 0) + (read.dealPush?.(t) ?? 0);
  const ranked = [...options].sort((a, b) => score(b) - score(a));
  // #1948: branch on the HOH's stored target when we have it; otherwise infer it from the scores (legacy).
  const targetStillUp = target !== undefined ? remaining === target : score(remaining) >= score(ranked[0]!);
  if (!targetStillUp && target === undefined) return ranked[0]!; // legacy no-stored-target inference: unchanged (a human HOH's nominations, an old save)
  if (!targetStillUp) {
    // #1971: the HOH is naming the REAL target again, so rank by the target-oriented read (threat + bloc + mood + the
    // campaign/memory pushes) WITHOUT the pawn-seat floater/duo pull — a pawn or duo partner must not outrank the HOH's top read.
    const targetScore = (t: EntityId): number =>
      nominationScore(hoh, t, rel, mood) + blocTerm(blocs, hoh, t) + (read.campaignPush?.(t) ?? 0) + (read.memoryPush?.(t) ?? 0) + (read.beliefPush?.(t) ?? 0) + (read.dealPush?.(t) ?? 0);
    return [...options].reduce((best, c) => (targetScore(c) > targetScore(best) ? c : best), options[0]!);
  }
  const partner = duoPartner(remaining, hoh, active, rel);
  const pawnScore = (c: EntityId): number =>
    score(c) + S.pawnSeatFloaterBonus * P * floaterRead(c, active, rel) + (c === partner ? S.duoPartnerBonus * P : 0);
  return ranked.reduce((best, c) => (pawnScore(c) > pawnScore(best) ? c : best), ranked[0]!);
}

/** Tally a jury vote: most votes wins; a tie is broken by the last-evicted juror. */
export function tallyJury(
  jurors: EntityId[],
  finalTwo: [EntityId, EntityId],
  votesFor: (juror: EntityId) => EntityId,
  juryEvictionOrder: EntityId[],
): EntityId {
  const tally: Record<EntityId, number> = { [finalTwo[0]]: 0, [finalTwo[1]]: 0 };
  for (const j of jurors) tally[votesFor(j)] = (tally[votesFor(j)] ?? 0) + 1;
  if (tally[finalTwo[0]]! > tally[finalTwo[1]]!) return finalTwo[0];
  if (tally[finalTwo[1]]! > tally[finalTwo[0]]!) return finalTwo[1];
  const lastJuror = [...juryEvictionOrder].reverse().find((e) => jurors.includes(e))!;
  return votesFor(lastJuror);
}
