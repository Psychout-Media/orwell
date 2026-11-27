import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";

/**
 * ORW-1084 / ORW-1085 / ORW-1086: THE status gate, "active in the house". One pure rule the engine's house-social seams read:
 * a houseguest who has left the house (evicted before the jury, a sequestered juror, the evicted player, the player of a finished season) neither acts nor witnesses in it.
 * A battle-back returnee leaves the eviction order the moment they return, so they are active again with no special case.
 * Allowed apart from the gate (the design's own seams, never filtered here): the jury house (juror with juror), the finale-night beats, the departing evictee's own departure beat (the `season:` record),
 * the broadcast `house-event`s, and the spectator path (the digests and the couch read the `season:` record, not witness sets).
 */
export interface HouseStatusSource {
  evictionOrder?: readonly EntityId[];
  finished?: boolean;
  beat?: string;
  /** This week's evictee, until the week rolls: the one on their own eviction night, still part of that beat. */
  evictee?: EntityId;
  /** The jurors seated so far (the stable `jurorIds` fact): anyone else who has left is a pre-jury evictee, who goes home (no jury house). */
  jurors?: readonly EntityId[];
}

/** The beats where the jury is in the room (the final eviction and the finale itself). */
const JURY_IN_THE_ROOM: ReadonlySet<string> = new Set(["final-eviction", "finale", "finale-reveal", "finale-result", "complete"]);

/** Is this houseguest still in the house (not evicted, not a sequestered juror)? A returnee who beat their way back is, since they left the eviction order. */
export function isActiveInHouse(live: HouseStatusSource | null | undefined, id: EntityId): boolean {
  if (!live) return true;
  return !(live.evictionOrder ?? []).includes(id);
}

/** Why the player cannot act in the house, or undefined while they can. */
export function playerOutReason(live: HouseStatusSource | null | undefined): "season-over" | "evicted" | undefined {
  if (!live) return undefined;
  if (live.finished) return "season-over";
  if ((live.evictionOrder ?? []).includes(PLAYER)) return "evicted";
  return undefined;
}

/** The clear sentence a refused player lever carries. */
export function playerOutMessage(reason: "season-over" | "evicted"): string {
  return reason === "season-over"
    ? "The season is over (reason: season-over), so there is no house to act in. Spectating and the finale are still open."
    : "The player has left the house (reason: evicted), so they cannot make deals, form alliances, talk in scenes or trade secrets there. Watching the season and the jury house are still open.";
}

/** Event types that are the public broadcast, a departure or the finale stage, not a houseguest acting in the house: never filtered. */
const BROADCAST_TYPES: ReadonlySet<string> = new Set(["house-event", "confessional", "host", "premiere-entrance", "toast-speech", "bedtime", "diary-room", "diary-call"]);

/** The types whose first witness is the one who acted. */
const ACT_TYPES = /^(lobbying|deal|betrayal|conversation|alliance|overheard|spy-|pre-show-tie)/;

/**
 * The gate at the one seam that records an engine-minted, house-social event (`setOnPlayerEvent`). Returns the witness set to record, or null when the event must not be recorded.
 *  - a broadcast type, the finale night and a finished season are never filtered;
 *  - an event made only of people who are out (a juror with a juror, the player watching from the jury house) is the jury house / the spectator path: kept as it is;
 *  - otherwise whoever is out is dropped from the witness set; for an act (a deal, a lobby, a betrayal, a conversation, an alliance move) whose actor (the first in the set) is out, nothing happened in the house: null.
 *    A public record about the house (the HOH room, a bed claim, a reason said aloud, a secret out) keeps the people still in it.
 */
export function gateHouseEvent(live: HouseStatusSource | null | undefined, type: string, witnessSet: readonly EntityId[]): EntityId[] | null {
  if (!live || live.finished || BROADCAST_TYPES.has(type) || (live.beat !== undefined && JURY_IN_THE_ROOM.has(live.beat))) return [...witnessSet];
  const here = (id: EntityId): boolean => isActiveInHouse(live, id) || id === live.evictee; // this week's evictee is still on their own eviction night
  const active = witnessSet.filter(here);
  if (active.length === witnessSet.length) return [...witnessSet]; // everyone is in the house (the ordinary case)
  if (active.length === 0) {
    // Only people who have left: the jury house (jurors with jurors, the player watching among them) is the one place that is theirs. A lone one, or a pre-jury evictee, has nowhere to act.
    const juror = (id: EntityId): boolean => id === PLAYER || (live.jurors ?? []).includes(id);
    return witnessSet.length >= 2 && witnessSet.every(juror) ? [...witnessSet] : null;
  }
  if (ACT_TYPES.test(type) && !here(witnessSet[0]!)) return null; // an evicted houseguest acted: that did not happen in the house
  return active;
}
