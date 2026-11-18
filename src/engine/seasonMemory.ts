import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01, clamp } from "../domain/num";
import type { Character } from "./characterFactory";

/**
 * THEME B (ORW-662; Ryne approved all three slices 2026-11-18) - SEASONS THAT REMEMBER. FOUNDATION ONLY: the pure rules the slices (B1 returners, B2 reputation
 * walks in, B3 hall of fame) build on; A and B wire them. Pure: no I/O, no rng (callers pass keyed rolls), no Vault handle.
 *
 * Ryne's rules (2026-11-18): the player CHOOSES to start new or return; returning brings reputation (`reputationApplies`). "Old players can return no matter what.
 * One from your old season or not." Returning NPCs must be REAL NPCs from seasons this player actually played (`ArchivedHouseguest`, from a per-user archive that
 * survives `resetUser` like 0104's notoriety store), "don't make a returning player as simply as part of a backstory".
 *
 * The wall: the archive holds a returner's own end-of-season feelings toward the player and their own claims about the player - hidden-layer data, so the
 * archive is ENGINE-ONLY (like souls), never projected. The hall of fame (B3) holds only facts the finished season's retrospective already unsealed to the player.
 */
export const SEASON_MEMORY = {
  /** B1: when the player returns and has an archive, the chance a season casts one returner (keyed roll). */
  returnerChance: 0.35,
  /** B1: each season since, a returner's feelings move this share of the way back toward neutral... */
  softenPerSeason: 0.3,
  /** ...but never below this share of what they ended with (a grudge fades, it does not vanish). */
  keepAtLeast: 0.25,
  /** B1: how many of a returner's own claims about the player carry over (their account; a gist, never a transcript). */
  maxCarriedClaims: 6,
} as const;

/** How the player starts a season (Ryne: their choice). Only a return brings the player's reputation (0104 notoriety, B2) and their past into the house. */
export type SeasonStart = "new" | "return";
export const reputationApplies = (start: SeasonStart): boolean => start === "return";

/** The returner's end-of-season read of the player (hidden layer; engine-only). */
export interface EndFeelings { trust: number; affinity: number; threat: number }

/** One of the player's own claims or acts, as the returner witnessed or was told it, carried as their account (claim kind + nature; the narrator words it). */
export interface CarriedClaim { kind: string; nature?: string; week: number; witnessed: boolean }

/** A real houseguest from a season this player played, archived at that season's end (per user; engine-only). `characterRef` points at their static CHARACTER snapshot. */
export interface ArchivedHouseguest {
  season: number;
  npcId: EntityId;
  characterRef: string;
  placement: number;
  juror: boolean;
  endToward: EndFeelings;
  claims: CarriedClaim[];
  /** B1 (ORW-663): the houseguest's display name and their static PUBLIC persona, archived with them. Optional so an older/incomplete entry exists but can never resolve as a returnee (`resolveReturnee` fails closed without them). */
  name?: string;
  persona?: ArchivedPersona;
}

/** B1: a static CHARACTER snapshot WITHOUT its `hiddenElements` (the prior season's hidden layer never rides the archive; a returner's secrets are minted fresh for the new season). */
export type ArchivedPersona = Omit<Character, "hiddenElements">;

/** B1: what a returner feels toward the player now, softened by the seasons since (toward neutral, never below `keepAtLeast` of the end read). */
export function softenedFeelings(end: EndFeelings, seasonsSince: number): EndFeelings {
  const keep = Math.max(SEASON_MEMORY.keepAtLeast, (1 - SEASON_MEMORY.softenPerSeason) ** Math.max(0, seasonsSince));
  return { trust: clamp(end.trust * keep, -1, 1), affinity: clamp(end.affinity * keep, -1, 1), threat: clamp01(end.threat * keep) };
}

/** B1: does this season cast a returner? Only on a return, only with someone archived. */
export const castsReturner = (start: SeasonStart, archived: number, roll: number): boolean => reputationApplies(start) && archived > 0 && clamp01(roll) < SEASON_MEMORY.returnerChance;

/** B1: which archived houseguest returns: any season the player played ("no matter what"), never someone already in this cast; the pick is the caller's keyed roll. */
export function pickReturner(pool: readonly ArchivedHouseguest[], inCast: ReadonlySet<EntityId>, roll: number): ArchivedHouseguest | undefined {
  const open = pool.filter((h) => !inCast.has(h.npcId));
  if (open.length === 0) return undefined;
  return open[Math.min(open.length - 1, Math.floor(clamp01(roll) * open.length))];
}

/** B1: the claims a returner carries in: their own, newest first, capped. Witnessed ones first (they saw it; told ones are hearsay). */
export function carriedClaims(claims: readonly CarriedClaim[]): CarriedClaim[] {
  return [...claims].sort((a, b) => Number(b.witnessed) - Number(a.witnessed) || b.week - a.week).slice(0, SEASON_MEMORY.maxCarriedClaims);
}

/** B3: how a season ended for the player (engine key; the FE words it). */
export type SeasonResult = "won" | "runner-up" | "jury" | "evicted-pre-jury";
export function seasonResult(placement: number, juror: boolean): SeasonResult {
  return placement === 1 ? "won" : placement === 2 ? "runner-up" : juror ? "jury" : "evicted-pre-jury";
}

/** B3: one hall-of-fame line per finished season. Highlights are event ids from that season's unsealed retrospective (the narrator or FE words them). */
export interface HallEntry {
  season: number;
  placement: number;
  result: SeasonResult;
  winnerId?: EntityId;
  bestMoveEventId?: string;
  worstBetrayalEventId?: string;
}
export function hallEntry(season: number, placement: number, juror: boolean, extra: Omit<HallEntry, "season" | "placement" | "result"> = {}): HallEntry {
  return { season, placement, result: seasonResult(placement, juror), ...extra };
}
