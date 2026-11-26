import type { EntityId } from "../domain/ids";
import { RelationshipModel } from "./relationships";
import type { RelationshipDisposition } from "./relationshipConstants";

/**
 * Emergent multi-party bloc behavior (feature 0043). Big Brother is bloc politics — but decision
 * 0002 forbids a STORED alliance object. So blocs are an EMERGENT READ: clustered from the live
 * relationship graph at decision time, carrying a derived shared target, cohesion, and a loyalty
 * strength — computed every read, persisted never. A betrayal that drops an edge fractures the
 * bloc on the next detection because there is nothing stored to update.
 *
 * PURE + stateless + deterministic: same edges + same loyalty reads ⇒ same blocs.
 */
export const BLOC = {
  /** How hard the bloc term bends a decision read, scaled by the bloc's loyalty strength. */
  termWeight: 0.5,
  /**
   * ORW-972: the lean toward the bloc's OWN majority pick on an eviction vote, as a share of `termWeight` (the shield keeps the full weight). Swept 2026-11-26 (seeds 1-100 for the
   * 0043 lift, 300 per PO arm): 1.0 = lift +0.043, solid wins 6.0%; 0.5 = +0.021, 6.0%; 0.33 = +0.016, 6.3%; 0.2 = +0.007, 6.3%; the old shared-target lean = -0.030, 8.0%. 0.33 is the
   * smallest weight that makes a bloc vote together; Ryne approved shipping it (2026-11-26: "Yeah that is fine to ship... If it gets too unbalanced, then we can go in with a fix.").
   */
  voteLeanShare: 0.33,
  /** Below this derived loyalty a member is defection-prone (their own incentives dominate). */
  defectionLoyalty: 0.4,
  /** An outside bond must beat the member's weakest inside bond by this margin to peel them off. */
  defectionMargin: 0.1,
  /** Loyalty aggregation: the flightiest member matters more than the average. */
  weakestWeight: 0.7,
  /** Dispositional loyalty baselines (the 0026 disposition family): loyalists stick, clashers don't. */
  dispositionLoyalty: { bond: 0.8, neutral: 0.55, clash: 0.35 } as Record<RelationshipDisposition, number>,
  /** How far the CURRENT soul state (0041) swings effective loyalty around the dispositional base. */
  soulSwing: 0.4,
} as const;

/** A transient, derived bloc — NEVER persisted (decision 0002). */
export interface Bloc {
  members: EntityId[];
  /** The members' top aggregate-threat outsider — the bloc's shared enemy (null at endgame). */
  sharedTarget: EntityId | null;
  /** The weakest internal mutual bond — how tight the bloc actually is. */
  cohesion: number;
  /** Weakest-weighted aggregate of the members' derived loyalty — how STICKY the bloc is. */
  loyaltyStrength: number;
}

/**
 * A houseguest's derived loyalty (the ethereal↔static dial, product feedback 2026-06-10): their
 * dispositional baseline (a loyalist vs. a free agent — static CHARACTER) modulated by their
 * CURRENT soul state (0041: a freshly-rattled loyalist's effective loyalty dips). Derived per
 * read; never stored per bloc.
 */
export function derivedLoyalty(disposition: RelationshipDisposition, soulState: number, cultureMult = 1): number {
  const base = BLOC.dispositionLoyalty[disposition] * cultureMult; // ORW-551 slice 3: the house culture's loyalty dial scales the BASELINE, before the per-person soul swing (1 = byte-identical)
  const v = base + (soulState - 0.5) * BLOC.soulSwing;
  return Math.max(0, Math.min(1, v));
}

export interface BlocDeps {
  rel: RelationshipModel;
  active: readonly EntityId[];
  /** The member's derived loyalty (see `derivedLoyalty`); omitted ⇒ a neutral 0.55 for everyone. */
  loyaltyOf?: (id: EntityId) => number;
  /** Mutual-bond threshold for a bloc edge; defaults to the model's alliance threshold (0.5). */
  threshold?: number;
  /**
   * 0107 — the NAMED-ALLIANCE cement: a bounded boost added to a pair's effective mutual bond, so naming
   * an alliance pulls co-members together + tightens the bloc. Omitted ⇒ 0 for every pair ⇒ BYTE-IDENTICAL
   * detection (the calibration spine). The boost is bounded by the alliance layer, never enough to
   * fabricate a bloc from nothing — the real bonds still rule.
   */
  tieBoost?: (a: EntityId, b: EntityId) => number;
}

const bondOf = (rel: RelationshipModel, a: EntityId, b: EntityId): number => {
  const e = rel.edge(a, b);
  return (e.trust + e.affinity) / 2;
};

/** The MUTUAL bond between two houseguests — a bloc edge needs both directions. */
export const mutualBond = (rel: RelationshipModel, a: EntityId, b: EntityId): number =>
  Math.min(bondOf(rel, a, b), bondOf(rel, b, a));

/** How tight a group actually is: the WEAKEST internal mutual bond (1 for a group of one). The ONE definition of bloc cohesion, shared with the formal alliances' neglect check (ORW-353). */
export function cohesionOf(members: readonly EntityId[], bond: (a: EntityId, b: EntityId) => number): number {
  let cohesion = 1;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) cohesion = Math.min(cohesion, bond(members[i]!, members[j]!));
  }
  return cohesion;
}

/**
 * Detect the house's current blocs from the live relationship graph. Greedy clustering over the
 * strongest mutual bonds — bounded ONLY by the clique requirement (no artificial size cap): a bloc
 * grows as large as the mutual trust genuinely supports, so a real majority alliance can form. Then
 * per-member DEFECTION: a low-loyalty member with a stronger outside bond peels off BEFORE any
 * formal betrayal event. Deterministic: edges are ranked by strength with a stable id tiebreak.
 */
export function detectBlocs(deps: BlocDeps): Bloc[] {
  const { rel, active } = deps;
  const threshold = deps.threshold ?? 0.5;
  const loyaltyOf = deps.loyaltyOf ?? ((): number => 0.55);
  // 0107: the cemented mutual bond — the raw bond plus the bounded named-alliance tie boost (0 by default).
  const tie = deps.tieBoost ?? ((): number => 0);
  const bond = (a: EntityId, b: EntityId): number => Math.min(1, mutualBond(rel, a, b) + tie(a, b));

  // 1) Every qualifying mutual edge, strongest first (stable order for determinism).
  const edges: Array<{ a: EntityId; b: EntityId; w: number }> = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const w = bond(active[i]!, active[j]!);
      if (w >= threshold) edges.push({ a: active[i]!, b: active[j]!, w });
    }
  }
  edges.sort((x, y) => y.w - x.w || (x.a + x.b).localeCompare(y.a + y.b));

  // 2) Greedy CLIQUE growth (no size cap): the strongest bonds seed the blocs, and a member joins
  // only if mutually bonded with EVERY current member — a bloc cannot span two houseguests who
  // distrust each other just because they share a friend (that is two blocs, not one). The clique
  // requirement is the ONLY limiter on size, so a bloc is exactly as large as the mutual trust
  // supports — a genuine majority alliance forms when (and only when) everyone in it trusts everyone
  // else. This is also what makes fracture work: a betrayal that collapses one internal edge excludes
  // the betrayer from the next read even when a common friend remains.
  const qualifies = (m: EntityId, cluster: ReadonlySet<EntityId>): boolean =>
    [...cluster].every((x) => bond(m, x) >= threshold);
  const blocOf = new Map<EntityId, Set<EntityId>>();
  for (const { a, b } of edges) {
    const ba = blocOf.get(a);
    const bb = blocOf.get(b);
    if (!ba && !bb) {
      const s = new Set([a, b]);
      blocOf.set(a, s); blocOf.set(b, s);
    } else if (ba && !bb && qualifies(b, ba)) {
      ba.add(b); blocOf.set(b, ba);
    } else if (bb && !ba && qualifies(a, bb)) {
      bb.add(a); blocOf.set(a, bb);
    } else if (ba && bb && ba !== bb) {
      const crossOk = [...ba].every((m) => qualifies(m, bb));
      if (crossOk) for (const m of bb) { ba.add(m); blocOf.set(m, ba); }
    }
  }

  // 3) Per-member defection (pre-betrayal): low loyalty + a stronger MUTUAL bond outside ⇒ peel off.
  // ENG-NEW-3 (#585): decide every defection against the IMMUTABLE pre-pass snapshot of each cluster
  // FIRST, then apply them all — never mutate the Set we are still scanning. Mutating mid-pass made the
  // result order-dependent (an early defection changed the `weakestInside`/outside split seen by a later
  // member, a cascade that depended on iteration order). Two-phase makes the read a pure function of the
  // input graph.
  // SOC-NEW-2 (#563): the outside attraction must be MUTUAL (both directions), the same bond an inside
  // edge is measured by — a one-way crush from outside cannot peel a member off (we compared a one-way
  // `bondOf` against a mutual `weakestInside`, so an unrequited outside affection wrongly triggered).
  const clusters = [...new Set(blocOf.values())].filter((s) => s.size >= 2);
  const toDefect: Array<{ cluster: Set<EntityId>; member: EntityId }> = [];
  for (const cluster of clusters) {
    const snapshot = [...cluster]; // immutable: every member is judged against the same cluster
    for (const m of snapshot) {
      if (loyaltyOf(m) >= BLOC.defectionLoyalty) continue;
      const inside = snapshot.filter((x) => x !== m);
      if (inside.length === 0) continue;
      const weakestInside = Math.min(...inside.map((x) => bond(m, x)));
      const outside = active.filter((x) => x !== m && !cluster.has(x));
      const bestOutside = outside.length ? Math.max(...outside.map((x) => bond(m, x))) : 0;
      if (bestOutside > weakestInside + BLOC.defectionMargin) {
        toDefect.push({ cluster, member: m });
      }
    }
  }
  for (const { cluster, member } of toDefect) {
    cluster.delete(member);
    blocOf.delete(member);
  }

  // 4) Project each surviving cluster into a derived, transient Bloc.
  const out: Bloc[] = [];
  for (const cluster of clusters) {
    if (cluster.size < 2) continue;
    const members = [...cluster].sort();
    const outsiders = active.filter((x) => !cluster.has(x));
    let sharedTarget: EntityId | null = null;
    let topThreat = -1;
    for (const o of outsiders) {
      const agg = members.reduce((sum, m) => sum + rel.edge(m, o).threat, 0);
      if (agg > topThreat) { topThreat = agg; sharedTarget = o; }
    }
    const cohesion = cohesionOf(members, bond);
    const loyalties = members.map(loyaltyOf);
    const loyaltyStrength =
      BLOC.weakestWeight * Math.min(...loyalties) +
      (1 - BLOC.weakestWeight) * (loyalties.reduce((a, b) => a + b, 0) / loyalties.length);
    out.push({ members, sharedTarget, cohesion, loyaltyStrength });
  }
  return out.sort((a, b) => a.members[0]!.localeCompare(b.members[0]!));
}

/** The bloc the holder belongs to, if any (a derived read — recomputed by the caller per decision). */
export function blocFor(blocs: readonly Bloc[], holder: EntityId): Bloc | null {
  return blocs.find((b) => b.members.includes(holder)) ?? null;
}

/**
 * The bloc TERM on a decision read (0043 §4): how much belonging to a bloc bends the holder's
 * score for a target. Positive = more likely to move against the target. Shield bloc-mates,
 * lean toward the shared enemy — bounded by `termWeight × loyaltyStrength`, layered on the base
 * threat/trust read (it nudges; it never overrides the 0005 hard rules, which bind downstream).
 */
/**
 * ORW-972 (0043 "bloc-mates vote together"): the bloc term ON AN EVICTION VOTE. A member shields a bloc-mate as before, and leans toward the bloc's OWN pick (`blocVotePick`: what its
 * members would vote, each read without the bloc), not toward the threat-derived `sharedTarget`. Pulling every member toward the shared target flipped only the marginal member
 * against the rest of the bloc when the house voted by consensus: the trio agreed LESS with the term than without it (measured 0.823 vs 0.835 on seeds 1-100). No pick (a tie,
 * or nobody to count) = no lean, the shield only. Nominations keep `blocTerm` (the shared target is who the bloc wants on the block).
 */
export function blocVoteTerm(blocs: readonly Bloc[], holder: EntityId, target: EntityId, pick: EntityId | undefined): number {
  const bloc = blocFor(blocs, holder);
  if (!bloc) return 0;
  const strength = BLOC.termWeight * bloc.loyaltyStrength;
  if (bloc.members.includes(target)) return -strength;          // shield a bloc-mate
  if (pick !== undefined && pick === target) return +strength * BLOC.voteLeanShare;  // vote with the bloc (a smaller lean than the shield)
  return 0;
}

/**
 * ORW-972: the bloc's own pick between the two nominees, as `holder` reads it: the majority of its members' votes (nominees do not vote). `readOf(member)` is the member's pick read
 * without the bloc (undefined = not counted). A tie, or no one counted, is no pick. Pure.
 */
export function blocVotePick(blocs: readonly Bloc[], holder: EntityId, fn: readonly [EntityId, EntityId], readOf: (member: EntityId) => EntityId | undefined): EntityId | undefined {
  const bloc = blocFor(blocs, holder);
  if (!bloc) return undefined;
  let n0 = 0, n1 = 0;
  for (const m of bloc.members) {
    if (fn.includes(m)) continue;
    const p = readOf(m);
    if (p === fn[0]) n0++; else if (p === fn[1]) n1++;
  }
  return n0 > n1 ? fn[0] : n1 > n0 ? fn[1] : undefined;
}

export function blocTerm(blocs: readonly Bloc[], holder: EntityId, target: EntityId): number {
  const bloc = blocFor(blocs, holder);
  if (!bloc) return 0;
  const strength = BLOC.termWeight * bloc.loyaltyStrength;
  if (bloc.members.includes(target)) return -strength;          // shield a bloc-mate
  if (bloc.sharedTarget === target) return +strength;           // lean toward the shared enemy
  return 0;
}
