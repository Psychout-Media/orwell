/**
 * ORW-631 (feature 0197) - CATCHING A MISDIRECTION. Builds on ORW-475 (asking around, `askAround.ts`): whenever a houseguest the player asked says where someone is, the engine
 * keeps a record of that TOLD LEAD - who said it, about whom, which room they named, and (engine-only, never projected) where the subject really was and whether the speaker
 * misled. The record is append-only for the season. It is resolved only by what the player can legitimately SEE afterwards: the subject in view in the named room (the lead held),
 * the subject in view somewhere else, or the named room in view without the subject (the lead did not pan out). Both a stale lead and a misleading one resolve the same way and read the same
 * way to the player, so the player infers which it was; the engine never reveals the hidden truth, and never acts or speaks for the player.
 *
 * Pure: no I/O, no rng, no Vault. The caller supplies what the player can see.
 */
import type { EntityId } from "../domain/ids";

export const TOLD_LEADS = {
  /** A lead found wrong stays on the player's whereabouts read for this many presence ticks, then drops off the read (the record itself is kept). */
  noticeTicks: 3,
} as const;

export interface ToldLead {
  /** `<speaker>|<subject>|<day>|<part>` - one lead per speaker, subject and part of day (the answer is deterministic, so a repeat read is the same lead). */
  key: string;
  speaker: EntityId;
  subject: EntityId;
  /** The room the speaker named. */
  toldRoom: string;
  /** ENGINE-ONLY: where the subject really was when it was said. Never projected. */
  truthRoom?: string;
  /** ENGINE-ONLY: whether the speaker misled. Never projected. */
  misled: boolean;
  tick: number;
  day: number;
  part: string;
  /** How the lead resolved: held, wrong, or lapsed (the day moved on unresolved). Absent = still open. */
  status?: "held" | "wrong" | "lapsed";
  /** For a `wrong` lead: the room the player then saw the subject in, when they did. */
  foundRoom?: string;
  resolvedTick?: number;
}

/** Add a lead unless one with the same key is already kept. Returns whether it was added. */
export function noteToldLead(list: ToldLead[], lead: ToldLead): boolean {
  if (list.some((l) => l.key === lead.key)) return false;
  list.push(lead);
  return true;
}

export interface PlayerSight {
  tick: number;
  day: number;
  /** The room the player sees `subject` in right now (awake, in their room or sightline), or undefined when the player does not see them. */
  seenRoomOf: (subject: EntityId) => string | undefined;
  /** Can the player see into this room right now (their own room or one in sightline)? */
  roomInView: (room: string) => boolean;
}

/**
 * Resolve every open lead from what the player sees now. A lead told this very tick waits (the player has had no chance to look). A lead from an earlier day lapses (too stale to say anything).
 * Returns the leads resolved this call (mutated in place).
 */
export function resolveToldLeads(list: ToldLead[], sight: PlayerSight): ToldLead[] {
  const out: ToldLead[] = [];
  for (const l of list) {
    if (l.status !== undefined || sight.tick <= l.tick) continue;
    if (l.day !== sight.day) { l.status = "lapsed"; l.resolvedTick = sight.tick; out.push(l); continue; }
    const seen = sight.seenRoomOf(l.subject);
    if (seen !== undefined) {
      if (seen === l.toldRoom) l.status = "held";
      else { l.status = "wrong"; l.foundRoom = seen; }
    } else if (sight.roomInView(l.toldRoom)) l.status = "wrong";
    else continue;
    l.resolvedTick = sight.tick;
    out.push(l);
  }
  return out;
}

/** The leads found wrong recently enough to still be on the player's read. */
export function recentWrongLeads(list: readonly ToldLead[], tick: number): ToldLead[] {
  return list.filter((l) => l.status === "wrong" && l.resolvedTick !== undefined && tick - l.resolvedTick < TOLD_LEADS.noticeTicks);
}

/** The save check's rule for the record (append-only, never thinned): no lead told is ever lost. */
export function toldLeadsSuperset(later: readonly ToldLead[] | undefined, earlier: readonly ToldLead[] | undefined): boolean {
  if (!earlier || earlier.length === 0) return true;
  const keys = new Set((later ?? []).map((l) => l.key));
  return earlier.every((l) => keys.has(l.key));
}
