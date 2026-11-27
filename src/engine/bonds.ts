import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";
import { RELATIONSHIP_CONSTANTS } from "./relationshipConstants";
import { DECISION } from "./decisionConstants";
import type { RelationshipModel } from "./relationships";
import { BOND, bondOf, bondStrengthOf, kindOf, strandsOf, withGrievance, type BondStore, type BookWrong, type Strand } from "./bondRecord";

/**
 * Theme 3 Core 1 (ORW-552, Ryne approved 2026-11-17) - THE BOND PER PAIR: the read API.
 *
 * One directed, lopsided bond per ordered pair (holder -> other): today's trust / affinity / threat / reliability read through unchanged, plus what Theme 3
 * adds - felt warmth (apart from strategy), debts owed, resentment, strain, shared history, a kind, a commitment level and the holder's private pecking order.
 * `strength` is the ONE 0..1 tie weight every consumer (the house graph, Overseer B) uses: 0 = strangers (the edge baseline), 1 = the closest bond.
 *
 * ENGINE-ONLY (Vault class): never projected, never a tool, never a number to the player. Deterministic and read-only: no rng, no writes.
 * This file is the CONTRACT (posted on ORW-552). `edgeBondReader` is the first reader, over the relationship model alone; feature 0175 replaces it with the
 * full bond record (the extra fields then carry real values, and `strength` blends warmth and resentment) behind the same interface.
 */
import type { BondKind, Commitment } from "./bondRecord";
export type { BondKind, Commitment, Strand } from "./bondRecord"; // defined beside the record (no import cycle); the read API re-exports them

/** `holder`'s DIRECTED view of `other` (lopsided: bond(a, b) is not bond(b, a)). */
export interface BondView {
  holder: EntityId;
  other: EntityId;
  /** Read through from today's relationship edge, unchanged. */
  trust: number;
  affinity: number;
  threat: number;
  reliability: number;
  /** 0..1 felt closeness, apart from strategy. */
  warmth: number;
  /** -1..1: positive = `other` owes `holder`, negative = `holder` owes `other`. */
  debt: number;
  /** 0..1. */
  resentment: number;
  /** 0..1: the worst the grudge ever was (kept for good, even after a repair eases it). */
  peakResentment: number;
  /** 0..1; repair lowers it, the memory stays in `history`. */
  strain: number;
  /** Count of shared key moments. */
  history: number;
  kind: BondKind;
  /** ORW-622: every strand the bond carries at once, each 0..1 (only those present). Readers take the strand that matters to them: protection at the vote, friction at dinner. */
  strands: Partial<Record<Strand, number>>;
  commitment: Commitment;
  /** `holder`'s private pecking order: 1 = matters most; null = not ranked. */
  rank: number | null;
  /** 0..1 tie weight: 0 = strangers (the edge baseline), 1 = the closest bond. Consumers read this, never the relationship model. */
  strength: number;
}

export interface BondReader {
  /** Houseguests still in the house (the player included). */
  living(): readonly EntityId[];
  bond(holder: EntityId, other: EntityId): BondView;
  /** = bond(holder, other).strength, cheap. */
  strength(holder: EntityId, other: EntityId): number;
  /** Undirected 0..1: the MINIMUM of the two directed strengths (a mutual tie). */
  tie(a: EntityId, b: EntityId): number;
  /** `holder`'s outgoing bonds to everyone else living, strongest first, ties broken by id. */
  ties(holder: EntityId): ReadonlyArray<{ other: EntityId; strength: number }>;
  /** The in-game day the read is for (the graph derives once per day). */
  day(): number;
}


/** The edge-only strength: (bondStrength - baseline) / the floater span, clamped. The full record (0175) keeps this as its base. */
export function edgeStrength(rel: RelationshipModel, holder: EntityId, other: EntityId): number {
  const base = (RELATIONSHIP_CONSTANTS.baseline.trust + RELATIONSHIP_CONSTANTS.baseline.affinity) / 2;
  return clamp01((rel.peekBondStrength(holder, other) - base) / DECISION.nomination.floaterBondSpan); // peek: a read never creates an edge
}

/** Order outgoing ties: strongest first, then by id (deterministic). */
export function orderTies(ties: Array<{ other: EntityId; strength: number }>): Array<{ other: EntityId; strength: number }> {
  return ties.sort((a, b) => b.strength - a.strength || (a.other < b.other ? -1 : a.other > b.other ? 1 : 0));
}

/** The first BondReader: today's relationship edge only (the Theme 3 fields at their neutral values). Same contract as the full record. */
export function edgeBondReader(rel: RelationshipModel, living: () => readonly EntityId[], day: () => number): BondReader {
  const view = (holder: EntityId, other: EntityId): BondView => {
    const e = rel.peek(holder, other);
    return {
      holder, other, trust: e.trust, affinity: e.affinity, threat: e.threat, reliability: e.reliability,
      warmth: e.affinity, debt: 0, resentment: 0, peakResentment: 0, strain: 0, history: 0, kind: "none", strands: e.affinity > 0 ? { friendship: Math.min(1, e.affinity) } : {}, commitment: "none", rank: null,
      strength: edgeStrength(rel, holder, other),
    };
  };
  const reader: BondReader = {
    living,
    bond: view,
    strength: (holder, other) => edgeStrength(rel, holder, other),
    tie: (a, b) => Math.min(edgeStrength(rel, a, b), edgeStrength(rel, b, a)),
    ties: (holder) => orderTies(living().filter((o) => o !== holder).map((other) => ({ other, strength: edgeStrength(rel, holder, other) }))),
    day,
  };
  return reader;
}

/**
 * 0175 - the full reader: the edge plus the BOND RECORD (warmth, debts, resentment, strain, history, commitment, kind) and the holder's private pecking order
 * (their top `BOND.rankTop` by strength, 1 = matters most). Same contract as `edgeBondReader`; a pair with no record reads exactly as the edge-only reader.
 */
/** Extra debt a holder is owed (+) or owes (-) from another source of truth (slice 3's favor ledger), added to the record's own debt (saves) and clamped -1..1. */
export type DebtSource = (holder: EntityId, other: EntityId) => number;

/** ORW-607 part 2: the grudge book's wrong a holder carries toward another (its `wrongWeight` now and its peak), or undefined for none. Played games only; engine-only. */
export type WrongSource = (holder: EntityId, other: EntityId) => BookWrong | undefined;

export function recordBondReader(rel: RelationshipModel, store: () => BondStore | undefined, living: () => readonly EntityId[], day: () => number, opts: { favorDebt?: DebtSource; wrong?: WrongSource; /** ORW-1079: the mentor / puppet-master reads beyond the record */ steerKind?: (holder: EntityId, other: EntityId) => { mentor?: boolean; puppetMaster?: boolean } } = {}): BondReader {
  /** The record as readers see it: with a wrong source, its resentment / peak ARE the grievance (the book's wrong plus the record's friction, once). */
  const seen = (holder: EntityId, other: EntityId) => withGrievance(bondOf(store(), holder, other), opts.wrong?.(holder, other));
  const strengthOf = (holder: EntityId, other: EntityId): number => bondStrengthOf(edgeStrength(rel, holder, other), seen(holder, other));
  const ties = (holder: EntityId) => orderTies(living().filter((o) => o !== holder).map((other) => ({ other, strength: strengthOf(holder, other) })));
  return {
    living,
    bond: (holder, other) => {
      const e = rel.peek(holder, other);
      const r = seen(holder, other);
      const ranked = ties(holder).filter((t) => t.strength > 0).slice(0, BOND.rankTop);
      const at = ranked.findIndex((t) => t.other === other);
      return {
        holder, other, trust: e.trust, affinity: e.affinity, threat: e.threat, reliability: e.reliability,
        warmth: r.warmth, debt: Math.max(-1, Math.min(1, r.debt + (opts.favorDebt?.(holder, other) ?? 0))), resentment: r.resentment, peakResentment: r.peakResentment, strain: r.strain, history: r.history,
        kind: kindOf(r, opts.steerKind?.(holder, other)), strands: strandsOf(r), commitment: r.commitment, rank: at >= 0 ? at + 1 : null,
        strength: strengthOf(holder, other),
      };
    },
    strength: strengthOf,
    tie: (a, b) => Math.min(strengthOf(a, b), strengthOf(b, a)),
    ties,
    day,
  };
}
