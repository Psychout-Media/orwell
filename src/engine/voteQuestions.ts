import type { EntityId } from "../domain/ids";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { deduceEvictionVoters, deductionSeed, type DeductionRead } from "./voteDeduction";

/**
 * ORW-342 (theme 1, Ryne 2026-11-12: example week goals include "find out who flipped"; spec 0145 week goal `find-out`, success test `question-answered`).
 * After each eviction vote, a houseguest who was nominated and SURVIVED a vote against them, or who voted with the MINORITY, is left with an open question:
 * "who voted against me / who flipped". Its suspect is that houseguest's OWN deduced read (0110: the public vote count, the eligible voters and their own reads of them),
 * which can be wrong. NEVER the sealed ballot: the true `voteOf` is read here only for PUBLIC facts (how many votes each nominee drew, who the eventual evictee was) and
 * for nothing about who voted for whom beyond the voter's own vote (the voter knows how they voted). PURE + engine-only (Vault-class); no rng beyond the dedicated deduction seed.
 */
export interface VoteQuestion {
  holder: EntityId;
  /** Stable id: one question per holder per eviction week. */
  ref: string;
  week: number;
  /** The holder's own most-suspected houseguest, from their deduction. */
  suspect?: EntityId;
  /** What the deduction was run over, kept so "has it become confident?" can be asked again as the holder's reads move. */
  pool: EntityId[];
  count: number;
}

/** A deduction at least this confident (0..1, the 0110 margin read) counts as the question answered. */
export const QUESTION_ANSWERED_CONFIDENCE = 0.8;

/** A question is live through the week after the vote and lapses at that week's close (its goal is a week goal, which the agenda expires itself). */
export const questionLive = (q: VoteQuestion, week: number): boolean => week - q.week <= 1;

/** Re-ask the holder's own deduction (their reads have moved since): is the answer now confident? Deterministic: the same dedicated seed as at the vote. */
export function questionAnswered(q: VoteQuestion, rel: DeductionRead): boolean {
  if (q.pool.length === 0) return false;
  return deduceEvictionVoters(q.holder, q.pool, q.count, rel, new SeededRandom(deductionSeed(q.holder, q.week))).confidence >= QUESTION_ANSWERED_CONFIDENCE;
}

export interface VoteFacts {
  week: number;
  evictee: EntityId;
  /** The nominees that week (the evictee and the survivor(s)). */
  nominees: readonly EntityId[];
  /** The ballots: used ONLY for the public vote count per nominee and a voter's own vote. */
  voteOf: Readonly<Record<EntityId, EntityId>>;
  player: EntityId;
}

/** The open questions this eviction vote leaves behind, for the NPCs (the player forms their own). */
export function questionsAfterVote(f: VoteFacts, rel: DeductionRead): VoteQuestion[] {
  const out: VoteQuestion[] = [];
  const voters = Object.keys(f.voteOf);
  const ask = (holder: EntityId, count: number): VoteQuestion => {
    const pool = voters.filter((v) => v !== holder);
    const d = deduceEvictionVoters(holder, pool, count, rel, new SeededRandom(deductionSeed(holder, f.week)));
    return { holder, ref: `vote:${f.week}:${holder}`, week: f.week, ...(d.believed[0] !== undefined ? { suspect: d.believed[0] } : {}), pool, count };
  };
  const seen = new Set<EntityId>();
  // a nominee who survived and drew votes against them (the count is public)
  for (const n of f.nominees) {
    if (n === f.evictee || n === f.player) continue;
    const against = Object.values(f.voteOf).filter((t) => t === n).length;
    if (against > 0) { out.push(ask(n, against)); seen.add(n); }
  }
  // a voter on the losing side: they wanted someone else out, so someone flipped (their own read picks one suspect)
  for (const v of voters.sort()) {
    if (v === f.player || seen.has(v) || f.voteOf[v] === f.evictee) continue;
    out.push(ask(v, 1));
  }
  return out;
}
