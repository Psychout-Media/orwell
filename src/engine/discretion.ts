import type { EntityId } from "../domain/ids";

/**
 * ORW-1171 - DISCRETION. A houseguest does not air a private alliance, deal or secret in front of people who are not in on it. The ENGINE decides this (CLAUDE.md, ADR 0003 and 0005: the engine
 * decides game choices, the narrator voices them); the narrator is handed the call and never makes it.
 *
 * For every private tie (a named alliance the player knows of, a standing deal the player is a party to, an open pitch) with a houseguest in it IN EARSHOT of the player's scene:
 *   - everyone in earshot is in on it (or is the person being recruited)  => `open`: it may be raised aloud;
 *   - otherwise the houseguests in on it DEFER: "later", "find me tonight", or they ask for a word alone;
 *   - rarely, and by character (their style's leakiness, their nerves), one SLIPS: an engine event. The people in earshot who were not in on it then genuinely learn it (the caller applies it).
 * Pure and deterministic: no I/O, no rng handle. The caller supplies ONE roll per (speaker, tie, day) from its own keyed stream, so a rebuilt prompt in the same beat gives the same call.
 *
 * Deliberately separate from the witness-set / fold-participant code (ORW-1167): "earshot" here is only the set of people the narrator is voicing in the player's room, for deciding WHO MAY SAY WHAT.
 */
export type DiscretionCall = "open" | "defer" | "slip";
export type TieKind = "alliance" | "deal" | "pitch";

export interface PrivateTie {
  id: string;
  kind: TieKind;
  /** The name or terms the narrator can point at ("the Orchard alliance", "a safety deal"). Public to the player already. */
  label: string;
  /** Everyone who is in on it, the player included when they are a member or the one being recruited. */
  insiders: readonly EntityId[];
}

export interface TieScene {
  tie: PrivateTie;
  /** Houseguests (never the player) in earshot who are in on it: the ones who might raise it. */
  speakers: EntityId[];
  /** Everyone in earshot who is NOT in on it (the player is never listed when they are in on it). */
  outsiders: EntityId[];
}

/** Which ties have an NPC insider in earshot, with who in earshot is and is not in on each. `earshot` is the NPCs in the player's room; the player is always also there. */
export function tieScenes(earshot: readonly EntityId[], player: EntityId, ties: readonly PrivateTie[]): TieScene[] {
  const out: TieScene[] = [];
  const here = [...earshot, player];
  for (const tie of ties) {
    const speakers = earshot.filter((e) => tie.insiders.includes(e));
    if (!speakers.length) continue;
    const outsiders = here.filter((e) => !tie.insiders.includes(e));
    out.push({ tie, speakers, outsiders });
  }
  return out;
}

// Ryne's ruling, 2026-11-28 ("Lower: 1-10%"): a slip is rare enough that a leaked deal feels like a real event. Odds run from 1% (the guarded) to at most 10% (the hottest, leakiest),
// per speaker, per tie, per in-game day; no per-houseguest floor (Valerie's style and volatility place her, like everyone else).
export const DISCRETION = {
  /** Base chance a loose-lipped-by-nothing houseguest lets a private thing out in front of people not in on it, once a day per (speaker, tie). Rare on purpose. */
  slipBase: 0.01,
  /** Added per point of leakiness (the style table, 0..~0.9). */
  perLeak: 0.05,
  /** Added per point of volatility (0..1): a houseguest who runs hot or messy. */
  perVolatility: 0.03,
  /** Each person beyond the first who is not in on it raises the stakes of a slip, not its odds; the cap bounds the whole. */
  maxSlip: 0.1,
} as const;

export interface DiscretionTraits {
  /** 0..1+, the houseguest's style leakiness (the same table the disclosure engine reads). */
  leakiness: number;
  /** 0..1, how easily they run hot. */
  volatility: number;
}

/** The bounded chance of a slip for one houseguest in front of people not in on a tie. Exposed so a test can prove monotonicity without sampling. */
export function slipOdds(t: DiscretionTraits): number {
  const p = DISCRETION.slipBase + DISCRETION.perLeak * Math.max(0, t.leakiness) + DISCRETION.perVolatility * Math.max(0, Math.min(1, t.volatility));
  return Math.max(0, Math.min(DISCRETION.maxSlip, p));
}

/** `open` with nobody outside; otherwise `slip` when the roll (0..1) falls under the odds, else `defer`. */
export function discretionCall(t: DiscretionTraits, outsiders: number, roll: number): DiscretionCall {
  if (outsiders <= 0) return "open";
  return roll < slipOdds(t) ? "slip" : "defer";
}

/** What the narrator is told for one tie in the scene (names, never ids). */
export interface DiscretionTieView {
  kind: TieKind;
  label: string;
  inOn: string[];
  notInOn: string[];
  call: DiscretionCall;
  /** Present on a `slip`: the houseguest who lets it out this turn. */
  slipBy?: string;
}

/** The narrator's per-turn discretion facts. Present only when a tie has a houseguest in earshot, or two or more houseguests are in earshot of the player (a pitch made aloud). */
export interface DiscretionView {
  ties: DiscretionTieView[];
  /** Houseguests in earshot of the player right now (names): who a pitch made aloud would be heard by. */
  crowd: string[];
}

/** A slip as the engine records it (saved): who let it out, which tie, who learned it, and the beat. */
export interface SlipRecord {
  tie: string;
  by: string;
  learnedBy: string[];
  day: number;
  beat: number;
}
