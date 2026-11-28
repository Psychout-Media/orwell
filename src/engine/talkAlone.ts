import { HOUSE_ADJACENCY, isPrivateRoom, type Room } from "../domain/house";
import { dealWillingness, type DealConsentInputs } from "./dealConsent";
import { DEAL_CONSENT } from "./dealConsentConstants";

/**
 * ORW-727b: the player asks a houseguest for a private word ("let's talk alone", "meet me in the storage room"), or to come over ("come here", "come find me"). The model maps the player's words to ONE lever
 * (`askToTalkAlone`); nothing here parses text. Pure: room choice and the houseguest's answer; the adapter reads the bond, places both, holds the houseguest and records who saw them go.
 */
export const TALK_ALONE = {
  /** In-game hours a houseguest who agreed waits in the room (the same patience idea as the desire clock's rest period); they are released when it lapses or the player leaves the room. */
  holdHours: 2,
  /** What the favour costs the houseguest, on the deal-consent willingness scale (0 = a typical newcomer's read). A private word is cheap; a houseguest who distrusts or fears the player still says no. */
  cost: -0.1,
  /** Of the beats where a houseguest approaches the player unprompted, the share in which they ask for a private word instead (a keyed roll, rare). */
  askRarity: 0.12,
  /** A houseguest's own ask for a private word stands this many in-game hours before it lapses. */
  askHours: 4,
  /** ORW-1169: a talk the player has with exactly one houseguest alone in a room (a recorded scene) locks the two for this many in-game hours; each recorded scene with the same partner renews it, the player leaving the room ends it. */
  sceneHours: 1,
} as const;

/** Does the houseguest agree? The deal-consent willingness plus the one keyed jitter (in [-DEAL_CONSENT.jitter, +DEAL_CONSENT.jitter]) against the cost. No rng here. */
export function decideTalkAlone(inputs: Omit<DealConsentInputs, "kind" | "jitter">, jitter: number): boolean {
  const j = Math.max(-DEAL_CONSENT.jitter, Math.min(DEAL_CONSENT.jitter, Number.isFinite(jitter) ? jitter : 0));
  return dealWillingness({ ...inputs, kind: "vote", jitter: 0 }) + j >= TALK_ALONE.cost;
}

const isBedroom = (r: Room): boolean => r.startsWith("bedroom");

/** Rooms in walking order from `from` (the room itself first, then breadth-first through the floor plan, neighbours in the table's own order). Pure. */
export function roomsByDistance(from: Room): Room[] {
  const seen = new Set<Room>([from]);
  const queue: Room[] = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const n of HOUSE_ADJACENCY.get(queue[i]!) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return queue;
}

export interface TalkRoomInput {
  /** The player's room now. */
  from: Room;
  /** The room the player named, when they named one. */
  named: Room | null;
  /** Whether the player or the houseguest asked is the HOH (only then is the HOH room a place for the two). */
  hohInvolved: boolean;
  /** Whether anyone besides the two is in the room now. */
  occupiedByOthers: (room: Room) => boolean;
}

/**
 * The room for a private word: the named room when it is private, free and allowed; else the NEAREST such room by the floor plan. Never the diary room or the landing (not private by the floor plan's sightlines),
 * the HOH room only when one of the two is the HOH, and a bedroom only when the player named it. Null when every private room is taken.
 */
export function talkAloneRoom(i: TalkRoomInput): Room | null {
  const ok = (r: Room, named: boolean): boolean =>
    r !== "diary-room" && r !== "landing" && isPrivateRoom(r) && (r !== "hoh-room" || i.hohInvolved) && (named || !isBedroom(r)) && !i.occupiedByOthers(r);
  if (i.named !== null && ok(i.named, true)) return i.named;
  return roomsByDistance(i.from).find((r) => ok(r, false)) ?? null;
}
