import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import { REUNION, afterTheCrown, alliancesToExplain, arcShape, confrontations, liesComingOut, turningPoints, type ArcShape, type ClaimAtEnd, type GroupAtEnd, type Grudge, type ViewPoint } from "./reunion";

/**
 * ORW-649 + ORW-648 (spec 0211) - THE REUNION and THE STORY OF YOU AND THEM, the BUILD over the foundation in `reunion.ts`. PURE: the caller
 * (`GameSessionAdapter.seasonRetrospective`) holds the crown gate (`afterTheCrown(finished)` + a played game), so before the crown none of this exists.
 * Both are PRESENTATION over the existing record: no event is recorded, nothing folds into a relationship, no rng. They read only what the 0048 retrospective
 * already unseals (the grudge book and the rumor mill's lies and the group life) and the weekly record of each houseguest's own view of the player.
 *
 * FACTS ONLY: names, plain kinds, relative weeks. Never an id, a size, a weight or a number; the per-voter eviction ballot is NOT read. The narrator voices
 * each thread and each story live; `line` is only the composed offline floor (names, weeks and kinds, no dealt pool).
 */

/** What the pair held against each other, as the holder's wrong kinds (engine keys the narrator voices), never a size. */
export interface ReunionConfrontation {
  kind: "confrontation";
  between: [string, string];
  /** Who held the grudge (one name, or both when it ran both ways). */
  heldBy: string[];
  /** What the wrong was, as engine kind keys (the narrator voices them). */
  about: string[];
  /** The player is one of the two: the player answers in their own words. */
  youAreIn: boolean;
  line: string;
}
export interface ReunionLie {
  kind: "lie";
  speaker: string;
  listener: string;
  /** What was said, in plain words ("them" is the listener). */
  said: string;
  week: number;
  youAre?: "speaker" | "listener";
  line: string;
}
export interface ReunionAlliance {
  kind: "alliance";
  name?: string;
  members: string[];
  hiddenFrom: string[];
  fromWeek: number;
  untilWeek?: number;
  youAreIn: boolean;
  line: string;
}
export type ReunionThread = ReunionConfrontation | ReunionLie | ReunionAlliance;
export interface ReunionView { threads: ReunionThread[] }

const list = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export interface ReunionInput {
  finished: boolean;
  nameOf: (id: EntityId) => string;
  grudges: ReadonlyArray<Grudge & { kind: string }>;
  claims: ReadonlyArray<ClaimAtEnd & { said: string }>;
  groups: ReadonlyArray<GroupAtEnd & { name?: string; fromWeek: number; untilWeek?: number }>;
}

/** The reunion's threads: the confrontations first, then the lies coming out, then the alliances to explain. Absent when the season held none. */
export function buildReunion(inp: ReunionInput): ReunionView | undefined {
  if (!afterTheCrown(inp.finished)) return undefined;
  const n = inp.nameOf;
  const threads: ReunionThread[] = [];
  for (const c of confrontations(inp.grudges)) {
    const mine = inp.grudges.filter((g) => g.size >= REUNION.grudgeAtLeast && ((g.holder === c.a && g.at === c.b) || (g.holder === c.b && g.at === c.a)));
    const holders = [...new Set(mine.map((g) => g.holder))];
    const between: [string, string] = [n(c.a), n(c.b)];
    const heldBy = holders.map(n).sort();
    threads.push({
      kind: "confrontation", between, heldBy, about: [...new Set(mine.map((g) => g.kind))].sort(),
      youAreIn: c.a === PLAYER || c.b === PLAYER,
      line: `${between[0]} and ${between[1]} faced each other: ${list(heldBy)} still held it against ${heldBy.length > 1 ? "the other" : holders[0] === c.a ? between[1] : between[0]}.`,
    });
  }
  for (const c of liesComingOut(inp.claims)) {
    const said = inp.claims.find((x) => x.id === c.id)!.said;
    const youAre = c.speaker === PLAYER ? "speaker" as const : c.listener === PLAYER ? "listener" as const : undefined;
    threads.push({
      kind: "lie", speaker: n(c.speaker), listener: n(c.listener), said, week: c.week, ...(youAre ? { youAre } : {}),
      line: `In week ${c.week}, ${n(c.speaker)} told ${n(c.listener)} ${said}, and it was never true; ${n(c.listener)} heard that in front of ${n(c.speaker)} now.`,
    });
  }
  for (const g of alliancesToExplain(inp.groups)) {
    const meta = inp.groups.find((x) => x.id === g.id)!;
    const members = g.members.map(n).sort(), hiddenFrom = g.hiddenFrom.map(n).sort();
    threads.push({
      kind: "alliance", ...(meta.name ? { name: meta.name } : {}), members, hiddenFrom, fromWeek: meta.fromWeek, ...(meta.untilWeek !== undefined ? { untilWeek: meta.untilWeek } : {}),
      youAreIn: g.members.includes(PLAYER),
      line: `${list(members)} stood together${meta.name ? ` as ${meta.name}` : ""} from week ${meta.fromWeek}, and ${list(hiddenFrom)} never knew.`,
    });
  }
  return threads.length ? { threads } : undefined;
}

/** One houseguest's story with the player, as facts. */
export interface YourStory {
  name: string;
  /** How their view of you moved: turned, warmed, cooled or steady (an engine key the narrator voices). */
  shape: ArcShape;
  /** The first scene the two of you shared (its kind and the week), when there was one. */
  met?: { week: number; kind: string };
  /** The weeks the view moved most, biggest first, and the scenes the two of you shared that week. */
  turns: Array<{ week: number; direction: "warmer" | "cooler"; scenes: string[] }>;
  ended: { how: "won" | "runner-up" | "evicted"; week?: number; juror?: { votedFor: "you" | "someone else"; for?: string } };
  line: string;
}
export interface YourStoriesView { stories: YourStory[] }

export interface StoryGuest {
  id: EntityId;
  points: readonly ViewPoint[];
  /** The non-hidden scenes the player and this houseguest both took part in (a plain kind and the week). */
  scenes: ReadonlyArray<{ week: number; kind: string }>;
  evictedWeek?: number;
  /** True when this houseguest sat on the jury and voted. */
  votedFor?: EntityId;
  finalist?: boolean;
}
export interface StoriesInput { finished: boolean; nameOf: (id: EntityId) => string; winner: EntityId | null; guests: readonly StoryGuest[] }

export function storyLine(s: Omit<YourStory, "line">): string {
  const open = s.met ? `You first shared a ${s.met.kind} scene with ${s.name} in week ${s.met.week}.` : `You and ${s.name} hardly shared a scene.`;
  const arc = s.shape === "turned" ? `Their view of you turned over the season` : s.shape === "warmed" ? `They warmed to you` : s.shape === "cooled" ? `They cooled on you` : `They held steady toward you`;
  const turn = s.turns[0] ? `; the biggest change came in week ${s.turns[0].week}, as they grew ${s.turns[0].direction}${s.turns[0].scenes.length ? ` after a ${s.turns[0].scenes[0]} scene` : ""}` : "";
  const end = s.ended.how === "won" ? `${s.name} won the game.` : s.ended.how === "runner-up" ? `${s.name} was beside you at the end and lost the vote.`
    : `${s.name} left in week ${s.ended.week ?? 0}${s.ended.juror ? s.ended.juror.votedFor === "you" ? " and gave you their jury vote" : ` and gave their jury vote to ${s.ended.juror.for ?? "someone else"}` : ""}.`;
  return `${open} ${arc}${turn}. ${end}`;
}

/** The story of you and each houseguest, in name order. Absent before the crown. */
export function buildYourStories(inp: StoriesInput): YourStoriesView | undefined {
  if (!afterTheCrown(inp.finished)) return undefined;
  const n = inp.nameOf;
  const stories: YourStory[] = [];
  for (const g of inp.guests) {
    const scenes = [...g.scenes].sort((a, b) => a.week - b.week);
    const turns = turningPoints(g.points).map((t) => ({
      week: t.week, direction: t.move > 0 ? "warmer" as const : "cooler" as const,
      scenes: [...new Set(scenes.filter((x) => x.week === t.week).map((x) => x.kind))].sort().slice(0, 3),
    }));
    const first = scenes[0];
    const who = n(g.id);
    const how: YourStory["ended"]["how"] = inp.winner === g.id ? "won" : g.finalist ? "runner-up" : "evicted";
    const ended: YourStory["ended"] = {
      how, ...(how === "evicted" ? { week: g.evictedWeek ?? 0 } : {}),
      ...(g.votedFor ? { juror: g.votedFor === PLAYER ? { votedFor: "you" as const } : { votedFor: "someone else" as const, for: n(g.votedFor) } } : {}),
    };
    const part = { name: who, shape: arcShape(g.points), ...(first ? { met: { week: first.week, kind: first.kind } } : {}), turns, ended };
    stories.push({ ...part, line: storyLine(part) });
  }
  stories.sort((a, b) => a.name.localeCompare(b.name));
  return stories.length ? { stories } : undefined;
}
