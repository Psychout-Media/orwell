import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";
import { FAVOR } from "./favorConstants";

/**
 * 0171 / Theme 3 slice 3 - COUNTERS. A counter is the engine-decided output of weighing an offer against the houseguest's WEEKLY GOAL: what they ask for instead (a rival goes up; a vote), the round
 * number, and whether they accept, counter or refuse. Pure: no I/O, no Vault handle, no rng of its own - the caller passes two rolls in [0,1) from the seeded side stream
 * `${seed}:favors:${deal}:${week}:${round}` (see `counterStreamKey`), so a negotiation never touches a shared stream. The narrator is handed the result as FACTS (who, what is asked, the round) and voices it;
 * it never decides it. Rounds are capped by `FAVOR.maxCounterRounds`: past the cap a side only settles or lets it fall through.
 */
/** What a counter asks for instead: a rival goes up (`target`), someone they keep is held safe (`protect`), or a vote. Engine keys; the words are authored live by the narrator from these facts. */
export type CounterAsk = { kind: "target"; target: EntityId } | { kind: "protect"; target: EntityId } | { kind: "vote" };
export type CounterVerdict = "accept" | "counter" | "refuse";

export interface CounterSide {
  id: EntityId;
  /** The rival this houseguest wants gone this week (the strongest `goalPull` toward out), if they have one. */
  goalTarget?: EntityId;
  /** How hard that goal pulls, on the threat-read scale (signed pulls below 0 never ask). */
  goalPull: number;
  /** The houseguest they most want KEPT this week (a protect goal), and how hard it pulls (the size of the negative pull). Optional. */
  protectTarget?: EntityId;
  protectPull?: number;
  /** Their bond with the other side, 0..1. */
  bond: number;
  /** How this houseguest's own goal pulls on any named target (+ = wants them out, - = keeps them): what they would concede when asked to put someone up. */
  pullOn(target: EntityId): number;
}

export interface CounterRolls { counter: number; settle: number }

export interface CounterRound {
  round: number;
  by: EntityId;
  verdict: CounterVerdict;
  /** Present only on a counter: what they ask for instead. */
  ask?: CounterAsk;
}

/** The seeded side-stream key for one round of one negotiation (never a shared stream). */
export function counterStreamKey(seed: number | string, dealId: string, week: number, round: number): string {
  return `${seed}:favors:${dealId}:${week}:${round}`;
}

/**
 * One side weighs what is in front of it. `incoming` is the ask the other side just made (none on round 1: the offer itself); `asked` is every target already asked in this negotiation, so a
 * side never asks for the same thing twice. Round numbers start at 1; a round past the cap settles or falls through, it never counters.
 */
export function weighCounter(i: { round: number; side: CounterSide; incoming?: CounterAsk; asked?: readonly EntityId[]; rolls: CounterRolls }): CounterRound {
  const { side, round, incoming } = i;
  const settleP = clamp01(FAVOR.settleBase + FAVOR.settleBondSlope * clamp01(side.bond));
  const settle = (): CounterRound => ({ round, by: side.id, verdict: i.rolls.settle < settleP ? "accept" : "refuse" });
  const already = new Set(i.asked ?? []);
  // The goals that could be asked for, strongest first, skipping any target already asked in this negotiation.
  const goals: Array<{ ask: CounterAsk; pull: number }> = [];
  if (side.goalTarget !== undefined && side.goalPull > FAVOR.askFloor && !already.has(side.goalTarget)) goals.push({ ask: { kind: "target", target: side.goalTarget }, pull: side.goalPull });
  if (side.protectTarget !== undefined && (side.protectPull ?? 0) > FAVOR.askFloor && !already.has(side.protectTarget)) goals.push({ ask: { kind: "protect", target: side.protectTarget }, pull: side.protectPull ?? 0 });
  goals.sort((a, b) => b.pull - a.pull);
  const top = goals[0];
  const counter = (): CounterRound | undefined => {
    if (round >= FAVOR.maxCounterRounds || !top) return undefined;
    if (i.rolls.counter >= clamp01(FAVOR.counterBase + FAVOR.counterSlope * (top.pull - FAVOR.askFloor))) return undefined;
    return { round, by: side.id, verdict: "counter", ask: top.ask };
  };
  if (incoming?.kind === "target") {
    // An ask to put someone up: conceded when they would not mind it, otherwise countered back (their own goal) or refused.
    if (side.pullOn(incoming.target) >= FAVOR.concedePull) return { round, by: side.id, verdict: "accept" };
    return counter() ?? { round, by: side.id, verdict: "refuse" };
  }
  if (incoming?.kind === "protect") {
    // An ask to hold someone safe: conceded when they do not want that person out.
    if (side.pullOn(incoming.target) <= FAVOR.concedePull) return { round, by: side.id, verdict: "accept" };
    return counter() ?? { round, by: side.id, verdict: "refuse" };
  }
  if (incoming?.kind === "vote") return { round, by: side.id, verdict: "accept" };
  // The bare offer: a houseguest with a goal this week counters for it, otherwise it is taken or turned down on the bond.
  return counter() ?? settle();
}

export interface Negotiation {
  rounds: CounterRound[];
  /** Did it settle on terms both took (the last round is an accept)? */
  settled: boolean;
  /** The asks the responder left standing when it settled: what the offerer agreed to. */
  agreed: CounterAsk[];
}

/**
 * Run a whole negotiation between an offerer and a responder: round 1 the responder weighs the bare offer; each counter is weighed by the other side, back and forth, until someone accepts or refuses or the
 * cap is reached (the last allowed round only settles). `rollsFor(round)` supplies that round's two seeded rolls. NPC-to-NPC deals (slice 2) wire straight in here.
 */
export function negotiate(offerer: CounterSide, responder: CounterSide, rollsFor: (round: number) => CounterRolls): Negotiation {
  const rounds: CounterRound[] = [];
  const asked: EntityId[] = [];
  const agreed: CounterAsk[] = [];
  let incoming: CounterAsk | undefined;
  let side = responder;
  for (let round = 1; round <= FAVOR.maxCounterRounds; round++) {
    const r = weighCounter({ round, side, ...(incoming ? { incoming } : {}), asked, rolls: rollsFor(round) });
    rounds.push(r);
    if (r.verdict === "accept") { if (incoming) agreed.push(incoming); return { rounds, settled: true, agreed }; }
    if (r.verdict === "refuse") return { rounds, settled: false, agreed };
    incoming = r.ask!;
    if (incoming.kind === "target" || incoming.kind === "protect") asked.push(incoming.target);
    side = side === responder ? offerer : responder;
  }
  return { rounds, settled: false, agreed };
}
