/**
 * STUB (slice 7b): 7a's `src/engine/houseMeeting.ts` replaces this whole file at merge. Only the ONE seam the player-call hook reads.
 * 0156 rule 1: who may call a meeting is decided in ONE place (`MEETING_RULES.callers`, default "player+npc").
 */
import { PLAYER, type EntityId } from "../domain/ids";

export const MEETING_RULES = { callers: "player+npc" as "player+npc" | "npc" | "player" } as const;

export function canCallMeeting(who: EntityId): boolean {
  return who === PLAYER ? MEETING_RULES.callers !== "npc" : MEETING_RULES.callers !== "player";
}

/** STUB: the shape of 7a's `holdHouseMeeting` input (replaced by 7a's export at merge). */
export interface HoldMeetingInput { caller: EntityId; accused: EntityId; claim: { kind: string; subject: EntityId; object?: EntityId } }
