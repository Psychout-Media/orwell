import type { EntityId } from "../domain/ids";

/**
 * #2017 slice S0a — the NPC belief store: DATA MODEL + PLUMBING ONLY. Behind `ORWELL_NPC_BELIEFS` (default OFF, pinned never-flipped).
 *
 * A `BeliefClaim` is one thing a houseguest (the `holder`) believes about the house — who moved against them, who is allied with whom, who holds
 * power — with where the belief came from and how sure the holder is. It is the typed index over what the knowledge layer already records
 * (0038 gossip diffusion, 0110 vote deduction), so decisions can LATER read beliefs instead of the engine's truth.
 *
 * This slice reads NOTHING: no nomination, vote, campaign or jury decision consults the store, so it cannot move any outcome. It also draws NO
 * randomness (claims are written from values the engine has already computed), so it is calibration-neutral whether ON or OFF; OFF it is never
 * created at all (byte-identical season state). ENGINE-ONLY: never projected to any outward surface, never placed in a narrator context —
 * a holder's false belief may only ever be voiced BY that holder, and never the truth it contradicts.
 */
export type ClaimKind = "voted-against-me" | "targets-me" | "allied-with" | "holds-power" | "will-vote" | "assured-me" | "lied-to-me";
export type ClaimOrigin = "witnessed" | "told" | "overheard" | "gossip" | "deduced" | "assured";

export interface BeliefClaim {
  /** Deterministic: `${holder}|${kind}|${subject}|${object ?? ""}|${week}` — recording the same claim twice is idempotent. */
  id: string;
  holder: EntityId;
  kind: ClaimKind;
  subject: EntityId;
  object?: EntityId;
  /** The claimed truth value (a belief can be wrong). */
  value: boolean;
  origin: ClaimOrigin;
  /** Who it came from, when it came from someone (the teller / the gossip source). */
  source?: EntityId;
  /** 0..1 — how sure the holder is. */
  confidence: number;
  week: number;
}

/** holder -> that holder's claims, oldest first. Engine-only season state (rides on `LiveSeasonState.beliefs`). */
export type BeliefStore = Record<EntityId, BeliefClaim[]>;

/** Per-holder bound so a long season cannot grow without limit. Compaction drops the OLDEST, LOWEST-confidence claim first and is deterministic. */
export const BELIEF_CAP_PER_HOLDER = 48;

export function claimId(c: Pick<BeliefClaim, "holder" | "kind" | "subject" | "object" | "week">): string {
  return `${c.holder}|${c.kind}|${c.subject}|${c.object ?? ""}|${c.week}`;
}

/** Record a claim for its holder (idempotent by id; a re-record keeps the HIGHER confidence). Returns true when the store changed. */
export function recordClaim(store: BeliefStore, claim: Omit<BeliefClaim, "id">): boolean {
  const full: BeliefClaim = { ...claim, id: claimId(claim) };
  const list = (store[full.holder] ??= []);
  const at = list.findIndex((c) => c.id === full.id);
  if (at >= 0) {
    if (full.confidence <= list[at]!.confidence) return false;
    list[at] = full;
    return true;
  }
  list.push(full);
  if (list.length > BELIEF_CAP_PER_HOLDER) {
    // deterministic compaction: lowest confidence first, then oldest (earliest index) — never the claim just written
    let drop = -1;
    for (let i = 0; i < list.length - 1; i++) if (drop < 0 || list[i]!.confidence < list[drop]!.confidence) drop = i;
    list.splice(drop, 1);
  }
  return true;
}

export function claimsOf(store: BeliefStore | undefined, holder: EntityId): readonly BeliefClaim[] {
  return store?.[holder] ?? [];
}

/** A deduced belief is a reasoned guess, not a certainty (0110: it CAN be wrong). */
export const DEDUCED_CLAIM_CONFIDENCE = 0.6;
