/**
 * ORW-473 (Kevin with Ryne, 2026-11-15: "That should be dynamic based on character sheets involved"): the player walks into a room where two houseguests are in a private talk. Each one's reaction is chosen from THEIR OWN
 * sheet, not one rule for everyone: how candid their archetype and style make them, how they feel about the player and about the one they are talking to, and how much the talk has to hide. Pure and deterministic (the caller
 * supplies a small seeded jitter): no rng, no Vault, and the result never carries what the talk was about.
 */
import { ACTIONS as HOUSE_LIFE_ACTIONS, type ActionKind } from "./houseLife";

import { clamp01 } from "../domain/num";

/** A private talk can be walked in on only while it is recent in game time: the hour it happened in or the one after (two game hours at most); after that the pair has moved on to something else. */
export const WALK_IN_MAX_HOURS = 2;
/** How many already-walked-in talks are remembered (bounded). */
export const WALK_IN_DONE_CAP = 8;

export type WalkInReaction = "goes-quiet" | "carries-on-guarded" | "moves-the-talk" | "pulls-the-player-in";
export const WALK_IN_REACTIONS: readonly WalkInReaction[] = ["goes-quiet", "carries-on-guarded", "moves-the-talk", "pulls-the-player-in"];

export interface WalkInSheet {
  /** 0..1, from the archetype and strategy style (the same candor the mood-cause telling uses). */
  candor: number;
  /** How this houseguest feels about the PLAYER, 0..1. */
  affinityToPlayer: number;
  /** How this houseguest feels about the one they are talking to, 0..1. */
  affinityToOther: number;
  /** How much the talk has to hide (the kind of talk, whether it was truthful), 0..1. */
  stakes: number;
}


/** The action families that are a private strategy talk (the player's walking in matters); a cook-out or a nap is not. */
const PRIVATE_FAMILIES: ReadonlySet<string> = new Set(["alliances", "attack"]);
/** Is this house-life action a private talk between two people? (Spoken, with a partner, and strategic.) */
export function isPrivateTalk(action: string): boolean {
  const spec = (HOUSE_LIFE_ACTIONS as Record<string, { family: string; speech: boolean; partners: { min: number } } | undefined>)[action as ActionKind];
  return spec !== undefined && spec.speech && spec.partners.min >= 1 && (PRIVATE_FAMILIES.has(spec.family) || action === "gossip");
}

/** How much a talk of this kind has to hide, 0..1 (an attack on someone hides more than an alliance check-in). */
export function talkStakes(action: string, truthful: boolean): number {
  const spec = (HOUSE_LIFE_ACTIONS as Record<string, { family: string } | undefined>)[action as ActionKind];
  const base = spec?.family === "attack" ? 0.85 : spec?.family === "alliances" ? 0.6 : 0.4;
  return clamp01(base + (truthful ? 0 : 0.1));
}

/**
 * The reaction with the highest score for THIS sheet. The weights are plain and named so a reaction is traceable to the sheet: a houseguest who likes the player and has little to hide pulls the player in; one with a lot to hide
 * and little candor moves the talk; a candid one with some trust in the player carries on in guarded terms; one who does not warm to the player goes quiet. `jitter` (0..0.08, seeded) only separates near ties.
 */
export function walkInReaction(s: WalkInSheet, jitter = 0): WalkInReaction {
  const c = clamp01(s.candor), ap = clamp01(s.affinityToPlayer), ao = clamp01(s.affinityToOther);
  const hide = clamp01(s.stakes) * (1 - 0.5 * c); // a candid houseguest hides less of it
  const scores: Record<WalkInReaction, number> = {
    "pulls-the-player-in": 1.0 * ap + 0.5 * c - 0.8 * hide,
    "carries-on-guarded": 0.6 * c + 0.3 * ap + 0.2 * hide + 0.2 * ao,
    "moves-the-talk": 0.9 * hide * (1 - c) + 0.3 * (1 - ap),
    "goes-quiet": 0.5 * (1 - ap) + 0.4 * (1 - c) * (1 - hide) + jitter,
  };
  let best: WalkInReaction = "goes-quiet";
  for (const k of WALK_IN_REACTIONS) if (scores[k] > scores[best]) best = k;
  return best;
}

/** What the narrator is told to voice for a reaction: the manner only, never the subject of the talk. */
export function walkInLine(reaction: WalkInReaction): string {
  switch (reaction) {
    case "goes-quiet": return "breaks off and goes quiet, changing the subject";
    case "carries-on-guarded": return "carries on, but in guarded terms that give nothing away";
    case "moves-the-talk": return "makes an excuse and moves the talk somewhere else";
    default: return "welcomes the player in and pulls them into the conversation";
  }
}
