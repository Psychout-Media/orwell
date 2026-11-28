/**
 * A9 - PREMIERE ENTRANCES + THE CHAMPAGNE TOAST (`ORWELL_PREMIERE_ENTRANCES`, default ON; `=0` opts out).
 *
 * Pure (no I/O). The premiere's opening is staged as sixteen INDIVIDUAL entrances (one houseguest per
 * `advanceGame`, the player's own slot among them) followed by the toast. The ORDER is a SEEDED SIDE
 * stream (`hashSeed(seed + ":premiere-entrances")`) - it never touches the shared season rng, so the
 * entrance draw cannot perturb any seeded outcome. Vault-free by construction: ids only.
 */
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed } from "./characterFactory";

export type PremiereEntranceStage = "entrances" | "toast" | "done";

/** The persisted (optional) live-state shape. Absent when the flag is off. */
export interface PremiereEntranceState {
  order: string[];
  playerPos: number;
  /** Count entered so far, INCLUDING the player once they have walked in. Next arrival = `order[arrived]`. */
  arrived: number;
  stage: PremiereEntranceStage;
  /** Toast speakers already released ("host" or an id; the player's slot is a marker the engine never fills). */
  spoke: string[];
}

/**
 * Toast speakers are released this many per `advanceGame`. ORW-1131 (Ryne, 2026-11-28: "each turn is like one person going ... people responding and kind of playing off of it"): ONE toast per turn, the
 * room reacting to it, instead of two (and, under ORW-997's flow, up to eight) two-line toasts in a row. The host opens together with the first speaker; the player's own slot is always released alone.
 */
export const TOAST_BATCH = 1;

/** A small bounded FIRST READ (witness -> arriver), public-facets-only, seeded side stream. */
export const PREMIERE_FIRST_READ: { affinity: number; trust: number } = { affinity: 0.02, trust: 0.01 };

/**
 * ORW-653 / feature 0205 - MEET THE CAST. At the champagne circle each houseguest is officially introduced and forms a FIRST IMPRESSION of the player: an engine-decided, hidden, small
 * and bounded fold (NPC -> player) whose sign and size come from a keyed side stream, the gap between the two public ages, and the houseguest's own social aptitude. The engine hands the
 * narrator only the houseguest's visible manner as a plain word (never a number); the player forms their own read. Pure; draws nothing from the season rng.
 */
export const MEET_FIRST_IMPRESSION: { affinity: number; trust: number } = { affinity: 0.03, trust: 0.015 };

/** How one houseguest takes to the player on meeting, in [-1, 1]. Deterministic per (seed, houseguest). */
export function firstImpressionLean(seed: number | string, npcId: string, npcAge: number | undefined, playerAge: number | undefined, npcSocial: number | undefined): number {
  const u = new SeededRandom(hashSeed(`${seed}:meet-impression:${npcId}`)).next();
  const stream = u * 2 - 1;
  const ageFit = npcAge !== undefined && playerAge !== undefined ? 1 - Math.min(1, Math.abs(npcAge - playerAge) / 30) * 2 : 0;
  const social = npcSocial !== undefined ? Math.max(-1, Math.min(1, (npcSocial - 50) / 50)) : 0; // a socially gifted houseguest reads people kindly more often
  return Math.max(-1, Math.min(1, 0.6 * stream + 0.25 * ageFit + 0.15 * social));
}

/** The visible manner a lean shows, as a plain engine key the narrator renders as conduct. */
export type MeetManner = "drawn-to" | "even" | "guarded";
export function meetMannerOf(lean: number): MeetManner {
  return lean >= 0.25 ? "drawn-to" : lean <= -0.25 ? "guarded" : "even";
}

export function planEntrances(
  ids16: readonly string[],
  playerId: string,
  seed: number | string,
): { order: string[]; playerPos: number } {
  const order = [...ids16];
  const rng = new SeededRandom(hashSeed(`${seed}:premiere-entrances`));
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return { order, playerPos: order.indexOf(playerId) };
}

/**
 * ORW-1130 / ORW-1129 / ORW-1131 - the next toast release, from the full speaker list and the done list. Pure. Speakers already done (released, or recorded as voiced by the narration) are never released again;
 * the order is the entrance order. The host opens together with the first speaker; a release never runs past the PLAYER'S slot (it ends just before it, and the slot itself is released alone), so the circle
 * stops and waits for the player.
 */
export function nextToastRelease(all: readonly string[], spoke: readonly string[], playerId: string, size: number): string[] {
  const done = new Set(spoke);
  const next = all.filter((x) => !done.has(x));
  if (next.length === 0) return [];
  if (next[0] === playerId) return [playerId];
  const want = Math.max(1, Math.floor(size)) + (next[0] === "host" ? 1 : 0);
  const out: string[] = [];
  for (const x of next) {
    if (out.length >= want) break;
    if (x === playerId) break;
    out.push(x);
  }
  return out;
}

/** Host first, then the entrance order (the player's slot stays in the list as a marker). */
export function toastSpeakers(order: readonly string[]): string[] {
  return ["host", ...order];
}
