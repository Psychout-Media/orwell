import type { EventStore } from "../ports/EventStore";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { composedAt, joinWords } from "./data/composedFloor";

/**
 * Varied, state-derived house-event content + the week's day index (audit E58).
 *
 * The daily-event invariant (0008) used to be satisfied by ONE verbatim filler line
 * ("A house meeting shifts the week."), repeated forever — it polluted THE RECORD's
 * re-entry facts and handed the narrator a script to recite (ADR 0003 violation: the
 * engine hands the model FACTS to voice, never one canned sentence). This module owns:
 *
 *  1. `dayOfWeek(phase)` — the canonical beat→day mapping (HOH=1 … eviction=5), so the
 *     live game finally has an in-game day index derived from the ceremony cadence.
 *  2. `nextHouseEvent(...)` — a seeded pick from a curated pool of meaningful house
 *     events, grounded in the current week/day and guaranteed to never repeat any of
 *     the last `RECENT_WINDOW` recorded house-events' content (the store is consulted,
 *     so the guarantee survives restarts — the store recalled, never module state
 *     remembered). A follow-up audit found the real call cadence lands several ambient
 *     picks per week (well above once/day), so a window of 1 (only the immediately
 *     preceding pick) let the pool cycle into visibly-repeating content within the
 *     first few weeks of a season — the window and the pool are both widened here.
 *
 * Pure and Vault-free: the lines are public, player-witnessed happenings (facts the
 * narrator may dress in its own voice); no name, stat, or hidden state is baked in.
 */

/** The canonical weekly cadence: Day 1 HOH → Day 2 noms → Day 3 veto comp → Day 4 ceremony → Day 5 eviction. */
export function dayOfWeek(phase: string): number | null {
  const p = phase.toLowerCase();
  if (p.includes("hoh")) return 1;
  if (p.includes("nomination")) return 2;
  if (p.includes("veto") && p.includes("cerem")) return 4;
  if (p.includes("veto")) return 3;
  if (p.includes("evict")) return 5;
  if (p.includes("final") || p.includes("jury")) return 5;
  return null; // pre-game / premiere / non-week moments carry no day index
}

/**
 * The variety pool. Each line is a complete, voiceable public happening — concrete
 * enough to be a real RECORD fact, generic enough to fit any cast (no names; the
 * narrator attaches people in its own voice). Keep every line meaningful (0008):
 * a significant house event, never empty filler.
 */
export const HOUSE_EVENT_POOL: ReadonlyArray<string> = [
  "A house meeting over food and chores boils into a shouting match before it settles.",
  "A tight grocery budget hits the whole house and tempers fray by mid-afternoon.",
  "A luxury reward splits the house into winners celebrating and losers sulking.",
  "A late-night kitchen clean-up turns into a whispered debrief of the week so far.",
  "A backyard workout session becomes a quiet summit between unlikely partners.",
  "A practical joke war escalates until Big Brother calls the house to order.",
  "A care-package delivery stirs jealousy over who got remembered from home.",
  "A rainy lockdown crams everyone inside and old grievances resurface.",
  "A trivia rehearsal in the living room turns competitive enough to draw a crowd.",
  "A pantry shortage sparks an argument about who has been hoarding snacks.",
  "A hammock conversation runs long and the patio empties around it.",
  "A house-wide hide-and-seek of a missing personal item ends in an awkward discovery.",
  "A group workout in the yard turns into an impromptu strategy huddle.",
  "A surprise lockdown announcement scrambles everyone back inside mid-conversation.",
  "A broken air conditioner turns the living room into a shared complaint session.",
  "A themed wardrobe delivery for the week's competition sparks a costume-closet scramble.",
  "A spontaneous dance party in the kitchen pulls in half the house before curfew.",
  "A game night collapses into good-natured trash talk that lingers past midnight.",
  "A loud diary-room rehearsal through the wall draws snickers from the hallway.",
  "A laundry mix-up over borrowed clothes turns tense before cooler heads prevail.",
  "A surprise care-package photo stirs a wave of homesickness across the house.",
  "A thermostat standoff between hot and cold sleepers boils over at breakfast.",
  "A yard-game tournament gets unexpectedly competitive and a little personal.",
  "A journaling circle on the patio turns into an unplanned confession session.",
  "An early wake-up call for a surprise photo shoot leaves half the house grumbling.",
  "A shared photo album from home sparks a wave of nostalgia in the living room.",
  "A gardening chore assignment pairs up two unlikely houseguests for an afternoon.",
  "A missing snack stash reignites the never-ending kitchen-hoarding feud.",
  "A late-night round of confessions in the lounge gets more honest than planned.",
  "A pool-pump breakdown cancels the afternoon swim and tempers rise in the heat.",
  "A surprise cleaning inspection sends the house scrambling before a live show.",
  "A birthday toast with makeshift decorations turns into a rare all-house gathering.",
];

/**
 * ORW-509: the composed house-event floor. 32 fixed lines recurred inside one season and across seasons; a line is now a time-of-day lead (optional) +
 * a happening + a turn, drawn from one index so a season never repeats one and two seasons almost never share one. The 32 authored lines are kept as the
 * first region of the space. The writer (when reachable) authors house-event flavour from the season's own facts; this is the offline floor.
 */
const EVENT_TIMES: readonly string[] = [
  "", "", "Just before breakfast,", "Mid-morning,", "Right after lunch,", "Late in the afternoon,", "Just after dinner,", "Near midnight,", "In the small hours,",
  "Between challenges,", "Right after a diary-room call,", "Halfway through a house chore,",
];
const EVENT_SETUPS: readonly string[] = [
  "a broken blender sends a smoothie across the kitchen", "a stuck window leaves the living room freezing", "a forgotten pot boils dry on the stove",
  "a crossword on the coffee table draws a small crowd", "a shower-schedule chart appears on the bathroom door", "a bag of mystery snacks arrives from production",
  "a card game on the patio gets heated over the rules", "a loud storm knocks out the lights for a minute", "a hairdryer blows a fuse in the bathroom",
  "a lost sock sparks a house-wide search", "a pillow fight breaks out in the bedroom", "a cooking attempt in the kitchen goes spectacularly wrong",
  "a thermostat dispute pits the cold sleepers against everyone else", "a pool float drifts over the fence and a chase follows", "a speaker wakes half the house with a test tone",
  "a moving-day pile of laundry blocks the hallway", "a birthday that nobody planned for gets a hasty cake", "a wobbly chair gives out at the dining table",
  "a yoga session in the yard collects an unexpected audience", "a prank with plastic wrap turns the fridge into a puzzle", "a roast of the day's drama starts at the kitchen counter",
  "a bathroom line stretches down the hall", "a stack of dishes sits untouched until someone snaps", "a whiteboard of house rules gets some pointed edits",
  "a bird gets into the living room", "a long, lazy afternoon on the lawn drifts into storytelling", "a bad smell sends everyone hunting for its source",
  "a cooking pot is claimed and then argued over", "a late snack run empties the pantry", "a board game turns into a grudge match", "a mattress gets dragged out to the yard",
  "a diary-room summons interrupts a card game", "a sudden heatwave sends everyone to the pool", "a leaky tap becomes the day's main topic",
  "a quiet read in the sun is broken by a loud argument two rooms away", "a game of charades turns oddly serious", "a pile of fan mail gets read aloud",
  "a snoring complaint goes round the bedrooms", "a mislabeled lunch box sparks a small mystery", "a high-stakes hand of cards at the kitchen island splits the table",
  "a dance-off in the living room draws a crowd", "a sunrise workout is skipped by all but two", "a stuck jar lid becomes a test of pride",
  "a rumor about the next challenge spreads through the house", "a heavy rain leaves the backyard a swamp", "a tray of cookies goes missing before it cools",
  "a spilled drink on the couch starts a blame game", "a surprise visit from the production crew about a noise complaint", "a sing-along in the kitchen collects harmonies",
  "a late-night snack ritual becomes a house tradition", "a sunburn comparison on the patio gets competitive", "a power-nap schedule becomes a strategic matter",
  "a sock puppet show in the bedroom gets surprisingly good", "a quiet chess match in the lounge draws a whispering crowd", "a vegetable garden bet is settled in the yard",
  "a nickname given as a joke starts to stick", "a stack of letters is sorted by who got the most", "a hallway echo test turns into a shouting contest",
  "a first aid kit gets used for a trivial scrape", "a houseplant is named and then mourned", "an old magazine pile gets raided for quizzes",
];
const EVENT_TURNS: readonly string[] = [
  "and the whole house ends up laughing about it", "and tempers fray before anyone has eaten", "until Big Brother calls the house to order", "and two housemates quietly slip off to talk",
  "and old grievances surface along with it", "before the mood in the room shifts for the rest of the day", "and someone keeps score in their head", "and an unlikely pair ends up on the same side",
  "and by dinner it is the only thing anyone is talking about", "and the loudest voice in the room loses the argument", "while the quieter ones watch and take notes",
  "and a small truce is made and almost kept", "until someone leaves the room without a word", "and nobody can agree on what actually happened", "and a joke lands wrong with someone",
  "and the story is already being retold by the next room", "before a late apology makes it worse", "and the house splits into two camps without noticing", "and half the room goes quiet",
  "and somebody gets the last word in the diary room", "and the afternoon dissolves into gossip", "until the silence gets awkward", "and a stray comment lingers long after",
  "and for once the whole house agrees", "and an old favorite becomes a point of contention", "before it all gets blamed on whoever is out of the room",
  "and a promise to fix it is made and forgotten", "and the sulking runs well into the evening", "and a quiet kindness from someone surprises the room",
  "and the competitive streak in the house shows itself", "and it becomes a running joke by morning", "and people start choosing sides",
  "before someone offers to clean it up and everyone pretends not to hear", "until a peace offering of snacks changes the mood", "and a stray word gets taken the wrong way",
  "and the host's name for it is the one that sticks", "and a rivalry gets a new chapter", "and the evening runs on longer than planned", "until two people realize they agree after all",
  "and a favorite chair is claimed for the night", "and by morning it is somehow forgotten by all but one", "and the house settles into an uneasy routine",
  "and the noise carries to every room", "and a wary glance passes between two longtime rivals", "and someone retreats to the yard to cool off",
  "and an inside joke is born", "and the group chat of whispers is busy all night", "and no one admits to starting it", "and the mood lifts for the first time all week",
  "and the whole thing is shrugged off by morning", "and a small kindness is quietly remembered",
];

export const HOUSE_EVENT_SPACE = HOUSE_EVENT_POOL.length + EVENT_TIMES.length * EVENT_SETUPS.length * EVENT_TURNS.length;

/** The `index`th house-event line: the authored classics first, then the composed lines. Pure. */
export function houseEventLineAt(index: number): string {
  const i = ((Math.floor(index) % HOUSE_EVENT_SPACE) + HOUSE_EVENT_SPACE) % HOUSE_EVENT_SPACE;
  if (i < HOUSE_EVENT_POOL.length) return HOUSE_EVENT_POOL[i]!;
  const [time, setup, turn] = composedAt([EVENT_TIMES, EVENT_SETUPS, EVENT_TURNS], i - HOUSE_EVENT_POOL.length) as [string, string, string];
  const lead = time ? `${time} ${setup}` : `${setup[0]!.toUpperCase()}${setup.slice(1)}`;
  return `${joinWords([lead, turn])}.`.replace(/^(\w)/, (c) => c.toUpperCase());
}

export interface HouseEventOpts {
  week: number;
  phase: string;
  /** ORW-509 season memory: lines the previous seasons used (an explicit input, default empty). They are skipped while the draw can land elsewhere. */
  avoid?: ReadonlySet<string>;
}

/**
 * How many of the most-recently recorded house-events to check before picking a line, so a
 * busy week (several ambient picks) doesn't visibly repeat a line within a short stretch — a
 * window of 1 (only the immediately preceding pick) let a shallow pool cycle back into the
 * SAME line every ~12 picks, which reads as repetitive well inside an 11-week season (audit
 * finding). Scales with pool size so a deliberately small pool (e.g. in a focused test) never
 * empties the candidate set outright.
 */
const RECENT_WINDOW = Math.max(1, Math.min(10, HOUSE_EVENT_POOL.length - 1));

/**
 * The next meaningful, player-witnessed house event. Seeded (the rng decides), grounded
 * (week + day index prefix the content), and never a verbatim repeat of any of the last
 * `RECENT_WINDOW` recorded house-events — the store is queried for that recent stretch, and
 * the pick excludes any line already used in it (E58, widened by a follow-up audit).
 */
export function nextHouseEvent(events: EventStore, rng: RandomnessSource, opts: HouseEventOpts): string {
  const prior = events.query({ type: "house-event" });
  const recentContents = prior.slice(-RECENT_WINDOW).map((e) => e.content);
  // ONE rng.next() draw, exactly as before (the main stream's consumption is unchanged). It addresses the whole composed space; a line that is in the recent
  // window, or in the previous seasons' `avoid`, moves the pick to the next index (bounded probes, then the drawn line stands: never a blocked call).
  const start = Math.floor(rng.next() * HOUSE_EVENT_SPACE);
  const avoid = opts.avoid;
  let line = houseEventLineAt(start);
  for (let k = 0; k < 64; k++) {
    const cand = houseEventLineAt(start + k);
    if (recentContents.some((content) => content.includes(cand)) || avoid?.has(cand)) continue;
    line = cand;
    break;
  }
  const day = dayOfWeek(opts.phase);
  const stamp = day === null ? `Week ${opts.week}` : `Week ${opts.week}, day ${day}`;
  return `${stamp}: ${line}`;
}
