/**
 * ORW-1159 (Ryne 2026-11-28: "Valerie asked a question, and within the next message she walked out to a different room and wasn't there to hear the answer"): a houseguest who is IN a conversation with the player is
 * tethered to the player's room, so the engine's own movement (the presence tick, wander, intent, routines) never takes them out of it mid-talk. Pure: marks, expiry, and the one decision; the adapter owns the marks.
 * A tether always expires by itself, in player replies and in game hours, so nobody is stuck in a room.
 */
export const CONVERSATION_TETHER = {
  /** A mark stands for this many player replies after the one it was made in (the last two replies), then the talk has lulled. */
  replies: 2,
  /** ... and never longer than this many in-game hours (a clock-less game counts replies only). */
  maxHours: 3,
} as const;

export interface TetherMark {
  /** The player-message counter the mark was made on. */
  turn: number;
  /** The absolute in-game hour it was made at, when the clock runs. */
  hour?: number;
}

/** Is the mark still holding? Bounded by replies and (when the clock runs) by game hours. */
export function tetherHolds(mark: TetherMark | undefined, turnNow: number, hourNow: number | undefined): boolean {
  if (!mark) return false;
  if (turnNow - mark.turn > CONVERSATION_TETHER.replies) return false;
  if (mark.hour !== undefined && hourNow !== undefined && hourNow - mark.hour > CONVERSATION_TETHER.maxHours) return false;
  return true;
}
