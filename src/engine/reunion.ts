import type { EntityId } from "../domain/ids";

/**
 * ORW-649 + ORW-648 (Ryne approved both 2026-11-17) - THE REUNION and THE STORY OF YOU AND THEM. FOUNDATION ONLY (pure, no I/O, no rng, no Vault handle):
 * the rules the build uses to choose what the reunion airs and how each houseguest's story with the player is shaped. Spec 0211; the build goes to A or B.
 *
 * Both are POST-CROWN only (`afterTheCrown`): they read only what the 0048 retrospective may unseal (mandate #2: the season-end unsealing, never before).
 *  - 649 the reunion: after the crown the cast reunites; rivals confront (`confrontations`), alliances are explained (`alliancesToExplain`), lies come out in
 *    front of the people they were told to (`liesComingOut`). The player takes part (a thread can involve the player either way), in their own words.
 *  - 648 the story of you and them: per houseguest, the shape of their view of the player over the season (`arcShape`), its turning points (`turningPoints`,
 *    tied to the events of that week), and the bookends (first meeting, how it ended). The narrator writes the story from these facts; never numbers.
 */
export const REUNION = {
  /** At most this many confrontations, lies and alliance explanations aired (the reunion is a scene, not a transcript). */
  maxConfrontations: 3,
  maxLies: 3,
  maxAlliances: 2,
  /** A grudge this size or more is worth a confrontation. */
  grudgeAtLeast: 0.4,
  /** 648: a view moving this much (trust + affinity, one week to the next) is a turning point; a total move this size is warmed / cooled. */
  turnAtLeast: 0.15,
  driftAtLeast: 0.2,
  maxTurningPoints: 3,
} as const;

export const afterTheCrown = (finished: boolean): boolean => finished;

/** A grudge one houseguest (or the player) holds against another, from the grudge book (ORW-607). */
export interface Grudge { holder: EntityId; at: EntityId; size: number }
/** 649: the confrontations: the biggest grudges, one per pair (a mutual grudge counts once, at its sum), capped. The player may be on either side. */
export function confrontations(grudges: readonly Grudge[]): Array<{ a: EntityId; b: EntityId; size: number }> {
  const pairs = new Map<string, { a: EntityId; b: EntityId; size: number }>();
  for (const g of grudges) {
    if (g.size < REUNION.grudgeAtLeast || g.holder === g.at) continue;
    const [a, b] = [g.holder, g.at].sort() as [EntityId, EntityId];
    const k = `${a}|${b}`;
    const p = pairs.get(k);
    if (p) p.size += g.size; else pairs.set(k, { a, b, size: g.size });
  }
  return [...pairs.values()].sort((x, y) => y.size - x.size || `${x.a}|${x.b}`.localeCompare(`${y.a}|${y.b}`)).slice(0, REUNION.maxConfrontations);
}

/** A claim from the claims log, at the season's end. */
export interface ClaimAtEnd { id: string; speaker: EntityId; listener: EntityId; isTrue: boolean; caught: boolean; week: number }
/** 649: the lies that come out: never caught in the game (the listener hears it for the first time, in front of the speaker); the earliest-told first, capped. */
export function liesComingOut(claims: readonly ClaimAtEnd[]): ClaimAtEnd[] {
  return claims.filter((c) => !c.isTrue && !c.caught && c.speaker !== c.listener)
    .sort((a, b) => a.week - b.week || a.id.localeCompare(b.id)).slice(0, REUNION.maxLies);
}

/** A group (alliance) at the season's end: members, and members who never knew of it from outside (the ones it was hidden from). */
export interface GroupAtEnd { id: string; members: EntityId[]; hiddenFrom: EntityId[]; weeks: number }
/** 649: the alliances worth explaining: the longest-running ones that were hidden from someone at the reunion, capped. */
export function alliancesToExplain(groups: readonly GroupAtEnd[]): GroupAtEnd[] {
  return groups.filter((g) => g.hiddenFrom.length > 0).sort((a, b) => b.weeks - a.weeks || a.id.localeCompare(b.id)).slice(0, REUNION.maxAlliances);
}

/** 648: one week's sample of a houseguest's view of the player (engine-held; recorded weekly). */
export interface ViewPoint { week: number; trust: number; affinity: number }
/** 648: the shape of the story: turned (crossed from warm to cold or back), warmed, cooled, or steady (an engine key the narrator voices). */
export type ArcShape = "turned" | "warmed" | "cooled" | "steady";
const warmth = (p: ViewPoint): number => p.trust + p.affinity;
export function arcShape(points: readonly ViewPoint[]): ArcShape {
  if (points.length < 2) return "steady";
  const ws = points.map(warmth);
  const first = ws[0]!, last = ws[ws.length - 1]!;
  if (Math.sign(first) !== Math.sign(last) && Math.abs(last - first) >= REUNION.driftAtLeast) return "turned";
  return last - first >= REUNION.driftAtLeast ? "warmed" : first - last >= REUNION.driftAtLeast ? "cooled" : "steady";
}
/** 648: the weeks where the view moved most (each tied by the build to the player-and-houseguest events of that week), biggest first, capped. */
export function turningPoints(points: readonly ViewPoint[]): Array<{ week: number; move: number }> {
  const out: Array<{ week: number; move: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const move = warmth(points[i]!) - warmth(points[i - 1]!);
    if (Math.abs(move) >= REUNION.turnAtLeast) out.push({ week: points[i]!.week, move });
  }
  return out.sort((a, b) => Math.abs(b.move) - Math.abs(a.move) || a.week - b.week).slice(0, REUNION.maxTurningPoints);
}
