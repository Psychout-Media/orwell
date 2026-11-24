import { PLAYER, type EntityId } from "../domain/ids";
import type { GenderPresentation, Orientation } from "./diversityConstants";
import { canBeDrawnTo, playerShowmance } from "./attraction";

/**
 * THEME A, slice A4 (ORW-661, feature 0207) - YOU AND A SHOWMANCE. The PLAYER is in a showmance only by the player's OWN acts: the scenes the player started and filed as a showmance
 * (the ORW-609 recorded-scene path: a conversation event whose `interactionKind` is `showmance` and whose initiator is the player), answered by a houseguest who is drawn to the player
 * by the foundation's own rule (`canBeDrawnTo`). The engine NEVER decides the player is in one: a scene a houseguest started at the player, a house-life scene the player merely watched,
 * and a bond that grew from either never count. Pure, no rng, no I/O, no Vault; a derived read, never stored.
 *
 * THE PLAYER'S GENDER AND ORIENTATION ARE NEVER ASSUMED. Only what the player has set is read: their gender presentation, when they recorded one (`undefined` => nobody is drawn to the
 * player, `canBeDrawnTo`'s own rule). The player's orientation is never modelled and never needed: what the player does is theirs. No pronoun or gender word is produced here.
 */
export interface SceneLike {
  type: string;
  initiator: EntityId;
  interactionKind?: string;
  witnessSet: readonly EntityId[];
}

/** How many showmance scenes `player` started with `npc`: recorded, in-character, player-initiated, both present. Only these are the player's own acts. */
export function playerStartedShowmanceScenes(events: readonly SceneLike[], npc: EntityId): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== "conversation" || e.interactionKind !== "showmance" || e.initiator !== PLAYER) continue;
    if (e.witnessSet.includes(PLAYER) && e.witnessSet.includes(npc)) n++;
  }
  return n;
}

/**
 * Is `npc` drawn to the player: within the NPC's own orientation, toward the gender the player has set (none set => never), AND answering in kind - their own record toward the player
 * has taken the player's romance scenes (`romanceStrand` at or above `ANSWER_BAR`). Both are the NPC's own side; neither is the player's.
 */
export const ANSWER_BAR = 0.3;
export function npcDrawnToPlayer(npc: { orientation: Orientation; gender: GenderPresentation }, playerGender: GenderPresentation | undefined, romanceStrand: number): boolean {
  return canBeDrawnTo(npc.orientation, npc.gender, playerGender) && romanceStrand >= ANSWER_BAR;
}

/**
 * ORW-900: how a houseguest takes a romantic gesture from the player right now. Pure, closed set, no number out. "not-that-way": not drawn to the player (their own
 * orientation, or the player has not said their gender) or no chemistry toward them; "welcoming": drawn, with chemistry, and already answering the player in kind
 * (`ANSWER_BAR`), and not cold right now; "unsure" otherwise. ENGINE-ONLY: the adapter hands the narrator only "welcoming" or "reserved" (unsure and not-that-way are one
 * word outside), so the reply never discloses orientation or chemistry.
 */
export type Receptiveness = "welcoming" | "unsure" | "not-that-way";
export function receptivenessToPlayer(r: { drawn: boolean; chemistry: number; answered: number; coldNow?: boolean }): Receptiveness {
  if (!r.drawn || !(r.chemistry > 0)) return "not-that-way";
  return r.answered >= ANSWER_BAR && !r.coldNow ? "welcoming" : "unsure";
}

/** Is the player in a showmance with `npc`: only by the player's own acts, answered by an NPC who is drawn to them (the foundation's `playerShowmance`). */
export function playerInShowmanceWith(events: readonly SceneLike[], npc: EntityId, drawn: boolean): boolean {
  return playerShowmance(playerStartedShowmanceScenes(events, npc), drawn);
}
