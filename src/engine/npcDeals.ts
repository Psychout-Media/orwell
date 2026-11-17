import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";
import { NPC_DEALS } from "./npcDealConstants";
import { NPC_DEAL_PUSH } from "./dealNomConstants";
import { fakingLean, type DealPlan, type PlanSource } from "./dealPlans";

/**
 * Feature 0170 (Theme 3 slice 2) - NPC deals and the HOH deal. PURE: no I/O, no Vault handle, no wording, no draws of its own (every roll is handed in from a seeded side stream
 * `${seed}:npc-deals:${week}:${pairKey}` that never touches a shared stream). The engine decides who pacts with whom and what each side secretly intends; the narrator never hears of it.
 *
 * Plans are the Auditor's slice-1 shape (`DealPlan`, `PlanSource` from `dealPlans.ts`, the plan store); this module only PROPOSES them. The store that keeps them is read through `PlanSource.planOf`, and absent a plan the holder keeps
 * the pact, which is today's behaviour. Nothing here is shown to a player or admin: a plan is Vault content until the post-season retrospective.
 */
export type { DealPlan, PlanSource };

/** The optional write hook the plan store wires; absent by default (plans are then simply not kept). */
export type RecordPlan = (dealId: string, holder: EntityId, plan: DealPlan) => void;

/** What this module reads of a directed bond (the shape of the bond read API, kept structural so nothing unmerged is imported). */
export interface PairBond { trust: number; warmth: number; strength: number }
export interface PairBondRead { bond(holder: EntityId, other: EntityId): PairBond }

export type NpcDealKind = "safety" | "final-two";
export interface NpcDealProposal { parties: [EntityId, EntityId]; kind: NpcDealKind; planA: DealPlan; planB: DealPlan }

export interface NpcDealInputs {
  week: number;
  /** Living NPCs (the player is never a party here). */
  npcs: readonly EntityId[];
  bonds: PairBondRead;
  /** True when the pair already holds an open pact, or either of them already sealed one this week. */
  isTaken(a: EntityId, b: EntityId): boolean;
  /** How many pacts this houseguest has been party to so far (a prolific dealmaker leans toward breaking). */
  dealsMade(id: EntityId): number;
  loyaltyOf(id: EntityId): number;
  /** The season culture's multiplier on the lean to break (1 = neutral). */
  breakLean: number;
  /** The pair's own seeded draw stream. */
  stream(pairKey: string): { next(): number };
}

export const pairKeyOf = (a: EntityId, b: EntityId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The holder's chance to plan a break, from the person (loyalty, deals made), the bond (trust in the partner) and the culture. Never a flat rate. */
export function breakChance(holderTrust: number, loyalty: number, dealsMade: number, breakLean: number): number {
  const P = NPC_DEALS.plan;
  // ONE model with the player-deal plans (0178): the shared faking dials (base readiness and the per-past-deal lean, both uncapped) come from `fakingLean`, so one retune moves both; the situational terms (trust in the partner, loyalty) and the culture lean are this module's own.
  const raw = P.lowTrustWeight * Math.max(0, P.trustMid - holderTrust) + P.disloyalWeight * Math.max(0, P.loyaltyMid - loyalty) + fakingLean(dealsMade, 1 - loyalty);
  return clamp01(raw * breakLean);
}

/**
 * One side's plan, from two draws already taken (`r1` decides break or not, `r2` which shape). Pure. The shapes and moments are main's 0178 semantics (`dealPlans.ts`): an honest "this-week" plan carries
 * the moment AFTER the pact has run its course (next week's nominations), so its carry-out finds the deal already expired and keeps it; a planned break is a "break-at" the nominations or the vote of the
 * week it was made (the carry-out breaks it there), or, for a final-two, a "cut-final-three" or a later break. There is no "flip": main carries that out only at a vote on a vote deal.
 */
export function planFor(kind: NpcDealKind, week: number, pBreak: number, r1: number, r2: number): DealPlan {
  const P = NPC_DEALS.plan;
  if (r1 < pBreak) {
    if (kind === "final-two") {
      if (r2 < P.cutShareFinalTwo) return { kind: "cut-final-three" };
      if (r2 < P.cutShareFinalTwo + P.nominationsShareFinalTwo) return { kind: "break-at", moment: { week: week + 1, at: "nominations" } };
      return { kind: "break-at", moment: { week, at: "vote" } };
    }
    return r2 < P.nominationsShareSafety ? { kind: "break-at", moment: { week, at: "nominations" } } : { kind: "break-at", moment: { week, at: "vote" } };
  }
  return kind === "safety" && r2 < P.thisWeekShare ? { kind: "this-week", moment: { week: week + 1, at: "nominations" } } : { kind: "keep" };
}

/** Propose a pact for ONE pair (or none). Always takes exactly five draws from the pair's stream, so the stream is order-independent of the outcome. */
export function proposeNpcDeal(i: NpcDealInputs, a: EntityId, b: EntityId, pairDealsMade?: { a: number; b: number }): NpcDealProposal | null {
  const ab = i.bonds.bond(a, b), ba = i.bonds.bond(b, a);
  const rng = i.stream(pairKeyOf(a, b));
  const [r0, rA1, rA2, rB1, rB2] = [rng.next(), rng.next(), rng.next(), rng.next(), rng.next()];
  const mutual = Math.min(ab.trust, ba.trust);
  if (mutual < NPC_DEALS.mutualTrustMin) return null;
  const warmth = Math.min(ab.warmth, ba.warmth);
  const p = clamp01(NPC_DEALS.proposeBase + NPC_DEALS.proposePerTrust * (mutual - NPC_DEALS.mutualTrustMin) + NPC_DEALS.proposePerWarmth * warmth);
  if (r0 >= p) return null;
  const kind: NpcDealKind = mutual >= NPC_DEALS.finalTwoTrustMin ? "final-two" : "safety";
  const made = pairDealsMade ?? { a: i.dealsMade(a), b: i.dealsMade(b) };
  const planA = planFor(kind, i.week, breakChance(ab.trust, i.loyaltyOf(a), made.a + 1, i.breakLean), rA1, rA2); // + 1: this pact counts, as in the player-deal plans (0178)
  const planB = planFor(kind, i.week, breakChance(ba.trust, i.loyaltyOf(b), made.b + 1, i.breakLean), rB1, rB2);
  return { parties: [a, b], kind, planA, planB };
}

/** Propose the week's pacts across many pairs: the most mutually trusting pairs first, at most `pairCapPerWeek`, no houseguest in two new pacts in one week. */
export function proposeNpcDeals(i: NpcDealInputs): NpcDealProposal[] {
  const ids = [...i.npcs].sort();
  const pairs: Array<{ a: EntityId; b: EntityId; mutual: number }> = [];
  for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) {
    const a = ids[x]!, b = ids[y]!;
    pairs.push({ a, b, mutual: Math.min(i.bonds.bond(a, b).trust, i.bonds.bond(b, a).trust) });
  }
  pairs.sort((p, q) => q.mutual - p.mutual || (pairKeyOf(p.a, p.b) < pairKeyOf(q.a, q.b) ? -1 : 1));
  const out: NpcDealProposal[] = [];
  const used = new Set<EntityId>();
  const extra = new Map<EntityId, number>();
  for (const { a, b } of pairs) {
    if (out.length >= NPC_DEALS.pairCapPerWeek) break;
    if (used.has(a) || used.has(b) || i.isTaken(a, b)) continue;
    const r = proposeNpcDeal(i, a, b, { a: i.dealsMade(a) + (extra.get(a) ?? 0), b: i.dealsMade(b) + (extra.get(b) ?? 0) });
    if (!r) continue;
    out.push(r); used.add(a); used.add(b); extra.set(a, (extra.get(a) ?? 0) + 1); extra.set(b, (extra.get(b) ?? 0) + 1);
  }
  return out;
}

export interface PlannedDeal { id: string; parties: readonly EntityId[]; status: string; madeWeek?: number }

/**
 * The plan-aware nomination push (spec 0170): the holder's OWN plan decides. A plan to break AT THE NOMINATIONS turns the protective push into a positive one in THAT week only (the carry-out
 * breaks the pact there, so there is no later week for it to lean on) and only while the pact is still open; every other plan, and no plan at all, keeps today's protective push. Deterministic, no draws.
 */
export function planAwareDealPush(base: number, holder: EntityId, target: EntityId, week: number, deals: readonly PlannedDeal[], plans: PlanSource | undefined): number {
  if (!plans) return base;
  let best = 0;
  for (const d of deals) {
    if (d.status !== "open" || !d.parties.includes(holder) || !d.parties.includes(target)) continue;
    const plan = plans.planOf(d.id, holder);
    if (plan?.kind === "break-at" && plan.moment?.at === "nominations" && week === plan.moment.week) best = Math.max(best, NPC_DEAL_PUSH.breakAtNominations);
  }
  return best > 0 ? best : base;
}
