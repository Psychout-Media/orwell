import type { EntityId } from "../domain/ids";
import { agendaRoll } from "./agenda";
import { diaryCallSeen, type DiaryCallSeen, type ComesBack } from "./production";
import { hostRegister, registerWords } from "./productionHost";


/**
 * THEME C slice C2 (ORW-668, spec 0210) - CALLED TO THE DIARY ROOM. Pure, no I/O, no rng draw, no Vault handle.
 *
 * Production visibly calls a houseguest to the Diary Room and the house sees it: WHO went, WHEN, whether they were gone a long while and how they looked coming back
 * (`diaryCallSeen`, the foundation's record). What was said is not here and never can be: no function in this module takes, returns or stores a confessional's content.
 * The engine decides who is called and when from public facts (a keyed roll per houseguest per in-game hour, `agendaRoll`, which touches no shared random stream);
 * the narrator authors every word, including the producer's. The player is called through the existing invitation (they accept or decline); they are never sent.
 */
export const DIARY_CALLS = {
  /** The chance one awake houseguest is the one called in a given in-game hour (keyed roll; the lowest passing roll wins). */
  hourlyChance: 0.01,
  /** At most this many NPC calls per in-game day, and only one away at a time. */
  perDay: 1,
  /** A stay is between these many minutes (a keyed roll); the houseguest is away for the in-game hours it spans. */
  /** ORW-914: the producer's invitation to the player stays quiet this many in-game hours after the player's own visit to the Diary Room. */
  inviteQuietHours: 6,
  minMinutes: 15,
  maxMinutes: 90,
} as const;

/** An NPC currently in the Diary Room. `until` is the absolute in-game hour they are back. */
export interface DiaryAway { who: EntityId; since: number; until: number; minutes: number; moodBefore: number; day: number }
/** What the season keeps (engine-only, persisted, append-only `seen`). */
export interface DiaryCallsState {
  away?: DiaryAway;
  seen: Array<DiaryCallSeen & { at: number }>;
  byDay: Record<string, number>;
  /** The in-game hour of the player's last visit that was recorded (a visit is recorded once per hour). */
  playerLast?: number;
}

/** Minutes a houseguest's call lasts: a keyed roll, never the shared stream. */
export function callMinutes(seed: number, who: EntityId, abs: number): number {
  return Math.round(DIARY_CALLS.minMinutes + agendaRoll(seed, who, `dcall:len:${abs}`) * (DIARY_CALLS.maxMinutes - DIARY_CALLS.minMinutes));
}

/** Who (if anyone) production calls this in-game hour, from public facts only. `candidates` are the awake houseguests free to be called (never the player). Deterministic per seed. */
export function decideDiaryCall(a: { seed: number; day: number; abs: number; callsToday: number; awayNow: boolean; candidates: readonly EntityId[] }): { who: EntityId; minutes: number } | undefined {
  if (a.awayNow || a.callsToday >= DIARY_CALLS.perDay) return undefined;
  let best: { who: EntityId; roll: number } | undefined;
  for (const id of [...a.candidates].sort()) {
    const roll = agendaRoll(a.seed, id, `dcall:d${a.day}h${a.abs}`);
    if (roll < DIARY_CALLS.hourlyChance && (!best || roll < best.roll)) best = { who: id, roll };
  }
  return best ? { who: best.who, minutes: callMinutes(a.seed, best.who, a.abs) } : undefined;
}

/** The in-game hours a call of `minutes` spans (at least one). */
export const awayHours = (minutes: number): number => Math.max(1, Math.ceil(minutes / 60));

/** The record of a finished call (the foundation's `diaryCallSeen`). */
export function seenOf(away: DiaryAway, moodAfter: number): DiaryCallSeen {
  return diaryCallSeen(away.who, away.day, away.minutes, away.moodBefore, moodAfter);
}

/** The public fact of a call going out: a statement of what the house saw, never a content line. */
export function callEventText(name: string): string { return `${name} was called to the Diary Room`; }

/** The public fact of a return: whether they were gone long and how they looked. No content, by construction. */
export function backEventText(name: string, seen: Pick<DiaryCallSeen, "long" | "comesBack">): string {
  const gone = seen.long ? "after a long while" : "after a short while";
  return `${name} came back from the Diary Room ${gone}, ${lookWords(seen.comesBack)}`;
}
function lookWords(c: ComesBack): string { return c === "lighter" ? "looking lighter than when they went in" : c === "heavier" ? "looking heavier than when they went in" : "looking much as they did when they went in"; }

/** The player's own visit: the house sees them go. The engine never says how it left the player feeling. */
export function playerVisitText(name: string): string { return `${name} went to the Diary Room`; }

/** The production voice's manner for the season: the same seam as the host, keyed to its own owner. */
export const producerRegisterWords = (seed: number): string => registerWords(hostRegister(seed, "producer"));


/** ORW-668 (0210 C2): the Diary Room calls as FACTS for the narrator (the engine writes no producer line). `register` is the producer's manner as words. Defined here so the ports can re-export it without a cycle. */
export interface DiaryCallView {
  register: string;
  /** Houseguests production has called who are in the Diary Room now. */
  away?: string[];
  /** Houseguests who have just come out: whether they were gone long and how they looked (a coarse key). */
  back?: Array<{ name: string; long: boolean; comesBack: ComesBack }>;
  /** Production invites the player this beat; the player goes or declines in their own words. */
  invited?: true;
  /** ORW-724: how many times the player has gone to the Diary Room this game (the engine's own record of the player's own act), present only while the player is in there. */
  playerVisits?: number;
}

/** The count as the producer would say it: a word, never a digit string the narrator must reformat. */
export const visitWords = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** The moment's call block: facts to voice. Rides the per-turn hard constraints, never the base prompt. */
export function renderDiaryCallLines(v: DiaryCallView | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  if (v.playerVisits) out.push(`- DIARY ROOM VISITS (engine record of the player's own acts): the player has been in the Diary Room ${visitWords(v.playerVisits)} this game, counting this visit. If the producer speaks of how often the player has been in, it is this count and no other; never a number the producer makes up.`);
  const voice = `the producer's manner this season is ${v.register}; you author the producer's words yourself, from these facts and nothing else`;
  if (v.away?.length) out.push(`- DIARY ROOM CALL: production has called ${v.away.join(" and ")} to the Diary Room and they are in there now, so they are not in any room and cannot appear in a scene; the house saw them go. What is said in there is private: never narrate it or guess at it. (${voice}.)`);
  for (const b of v.back ?? []) out.push(`- DIARY ROOM RETURN: ${b.name} has just come out of the Diary Room after ${b.long ? "a long while" : "a short while"}, ${b.comesBack === "same" ? "looking much as they did going in" : `looking ${b.comesBack} than going in`}. The house can see that and nothing more; say nothing of what was said.`);
  if (v.invited) out.push(`- DIARY ROOM INVITATION: production would like the player in the Diary Room after this beat. Voice that call in the producer's manner (${voice}) and leave it to the player to go or to say no in their own words; never send them, never decide for them, never describe what they say in there. The house sees the player go only if they go.`);
  return out;
}
