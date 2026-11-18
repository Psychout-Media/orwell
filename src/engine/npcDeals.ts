import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";
import { NPC_DEALS } from "./npcDealConstants";
import { NPC_DEAL_PUSH } from "./dealNomConstants";
import { planSemantics, isBetrayal, type DealPlan, type PlanSource, type StoredPlan } from "./dealPlans";

/**
 * Feature 0170 (Theme 3 slice 2) - NPC deals and the HOH deal. PURE: no I/O, no Vault handle, no wording, one draw (the propose roll) from a seeded side stream
 * `${seed}:npc-deals:${week}:${pairKey}` that never touches a shared stream. The engine decides who pacts with whom and of what kind. It does NOT plan: a sealed pact is an ordinary ledger deal, and the
 * Auditor's 0178 planner (`planAndCarryOutDeals`, played games) gives each side its secret plan like every deal, with ONE model. This module only reads that plan back, for the nomination push.
 */
export type { DealPlan, PlanSource };

/** What this module reads of a directed bond (the shape of the bond read API, kept structural so nothing unmerged is imported). */
export interface PairBond { trust: number; warmth: number; strength: number }
export interface PairBondRead { bond(holder: EntityId, other: EntityId): PairBond }

export type NpcDealKind = "safety" | "final-two";
export interface NpcDealProposal { parties: [EntityId, EntityId]; kind: NpcDealKind }

export interface NpcDealInputs {
  week: number;
  /** Living NPCs (the player is never a party here). */
  npcs: readonly EntityId[];
  bonds: PairBondRead;
  /** True when the pair already holds an open pact, or either of them already sealed one this week. */
  isTaken(a: EntityId, b: EntityId): boolean;
  /** The pair's own seeded draw stream. */
  stream(pairKey: string): { next(): number };
}

export const pairKeyOf = (a: EntityId, b: EntityId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Propose a pact for ONE pair (or none). Always takes exactly ONE draw from the pair's stream (the propose roll), so the stream is order-independent of the outcome. */
export function proposeNpcDeal(i: NpcDealInputs, a: EntityId, b: EntityId): NpcDealProposal | null {
  const ab = i.bonds.bond(a, b), ba = i.bonds.bond(b, a);
  const r0 = i.stream(pairKeyOf(a, b)).next();
  const mutual = Math.min(ab.trust, ba.trust);
  if (mutual < NPC_DEALS.mutualTrustMin) return null;
  const warmth = Math.min(ab.warmth, ba.warmth);
  const p = clamp01(NPC_DEALS.proposeBase + NPC_DEALS.proposePerTrust * (mutual - NPC_DEALS.mutualTrustMin) + NPC_DEALS.proposePerWarmth * warmth);
  if (r0 >= p) return null;
  const kind: NpcDealKind = mutual >= NPC_DEALS.finalTwoTrustMin ? "final-two" : "safety";
  return { parties: [a, b], kind };
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
  for (const { a, b } of pairs) {
    if (out.length >= NPC_DEALS.pairCapPerWeek) break;
    if (used.has(a) || used.has(b) || i.isTaken(a, b)) continue;
    const r = proposeNpcDeal(i, a, b);
    if (!r) continue;
    out.push(r); used.add(a); used.add(b);
  }
  return out;
}

export interface PlannedDeal { id: string; parties: readonly EntityId[]; status: string; madeWeek?: number }
type PlanRead = DealPlan & { outcome?: StoredPlan["outcome"] };

/**
 * The plan-aware nomination push (spec 0170): the HOH's OWN plan decides. A betrayal that main's planner carries out as a quiet break AT THE NOMINATIONS of this very week turns the protective push positive
 * for that week only. The carry-out runs before the push is read, so the pact is either still open or was broken by that very plan this week (`outcome` "carried-out", status "broken"); a pact that ended any
 * other way, a later week, or any other plan keeps today's protective push. Deterministic, no draws.
 */
export function planAwareDealPush(base: number, holder: EntityId, target: EntityId, week: number, deals: readonly PlannedDeal[], plans: PlanSource | undefined): number {
  if (!plans) return base;
  let best = 0;
  for (const d of deals) {
    if (!d.parties.includes(holder) || !d.parties.includes(target)) continue;
    const plan = plans.planOf(d.id, holder) as PlanRead | undefined;
    if (!plan || !isBetrayal(plan.kind) || planSemantics(plan.kind).carriedOut !== "break-at-moment" || plan.moment?.at !== "nominations" || week !== plan.moment.week) continue;
    const live = d.status === "open" || (d.status === "broken" && plan.outcome === "carried-out");
    if (live) best = Math.max(best, NPC_DEAL_PUSH.breakAtNominations);
  }
  return best > 0 ? best : base;
}
