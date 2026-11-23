/**
 * ORW-771 - the sealed VOTE BEAT of a played eviction vote. A Continue press through the ballot reading carries a Vault-free fact block so the narrator can voice a short beat:
 * who walks into the Diary Room, who comes back out, the room around them, and on the result press that the tally is now read with names.
 *
 * E12 is the whole point: the beat names NO ballot content. The walk order below is a pure hash of (week, voter id) and takes NO input from the seeded ballot reveal order or from
 * who voted for whom, so naming the walker of a press tells the player nothing about the ballot read on that press. Presentation only: no rng, no clock, no state written.
 */
import type { EntityId } from "../domain/ids";

/** A stable 32-bit FNV-1a hash of a string (pure; no rng). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The order the voters walk to the Diary Room: ordered by a hash of the week and the voter's id, ties by id. It is NOT the ballot reveal order and reads neither the votes nor
 * the reveal order, so the walker named for a press is independent of the ballot read on that press.
 */
export function diaryWalkOrder(voters: readonly EntityId[], week: number): EntityId[] {
  return [...voters].sort((a, b) => {
    const d = fnv1a(`${week}:${a}`) - fnv1a(`${week}:${b}`);
    return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Who is walking this press. `press` is the 1-based count of ballot presses made so far (the number of ballots read). The walker is the `press`-th in the walk order and the
 * one before them is coming back out; a press past the walkers (the player's own seat, which the engine never walks for them) names no walker.
 */
export function walkersForPress(walkOrder: readonly EntityId[], press: number): { into?: EntityId; back?: EntityId } {
  const into = press >= 1 && press <= walkOrder.length ? walkOrder[press - 1] : undefined;
  const back = press >= 2 && press - 1 <= walkOrder.length ? walkOrder[press - 2] : undefined;
  return { ...(into ? { into } : {}), ...(back ? { back } : {}) };
}
