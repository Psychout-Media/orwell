/**
 * A9 - PREMIERE ENTRANCES + THE CHAMPAGNE TOAST (`ORWELL_PREMIERE_ENTRANCES`, default OFF).
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

/** Toast speakers are released this many per `advanceGame`. */
export const TOAST_BATCH = 4;

/** A small bounded FIRST READ (witness -> arriver), public-facets-only, seeded side stream. */
export const PREMIERE_FIRST_READ: { affinity: number; trust: number } = { affinity: 0.02, trust: 0.01 };

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

/** Host first, then the entrance order (the player's slot stays in the list as a marker). */
export function toastSpeakers(order: readonly string[]): string[] {
  return ["host", ...order];
}
