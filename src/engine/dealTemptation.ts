import type { DealKind } from "../domain/deal";
import { clamp01Raw as clamp01 } from "../domain/num";
import { DEAL_TEMPTATION as T } from "./dealTemptationConstants";

/**
 * 0142 idea 4 - NPCs WEIGH BREAKING A DEAL. Pure: no rng, no I/O, no Vault handle. The adapter reads the NPC's own state, calls `weighDealBreak`, then draws ONE roll from
 * a side stream and feeds it to `decideDealBreak`. The engine decides; the narrator is never told (a quiet break is not narrated as content).
 *
 *   temptation = kindScale * ( threatWeight*max(0,threat-floor) + lowBondWeight*max(0,mid-bond) + pushWeight*ownPush + agendaWeight*max(0,agendaPull) + endgame )
 *   cost       = credibilityWeight*credibility + reliableWeight*reliableShare + bondWeight*bond + loyaltyWeight*loyalty      (the price of being known as a liar)
 *   margin     = temptation - cost
 *   P(break)   = margin > 0 ? min(breakCap, breakSlope*margin) : 0
 *   P(renegotiate) = margin <= 0 && temptation >= renegotiateFloor ? min(renegotiateCap, renegotiateSlope*(temptation - renegotiateFloor + epsilon)) : 0
 */
export interface DealBreakInputs {
  kind: DealKind;
  /** The NPC's read of the player (edge NPC->player), 0..1 each. */
  threat: number; trust: number; affinity: number;
  /** The NPC's own standing plan against the player (campaign / drive), >= 0. */
  ownPush: number;
  /** The agenda's pull on the player (`goalPull.value`, + = out). 0 when the NPC has no agenda. */
  agendaPull: number;
  /** The NPC's loyalty, 0..1. */
  loyalty: number;
  /** Mean credibility (B48) the living NPCs grant this NPC, 0..1 (1 = never caught lying). */
  credibility: number;
  /** Share of living NPCs that credit this NPC as reliable (the diffusing reputation belief), 0..1. */
  reliableShare: number;
  /** Endgame pressure: 0 none, 1 jury started, 2 final five. */
  endgame: 0 | 1 | 2;
}

export interface DealBreakTerms {
  /** Signed contributions to temptation (before kind scale). */
  threat: number; lowBond: number; push: number; agenda: number; endgame: number;
  /** Cost parts. */
  costCredibility: number; costReliable: number; costBond: number; costLoyalty: number;
}

export interface DealBreakWeighing {
  temptation: number; cost: number; margin: number; pBreak: number; pRenegotiate: number; terms: DealBreakTerms;
}

export type DealBreakVerdict = "keep" | "break" | "renegotiate";

/** The kinds the weighing covers (the player-party promises a houseguest could walk back). */
export function isWeighableKind(kind: DealKind): boolean {
  return kind === "safety" || kind === "vote" || kind === "final-two" || kind === "target-other";
}

export function weighDealBreak(i: DealBreakInputs): DealBreakWeighing {
  const bond = clamp01((i.trust + i.affinity) / 2);
  const scale = T.kindScale[i.kind] ?? 1;
  const terms: DealBreakTerms = {
    threat: T.threatWeight * Math.max(0, i.threat - T.threatFloor),
    lowBond: T.lowBondWeight * Math.max(0, T.bondMid - bond),
    push: T.pushWeight * Math.max(0, i.ownPush),
    agenda: T.agendaWeight * Math.max(0, i.agendaPull),
    endgame: i.endgame === 2 ? T.endgameFinalFive : i.endgame === 1 ? T.endgameJury : 0,
    costCredibility: T.credibilityWeight * clamp01(i.credibility),
    costReliable: T.reliableWeight * clamp01(i.reliableShare),
    costBond: T.bondWeight * bond,
    costLoyalty: T.loyaltyWeight * clamp01(i.loyalty),
  };
  const temptation = scale * (terms.threat + terms.lowBond + terms.push + terms.agenda + terms.endgame);
  const cost = terms.costCredibility + terms.costReliable + terms.costBond + terms.costLoyalty;
  const margin = temptation - cost;
  const pBreak = margin > 0 ? Math.min(T.breakCap, T.breakSlope * margin) : 0;
  const pRenegotiate = margin <= 0 && temptation >= T.renegotiateFloor
    ? Math.min(T.renegotiateCap, T.renegotiateSlope * (temptation - T.renegotiateFloor + 0.05)) : 0;
  return { temptation, cost, margin, pBreak, pRenegotiate, terms };
}

/** ONE roll in [0,1) picks the verdict: the low end breaks, the next band renegotiates, the rest keeps. */
export function decideDealBreak(w: DealBreakWeighing, roll: number): DealBreakVerdict {
  if (roll < w.pBreak) return "break";
  if (w.pRenegotiate > 0 && roll < w.pRenegotiate) return "renegotiate";
  return "keep";
}

/** The lighter term a renegotiating NPC asks for in place of the deal. Only a week-scoped vote promise is lighter than the others; a `vote` deal has nothing lighter. */
export function renegotiatedKind(kind: DealKind): DealKind | undefined {
  return kind === "safety" || kind === "final-two" || kind === "target-other" ? "vote" : undefined;
}
