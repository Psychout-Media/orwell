import type { EntityId } from "../domain/ids";
import type { DealKind } from "../domain/deal";
import { clamp01 } from "../domain/num";

/**
 * Feature 0178 - Theme 3 slice 1 (ORW-552): TWO-FACED DEALS. When a houseguest agrees to a deal, the engine gives them a SECRET PLAN for it: keep it;
 * break it at a chosen moment (this week or a later one); flip at the vote; or cut at the final three. PURE: no I/O, no rng handle (the caller supplies rolls from its
 * own side stream). The plan is engine-only (Vault class): never projected, never a hint in the narration; the retrospective shows each plan after the crown.
 *
 * Ryne's rulings (ORW-552, 2026-11-17):
 *  - Q3 (Theme 2): a fake deal has no built-in tells, and a low-trust deal weighs less.
 *  - Q1: how often a houseguest deals falsely depends on the person, the bond and the culture, with NO CAP. The balance corrects itself: a houseguest who makes
 *    many deals leans toward breaking them (and earns the reputation for it, slice 8). Measured and reported, never capped.
 *
 *   P(two-faced) = clamp(fakingLean(dealsMade, cunning) + slope * clamp(margin) + culture, 0, 1)   - no ceiling below 1
 *   which plan: by the deal's kind and the moment (a vote deal flips at the vote; a final two is cut at the final three or broken later; a safety deal is
 *   broken at the nominations it was meant to cover, or flipped at this week's vote), one more roll among the plans the kind allows. What each plan kind
 *   means is PLAN_SEMANTICS below, the one table every reader uses.
 */
export type PlanKind = "keep" | "break-at" | "flip" | "cut-final-three";
export type PlanMoment = { week: number; at: "nominations" | "veto" | "vote" };

/**
 * THE PLAN-SEMANTICS TABLE (ORW-552, Coordinator 2026-11-17): the ONE place that says what each plan kind means. The 0178 planner, the 0170 NPC-pact planner
 * (Overseer B), the carry-out loop, the flip at the vote and the measurement report all read it; nothing else may decide whether a plan is a betrayal.
 *  - `betrayal`: the holder means to break their word (a two-faced plan). An honest plan is not.
 *  - `carriedOut`: how a betrayal is carried out - never (honest); at its moment by a quiet break; by the vote itself (the flip); or at the final three.
 *  - `expires`: when the plan stops mattering - when the deal ends (by any means), or at the week roll (the plan only concerns this week).
 * There is no "this-week" kind (ORW-601): "keep it this week, then lapse" is the same as keeping a safety deal (it ends at the week roll), and "keep it this
 * week, then break it" is a "break-at" with next week's moment. A plan stored under a retired kind reads as "keep" (`planSemantics`).
 */
export const PLAN_SEMANTICS: Readonly<Record<PlanKind, { betrayal: boolean; carriedOut: "never" | "break-at-moment" | "vote" | "final-three"; expires: "deal-end" | "week-roll" }>> = {
  keep: { betrayal: false, carriedOut: "never", expires: "deal-end" },
  "break-at": { betrayal: true, carriedOut: "break-at-moment", expires: "deal-end" },
  flip: { betrayal: true, carriedOut: "vote", expires: "week-roll" },
  "cut-final-three": { betrayal: true, carriedOut: "final-three", expires: "deal-end" },
};
/** The semantics of a plan kind; a kind from an older save that is no longer in the table reads as "keep". */
export const planSemantics = (kind: PlanKind): (typeof PLAN_SEMANTICS)[PlanKind] => PLAN_SEMANTICS[kind] ?? PLAN_SEMANTICS.keep;
/** Is this plan a betrayal (two-faced)? The one test everyone uses. */
export const isBetrayal = (kind: PlanKind): boolean => planSemantics(kind).betrayal;
export interface DealPlan {
  kind: PlanKind;
  moment?: PlanMoment;
}
/** A plan as stored: the plan, when it was made, and (filled in later) how it played out. Append-only: a plan is never rewritten or deleted. */
export interface StoredPlan extends DealPlan {
  madeWeek: number;
  /** Set once, when the plan is carried out or the deal ends otherwise. */
  outcome?: "carried-out" | "kept-anyway" | "overtaken";
}
/** dealId -> holder -> plan. */
export type PlanStore = Record<string, Record<EntityId, StoredPlan>>;

/** The read slice 2 (Overseer B) builds against. No plan = "keep" (today's behaviour). */
export interface PlanSource {
  planOf(dealId: string, holder: EntityId): DealPlan | undefined;
}

/**
 * THE SHARED FAKING DIALS: the one place both deal models read how readily a houseguest fakes a promise. NPC-to-player promises use them here (0178), and
 * NPC-to-NPC pacts use them in `npcDeals.ts` (0170, Overseer B). Uncapped.
 *
 * Retuned 2026-11-17 (Ryne, on the doubled 6%: "That almost seems like a basic assurance as the player that it's legitimate. It should be much higher.
 * Paranoia is a big part of Big Brother."). The targets: about 1 in 3 NPC promises two-faced; about 20% on a first deal; 50% or more for serial dealmakers;
 * faking in every season; a wide spread by person.
 * Readiness is therefore NOT gated on a reason: a cunning type fakes with no motive at all, and a loyal type rarely does even with one.
 */
export const FAKING = {
  /** Readiness to fake, before the person: about the first-deal rate of an average houseguest. */
  readiness: 0.2,
  /** The person spreads it: readiness x (personFloor + personSpan x cunning). Cunning ~0.1 (a loyalist) gives about half the average; ~0.95 (a scheming mastermind) about 1.8x. */
  personFloor: 0.3,
  personSpan: 1.6,
  /** Each deal beyond the first that the holder has made (Ryne's Q1: a prolific dealmaker leans to break). */
  perPastDeal: 0.12,
} as const;

/** The shared part of any faking chance: readiness spread by the person (cunning 0..1), plus the per-past-deal lean. Both deal models add their own situational terms to this. */
export function fakingLean(dealsMade: number, cunning: number): number {
  return FAKING.readiness * (FAKING.personFloor + FAKING.personSpan * clamp01(cunning)) + FAKING.perPastDeal * Math.max(0, dealsMade - 1);
}

export const DEAL_PLANS = {
  /** The situation (the 0142 weighing margin at the moment of agreeing) moves it: a real motive adds, a strong reason to keep subtracts a little (never a gate). */
  slope: 0.3,
  marginFloor: -0.1,
  marginCeil: 1,
  /** The house culture's loyalty and lying dials (`dialMult`, 1 = neutral) move it by this much per unit away from neutral. */
  cultureLean: 0.25,
  /**
   * Fable T3-5 item 2 (Ryne's Q1 names the bond): the holder's bond with the other party moves the chance DIRECTLY, beside the clamped margin. The bond is
   * (trust + affinity) / 2 - threat, -1..1; `bondNeutral` is an ordinary acquaintance (no move); each unit warmer lowers the chance by `bondLean`, each unit
   * colder raises it. A best friend fakes far less than with a distrusted, threatening partner.
   */
  bondLean: 0.4,
  bondNeutral: 0.15,
} as const;

/** The share of two-faced plans of each shape, by deal kind (engine mechanics, never player text). A vote deal is always a flip; the rest split on one roll. */
const PLAN_SHARES = {
  /** safety / target-other / protect-third: this share break at the moment the deal was meant to cover; the rest hold it a week and break it at the next nominations (a safety deal, which ends at
   *  the week roll anyway, turns on them at this week's vote instead). Every shape here is a betrayal (PLAN_SEMANTICS). */
  breakNowShare: 0.5,
  /** final-two: this share cut at the final three, then this share break at a later vote; the rest hold it this week and break it at the next nominations. */
  cutShare: 1 / 3,
  laterBreakShare: 1 / 3,
} as const;
const TWO_FACED_KINDS: ReadonlySet<DealKind> = new Set<DealKind>(["safety", "vote", "final-two", "target-other", "protect-third"]);

export interface PlanInputs {
  kind: DealKind;
  /** The 0142 weighing margin (temptation - cost) at the moment of agreeing; > 0 means tempted. */
  margin: number;
  /** The holder's bond with the other party, (trust + affinity) / 2 - threat, -1..1. Absent = neutral (no move). */
  bond?: number;
  /** Deals this holder has made this season, this one included. */
  dealsMade: number;
  /** 0..1 how cunning (low candor, scheming archetype) the holder is. */
  temperament: number;
  /** The culture dials (`dialMult`, 1 = neutral): loyalty and lying. */
  loyaltyDial: number;
  lyingDial: number;
  /** The week the deal is made, and whether the jury has formed (a break-at moment lands later in a long game). */
  week: number;
}

/** The holder's bond with the other party as the planner reads it: (trust + affinity) / 2 - threat, clamped -1..1. */
export function planBond(e: { trust: number; affinity: number; threat: number }): number {
  return Math.max(-1, Math.min(1, (e.trust + e.affinity) / 2 - e.threat));
}

/** The situational part: the weighing margin (clamped, so a reason to keep never shuts faking off), the bond (direct) and the culture. */
export function planLean(i: PlanInputs): number {
  const culture = DEAL_PLANS.cultureLean * ((i.lyingDial - 1) - (i.loyaltyDial - 1));
  const bond = i.bond === undefined ? 0 : -DEAL_PLANS.bondLean * (Math.max(-1, Math.min(1, i.bond)) - DEAL_PLANS.bondNeutral);
  return DEAL_PLANS.slope * Math.max(DEAL_PLANS.marginFloor, Math.min(DEAL_PLANS.marginCeil, i.margin)) + bond + culture;
}

/** P(the holder is two-faced about this deal): the shared faking lean (person + past deals) plus the situation. No ceiling below certainty. */
export function twoFacedChance(i: PlanInputs): number {
  return clamp01(fakingLean(i.dealsMade, i.temperament) + planLean(i));
}

/** Decide the plan: `rolls.twoFaced` decides keep vs two-faced, `rolls.which` picks among the plans the kind allows. Deterministic in its inputs. */
export function decidePlan(i: PlanInputs, rolls: { twoFaced: number; which: number }): DealPlan {
  if (!TWO_FACED_KINDS.has(i.kind) || !(rolls.twoFaced < twoFacedChance(i))) return { kind: "keep" };
  const r = clamp01(rolls.which);
  if (i.kind === "vote") return { kind: "flip", moment: { week: i.week, at: "vote" } };
  if (i.kind === "final-two") {
    if (r < PLAN_SHARES.cutShare) return { kind: "cut-final-three" };
    if (r < PLAN_SHARES.cutShare + PLAN_SHARES.laterBreakShare) return { kind: "break-at", moment: { week: i.week + 1 + Math.floor(((r - PLAN_SHARES.cutShare) / PLAN_SHARES.laterBreakShare) * 3), at: "vote" } };
    return { kind: "break-at", moment: { week: i.week + 1, at: "nominations" } }; // holds it this week, breaks it at the next nominations
  }
  if (r < PLAN_SHARES.breakNowShare) return { kind: "break-at", moment: { week: i.week, at: "nominations" } };
  // ORW-601 (Fable T3-5): a safety deal already ends at the week roll, so "keep it this week only" would be the same as keeping it. Its other two-faced shape is to
  // turn on them at this week's vote instead (if they end up on the block).
  if (i.kind === "safety") return { kind: "flip", moment: { week: i.week, at: "vote" } };
  return { kind: "break-at", moment: { week: i.week + 1, at: "nominations" } }; // holds it this week, breaks it at the next nominations
}

/** Record a plan (append-only: an existing plan for the same deal and holder is never replaced). */
export function recordPlan(store: PlanStore, dealId: string, holder: EntityId, plan: DealPlan, madeWeek: number): boolean {
  const byHolder = (store[dealId] ??= {});
  if (byHolder[holder]) return false;
  byHolder[holder] = { ...plan, madeWeek };
  return true;
}

/** The plan source over a store. */
export function planSourceOf(store: () => PlanStore | undefined): PlanSource {
  return { planOf: (dealId, holder) => store()?.[dealId]?.[holder] };
}

/** ORW-586 slice 5: the plan key for an open-ledger promise - its own namespace, so no deal-id reader ever matches it. */
export const ledgerPlanKey = (entryId: string): string => `ledger:${entryId}`;
export const isLedgerPlanKey = (key: string): boolean => key.startsWith("ledger:");

/** Is a moment due now? (`at` order: nominations < veto < vote; a later week is always due.) */
export function momentDue(m: PlanMoment, week: number, now: "nominations" | "veto" | "vote" | "other"): boolean {
  if (week > m.week) return true;
  if (week < m.week || now === "other") return false;
  const order = { nominations: 0, veto: 1, vote: 2 } as const;
  return order[now] >= order[m.at];
}

/** The retrospective view of the season's deals (0178; Ryne's Q2): each NPC's secret plan beside how it went, and the player's own promise record. Engine enums and
 *  the player's own recorded words only: the words a player reads about a plan are authored live by the narrator from this, never from a fixed menu. */
export interface DealPlanRetro {
  secretPlans: Array<{ holder: { id: EntityId; name: string }; with: { id: EntityId; name: string }; dealKind: DealKind; madeWeek: number; plan: PlanKind; outcome: StoredPlan["outcome"] | "pending" }>;
  /**
   * The player's ONE promise record (ORW-602): a deal the player promised in, a promise they said or typed (kept or broken, who it was made to, and when), and a casual assurance. Each promise is listed once: a ledger
   * line that only mirrors a deal is dropped, and a line the houseguest made is never the player's. `judgedBy` says who settled `status`: the engine (a deal, a typed term, an assurance) or the narrator (a free-text
   * line, a model's reading). `what` is the engine's typed key for a typed term; `about` is who it concerned when that was not the one it was made to. The words are the player's own or the engine's public terms; the narrator voices the rest.
   */
  yourPromises: Array<{
    to: Array<{ id: EntityId; name: string }>; source: "deal" | "said" | "assured"; kind: string; text: string; status: string; week?: number; day?: number;
    judgedBy: "engine" | "narrator"; what?: string; about?: { id: EntityId; name: string };
  }>;
}

/** The ledger-line shape the player's promise record reads (a subset of `OpenLedgerEntry`). */
export interface PromiseRecordLine {
  speaker: string; addressedTo: readonly string[]; kind: string; text: string; status: string; day?: number; dealId?: string;
  term?: { by: string; to: string; what: string; subject?: string; week?: number }; about?: string;
}
/** A player-made casual assurance (already filtered by `uncoveredPlayerAssurances`). */
export interface PromiseRecordAssurance { to: EntityId; kind: string; week: number; status: string }

/** Build it, read-only (the retrospective's crown gate is the caller's). Every plan and every player promise is listed once: nothing is dropped. `commitmentKind` says whether a free-text line kind is commitment-like (the ledger's own word list). */
export function buildDealPlanRetro(
  plans: PlanStore | undefined,
  deals: ReadonlyArray<{ id: string; parties: readonly EntityId[]; kind: DealKind; terms: string; status: string; madeWeek?: number; condition: { promisors: readonly EntityId[] } }>,
  ledger: ReadonlyArray<PromiseRecordLine>,
  player: EntityId,
  nameOf: (id: EntityId) => string,
  assurances: ReadonlyArray<PromiseRecordAssurance> = [],
  commitmentKind: (kind: string) => boolean = (k) => /promise|deal|pact|vow|swear|pledge|oath|agreement|commitment/i.test(k),
): DealPlanRetro | undefined {
  const ref = (id: EntityId) => ({ id, name: nameOf(id) });
  const secretPlans: DealPlanRetro["secretPlans"] = [];
  for (const d of deals) {
    for (const [holder, p] of Object.entries(plans?.[d.id] ?? {})) {
      const other = d.parties.find((x) => x !== holder) ?? holder;
      secretPlans.push({ holder: ref(holder), with: ref(other), dealKind: d.kind, madeWeek: p.madeWeek, plan: p.kind, outcome: p.outcome ?? "pending" });
    }
  }
  const yourPromises: DealPlanRetro["yourPromises"] = [];
  const dealIds = new Set(deals.map((d) => d.id));
  for (const d of deals) {
    if (!d.condition.promisors.includes(player)) continue;
    yourPromises.push({ to: d.parties.filter((x) => x !== player).map(ref), source: "deal", kind: d.kind, text: d.terms, status: d.status, judgedBy: "engine", ...(d.madeWeek !== undefined ? { week: d.madeWeek } : {}) });
  }
  for (const e of ledger) {
    if (e.speaker !== player) continue;
    if (e.dealId !== undefined && dealIds.has(e.dealId)) continue; // the deal's own row above is the record (a deal only the houseguest promised in is not the player's)
    const typed = e.term !== undefined && e.term.by === player;
    if (!typed && !(commitmentKind(e.kind) && !e.about)) continue;
    const subject = e.term?.subject && e.term.subject !== e.term.to ? e.term.subject : undefined;
    yourPromises.push({
      to: e.addressedTo.filter((x) => x !== player).map(ref), source: "said", kind: e.kind, text: e.text, status: e.status, judgedBy: typed && e.term!.what !== "share-info" ? "engine" : "narrator",
      ...(e.term?.week !== undefined ? { week: e.term.week } : {}), ...(e.day !== undefined ? { day: e.day } : {}),
      ...(typed ? { what: e.term!.what } : {}), ...(subject ? { about: ref(subject as EntityId) } : {}),
    });
  }
  for (const a of assurances) yourPromises.push({ to: [ref(a.to)], source: "assured", kind: a.kind, text: "", status: a.status, week: a.week, judgedBy: "engine" });
  return secretPlans.length || yourPromises.length ? { secretPlans, yourPromises } : undefined;
}
