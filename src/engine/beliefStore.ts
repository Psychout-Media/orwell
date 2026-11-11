import type { EntityId } from "../domain/ids";
import { clamp01Raw } from "../domain/num";

/**
 * #2017 slice S0a — the NPC belief store: DATA MODEL + PLUMBING ONLY. Behind `ORWELL_NPC_BELIEFS` (default ON; `=0` opts out).
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
export type ClaimKind = "heard-rumor" | "voted-against-me" | "targets-me" | "allied-with" | "holds-power" | "will-vote" | "assured-me" | "lied-to-me";
export type ClaimOrigin = "witnessed" | "told" | "overheard" | "gossip" | "deduced" | "assured";

/** The signed move a claim caused on the holder's own edge toward the subject (what the edge update ABSORBED). */
export interface EdgeDelta { trust?: number; affinity?: number; threat?: number }

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
  /** For a `heard-rumor`: the (believed) nature of what was heard (e.g. "betrayal", "gossip"). */
  nature?: string;
  /** Who it came from, when it came from someone (the teller / the gossip source). */
  source?: EntityId;
  /** 0..1 — how sure the holder is. */
  confidence: number;
  week: number;
  /** What this claim moved on the holder->subject edge when it was absorbed (S0b provenance). Absent ⇒ it moved nothing / was never measured. */
  impact?: EdgeDelta;
  /** Set once the claim is refuted; `reversed` is the delta that refutation actually took back (idempotent: a claim reverses at most once). */
  refuted?: boolean;
  reversed?: EdgeDelta;
}

/** holder -> that holder's claims, oldest first. Engine-only season state (rides on `LiveSeasonState.beliefs`). */
export type BeliefStore = Record<EntityId, BeliefClaim[]>;

/** Per-holder bound so a long season cannot grow without limit. Compaction drops the OLDEST, LOWEST-confidence claim first and is deterministic. */
export const BELIEF_CAP_PER_HOLDER = 48;

export function claimId(c: Pick<BeliefClaim, "holder" | "kind" | "subject" | "object" | "week">): string {
  return `${c.holder}|${c.kind}|${c.subject}|${c.object ?? ""}|${c.week}`;
}

/** Record a claim for its holder (idempotent by id; a re-record keeps the HIGHER confidence). Returns true when the store changed. */
export function recordClaim(store: BeliefStore, claim: Omit<BeliefClaim, "id"> & { id?: string }): boolean {
  const full: BeliefClaim = { ...claim, id: claim.id ?? claimId(claim) };
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

/** The fraction of a refuted claim's recorded edge impact that is taken back (bounded: never the whole move — the holder was still changed by hearing it). */
export const REFUTE_REVERSAL_FRACTION = 0.5;

const COMPONENTS = ["trust", "affinity", "threat"] as const;
type MutableEdge = { trust: number; affinity: number; threat: number };
const clamp01 = clamp01Raw;

/** The edge delta between two reads of the SAME edge (after − before), components that did not move omitted. */
export function edgeDelta(before: MutableEdge, after: MutableEdge): EdgeDelta {
  const d: EdgeDelta = {};
  for (const c of COMPONENTS) {
    const v = after[c] - before[c];
    if (v !== 0) d[c] = v;
  }
  return d;
}

/**
 * Refute a claim: take back a BOUNDED FRACTION of the edge impact it recorded, applied as a DELTA to the CURRENT edge (never a restore to a
 * snapshot — later events that moved the same edge are kept), clamped to [0,1], deterministic (no rng). Idempotent: a claim reverses once; refuting
 * an unknown / already-refuted / impact-less claim changes nothing. Returns the delta actually taken back (empty when nothing changed).
 */
export function refuteClaim(
  store: BeliefStore, holder: EntityId, id: string, edgeOf: (holder: EntityId, subject: EntityId) => MutableEdge,
  fraction: number = REFUTE_REVERSAL_FRACTION,
): EdgeDelta {
  const claim = store[holder]?.find((c) => c.id === id);
  if (!claim || claim.refuted) return {};
  if (!claim.impact || !COMPONENTS.some((c) => claim.impact![c])) return {};   // nothing was absorbed: nothing to take back, and the claim stays as it was
  claim.refuted = true;
  const bounded = Math.max(0, Math.min(REFUTE_REVERSAL_FRACTION, fraction));    // a caller can narrow the reversal, never widen it past the bound
  const edge = edgeOf(claim.holder, claim.subject);
  const back: EdgeDelta = {};
  for (const c of COMPONENTS) {
    const moved = claim.impact[c];
    if (!moved) continue;
    const take = moved * bounded;             // same sign as the original move, strictly bounded by `fraction` of it
    const next = clamp01(edge[c] - take);
    const actual = edge[c] - next;             // what the clamp actually allowed back
    if (actual !== 0) { edge[c] = next; back[c] = actual; }
  }
  claim.reversed = back;
  return back;
}

/** Record a heard rumor (an E44 gossip receipt) as a claim with provenance: the holder, the subject, the believed nature, and the edge delta it absorbed. */
export function recordRumorClaim(
  store: BeliefStore, r: { listener: EntityId; subject: EntityId; type: string; confidence: number; delta: EdgeDelta }, week: number,
): boolean {
  // One record PER RECEIPT: repeated receipts for the same (holder, subject, week) each moved the edge, so each keeps its own provenance and its own
  // refutation state (a shared id would overwrite the earlier impact — making it unrefutable — and reset `refuted`).
  const base = claimId({ holder: r.listener, kind: "heard-rumor", subject: r.subject, week });
  const n = (store[r.listener] ?? []).filter((c) => c.id === base || c.id.startsWith(base + "#")).length;
  return recordClaim(store, {
    id: n === 0 ? base : `${base}#${n + 1}`,
    holder: r.listener, kind: "heard-rumor", subject: r.subject, value: true, origin: "gossip", nature: r.type,
    confidence: Math.max(0, Math.min(1, r.confidence)), week, impact: r.delta,
  });
}

/** B3 — weeks for a decision-relevant claim's weight to halve (a stale read of who is targeting me fades). */
export const TARGETS_ME_HALF_LIFE_WEEKS = 4;
/** B3 — the MAX nomination tilt a pile of `targets-me` claims can add (bounded, below a fresh betrayal's edge move). */
export const TARGETS_ME_TILT_MAX = 0.18;
/** B3 — one fully-confident, fresh `targets-me` claim's tilt (diminishing when several stack, via 1-prod(1-w)). */
export const TARGETS_ME_TILT_PER_CLAIM = 0.12;

/**
 * B3 / #2017 — the HOH's BELIEF that `subject` is targeting them, as a nomination tilt against `subject`: each live (un-refuted, believed-true) `targets-me` claim contributes
 * `confidence x 0.5^(age/halfLife)`, stacked with diminishing returns, scaled to TARGETS_ME_TILT_MAX. Reads the CLAIMS only — never the relationship edge — so it is a belief-driven
 * term (it can be WRONG), not a re-read of what the edge already carries. Pure: no rng, no I/O.
 */
export function targetsMeTilt(store: BeliefStore | undefined, holder: EntityId, subject: EntityId, week: number): number {
  let keep = 1;
  for (const c of claimsOf(store, holder)) {
    if (c.kind !== "targets-me" || c.subject !== subject || c.refuted || !c.value) continue;
    const age = Math.max(0, week - c.week);
    const w = Math.max(0, Math.min(1, c.confidence)) * Math.pow(0.5, age / TARGETS_ME_HALF_LIFE_WEEKS);
    keep *= 1 - Math.min(1, w * (TARGETS_ME_TILT_PER_CLAIM / TARGETS_ME_TILT_MAX));
  }
  return TARGETS_ME_TILT_MAX * (1 - keep);
}
