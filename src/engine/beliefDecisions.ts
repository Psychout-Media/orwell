import type { EntityId } from "../domain/ids";
import { claimsOf, evidenceKey, targetsMeTilt, type BeliefClaim, type BeliefStore } from "./beliefStore";
import { REASONS } from "./agendaConstants";
import { CONVICTION } from "./beliefConviction";
import { THREAT_NATURES } from "./gossipBeliefs";

/**
 * Feature 0150 / ORW-330 (theme 2, slice 2) - BELIEFS DRIVE DECISIONS. What a houseguest BELIEVES about someone (that they are targeting
 * them, voted against them, lied to them, or are going after them) pushes their nominations, votes and deal consent, and can form a goal,
 * whether the belief is true or not. Before this slice only one belief kind ("targets me") counted, capped at a small tilt (0.18), while
 * goals count at full strength (Ryne 2026-11-12) - so beliefs were the weaker voice.
 *
 * Q2 SEAM (Ryne's theme 2 question 2, open; recommended answer "yes, full strength, measured and reported, never a gate"):
 * `BELIEF_RULES.strength`. "full" puts a believed grievance on the same scale as a goal (`REASONS.goalWeight`, the goal pull's own
 * scale) and lets it form a revenge goal; "capped" is the behaviour before this slice, byte for byte (the 0.18 targets-me tilt, no
 * belief-formed goals). A different answer is a change here only.
 *
 * Pure rules: no I/O, no rng. ENGINE-ONLY: reads the belief store; nothing here is projected.
 */
export type BeliefStrength = "full" | "capped";
export const BELIEF_RULES: { strength: BeliefStrength } = { strength: "full" };

export const BELIEF_PULL = {
  /** Weeks for a belief's weight to halve (a stale read fades), as for the targets-me tilt. */
  halfLifeWeeks: 4,
  /** How much each kind of believed grievance counts (a lie told to you, or a rumor that someone is after you, a little less than a direct threat or a vote). */
  kindWeight: { "targets-me": 1, "voted-against-me": 1, "lied-to-me": 0.8, "going-after-me": 0.8, /* ORW-546 (0169): a heard rumor that someone is dangerous - a soft pull, below the revenge bar alone */ "rumored-threat": 0.35 } as const,
  /**
   * The goal-forming bar: a believed grievance this strong (weight x confidence, after decay) can become a revenge goal. 0150 used the remembered
   * grudge's bar (0.6); 0153 (slice 3) raised it to 0.75 to keep the agreed week-1 house mix once NPCs tell each other claims (houseMixGuard,
   * ORW-330: bonding 37.4 at 0.6, 41.1 at 0.75, 42.4 at 0.9; reference 44 +-5). One trusted tell (~0.77) still clears it; a doubted one does not.
   */
  revengeBar: 0.75,
};

type GrievanceKind = keyof typeof BELIEF_PULL.kindWeight;

/** The grievance a belief carries against its subject, if any (believed true, not refuted). */
export function grievanceOf(c: BeliefClaim, holder: EntityId): GrievanceKind | undefined {
  if (!c.value || c.refuted) return undefined;
  switch (c.kind) {
    case "targets-me": return c.object === undefined || c.object === holder ? "targets-me" : undefined;
    case "voted-against-me": return "voted-against-me";
    case "lied-to-me": return "lied-to-me";
    case "heard-rumor":
      if (c.nature === "going-after" && c.object === holder) return "going-after-me";
      // ORW-546 (0169): off-screen gossip with a teller (only written under ORWELL_GOSSIP_BELIEFS, so flag-off claims never match) that says its subject is dangerous.
      if (c.origin === "gossip" && c.source !== undefined && c.nature !== undefined && THREAT_NATURES.has(c.nature)) return "rumored-threat";
      return undefined;
    default: return undefined;
  }
}

/** One belief's weight now: kind x confidence x decay. */
function weightNow(c: BeliefClaim, kind: GrievanceKind, week: number): number {
  const age = Math.max(0, week - c.week);
  // 0160 (conviction): a belief held at or above CONVICTION.asFact is acted on as a fact (full weight); below it, in proportion.
  const conviction = c.confidence >= CONVICTION.asFact ? 1 : Math.max(0, Math.min(1, c.confidence));
  return BELIEF_PULL.kindWeight[kind] * conviction * Math.pow(0.5, age / BELIEF_PULL.halfLifeWeeks);
}

/**
 * How strongly `holder` believes they have a grievance against `subject`, 0..1 (several beliefs stack with diminishing returns). ORW-591 (Fable
 * T2-8): only DISTINCT evidence stacks - one source repeating the same thing is one piece of evidence (`evidenceKey`), counted at its strongest;
 * two different sources, or two separate things the holder saw or deduced, each count.
 */
export function believedGrievance(store: BeliefStore | undefined, holder: EntityId, subject: EntityId, week: number): { strength: number; top?: GrievanceKind } {
  const strongest = new Map<string, number>();
  let top: { kind: GrievanceKind; w: number } | undefined;
  for (const c of claimsOf(store, holder)) {
    if (c.subject !== subject) continue;
    const kind = grievanceOf(c, holder);
    if (!kind) continue;
    const w = weightNow(c, kind, week);
    const key = evidenceKey(c);
    strongest.set(key, Math.max(strongest.get(key) ?? 0, w));
    if (!top || w > top.w) top = { kind, w };
  }
  let keep = 1;
  for (const w of strongest.values()) keep *= 1 - Math.min(1, w);
  return top ? { strength: 1 - keep, top: top.kind } : { strength: 0 };
}

/**
 * The push a holder's beliefs give AGAINST `subject` in a decision (nominate, vote to evict, refuse a deal). Full strength: on the goal
 * pull's scale (`REASONS.goalWeight`). Capped: exactly the old targets-me tilt.
 */
export function beliefPull(store: BeliefStore | undefined, holder: EntityId, subject: EntityId, week: number, rules = BELIEF_RULES): number {
  if (rules.strength === "capped") return targetsMeTilt(store, holder, subject, week);
  return REASONS.goalWeight * believedGrievance(store, holder, subject, week).strength;
}

/** The believed grievances strong enough to form a revenge goal (full strength only), strongest first. */
export function believedGrievances(store: BeliefStore | undefined, holder: EntityId, others: readonly EntityId[], week: number, rules = BELIEF_RULES): Array<{ toward: EntityId; strength: number; ref: GrievanceKind }> {
  if (rules.strength !== "full") return [];
  const out: Array<{ toward: EntityId; strength: number; ref: GrievanceKind }> = [];
  for (const toward of others) {
    if (toward === holder) continue;
    const g = believedGrievance(store, holder, toward, week);
    if (g.top && g.strength >= BELIEF_PULL.revengeBar) out.push({ toward, strength: g.strength, ref: g.top });
  }
  return out.sort((a, b) => b.strength - a.strength || a.toward.localeCompare(b.toward));
}

/** 0163 / ORW-539: how much one witnessed bonding scene between two others raises the bond the decider sees (four scenes = the full floater span). */
export const PERCEIVED_BOND = { perScene: 0.25, /** v2: how much of the read is what they saw (the rest is the true bond: tone and glances a houseguest picks up). */ seenShare: 0.5 } as const;
