/**
 * ORW-253 slice 3 core: every tunable of hour-by-hour house life (`houseLife.ts`) in one module (the B59 pattern).
 */
import type { Archetype } from "./characterFactory";
import type { TimeOfDay } from "./timeOfDay";

/** A houseguest's everyday habits (kept here so houseLife.ts and this table share it without an import cycle). */
export type Habit = "early-riser" | "night-owl" | "gym-rat" | "house-cook" | "neat-freak" | "napper" | "devout" | "camera-talker" | "storyteller" | "card-shark" | "sun-seeker";

export const HOUSE_LIFE = {
  /** ORW-702: friction scales from `dramaFrom` on day 1 to `dramaTo` after `dramaOverDays` days (see `dramaScale`): drama builds over the season. */
  dramaFrom: 0.6,
  dramaTo: 1.8,
  dramaOverDays: 70,
  /** How strongly a goal pulls its holder into acting on it this hour (x commitment), against the pull of ordinary life. */
  goalDrive: 1.0,
  /** ORW-350: the most hours (share) a houseguest spends on their goals; the rest are ordinary life whatever their goals are. A pressing goal's commitment climbs toward 0.85+ as the weeks go (get-them-out 0.54 in the first days, 0.85-0.88 by
   *  week 2), and past the pull of ordinary life (0.5-0.9 by time of day) it won every hour, so the house turned into scheming: bonding 55% to 18%, gossip 13% to 69% across 800 chat-paced messages. */
  goalHourCeiling: 0.7,
  /** ORW-702: the chance a goal step that folds as gossip (fish, plant, wedge, frame, leak, test-a-rumor) actually takes the hour; otherwise the hour goes to ordinary life. Gossip was 42 to 49 % of a whole season's scenes (band 22-36). */
  goalGossipKeep: 0.5,
  /** ORW-702: the same for a goal step that folds as strategy (check-in, count-votes, flip-a-vote...): strategy rose as gossip fell. Measured on the guard seeds with the surviving player (ORW-702). */
  goalStrategyKeep: 0.85,
  /** ORW-353 (A's live week: 16 of 588 off-screen scenes were conflict and ALL were chore fights, none from a goal, though 64 get-them-out goals existed): a HOT get-them-out goal (commitment above `hotGoal`) sharing a room with its target adds
   *  up to this much to the chance of a direct confrontation, whatever the holder's temper. */
  hotConfront: 0.22,
  /** The commitment above which a goal counts as hot (it climbs to 0.85+ when the target is a real threat). */
  hotGoal: 0.7,
  /** A season-long MAIN aim (run the house, be liked...) pulls at this share of a pressing goal's drive (ORW-315 tuning: it dominated hours). */
  mainAimDrive: 0.35,
  /** The pull of ordinary house life by time of day (a goal must beat this x a seeded roll to be pursued this hour). Mornings and late nights are for living. */
  lifePull: { morning: 0.9, afternoon: 0.6, evening: 0.5, night: 0.7, "late-night": 0.9 } as Readonly<Record<TimeOfDay, number>>,
  /** A content houseguest (emotional > 0.6) is pulled a little more toward plain living. */
  contentLifeBonus: 0.15,
  /** ORW-656: the chance, per houseguest per stretch, that someone in the winner's room reacts to the result while the beat is still the one right after the crown. */
  afterBuzzerChance: 0.25, // ORW-656: shrunk from 0.6 after the 12-season house-mix guard read conflict 10.7 vs the 5.2 reference (the taunt folds a conflict scene): the span, not the tolerance
  /** Chance a habit that fits the time of day is followed when no goal is pursued. */
  habitChance: 0.6,
  /** ORW-337 (spec 0146 lane 2): a house ritual's chance to pull anyone free into its action at its time of day. `npcMindsAuthored.AUTHORED.ritualPull` is this value. */
  ritualPull: 0.3,
  /** ORW-566 (spec 0183): the chance a CLOSE pair (allies, or a mutual tie at the habit floor) whose partner is already at their spot meets there for a debrief in the hours after a ceremony. Scaled by the culture's meetings dial. */
  pairHabitPull: 0.4,
  /** Chance a showmance pair spends a free hour together when both are around. */
  romanceChance: 0.5,
  /** ORW-620 (night owls): in the night hours, with only a few houseguests still up, the chance an awake houseguest with nothing pressing seeks out another awake one for a late-night talk. Conservative on purpose
   *  (an A10 weight past about 1.5 once failed juryReach at seed 18); it only ever REPLACES an ordinary free hour. */
  nightOwlPull: 0.28,
  /** ORW-620: the pull is a little stronger in the small hours (the awake few are the ones who stay). */
  nightOwlLateScale: 1.3,
  /** ORW-620: "few awake" = at most this many other houseguests up. */
  nightOwlMaxOthers: 5,
  /** ORW-620: a mild lean toward whoever already has company up (the awake gather), per awake houseguest in that room. */
  nightOwlGatherLean: 0.05,
  /** ORW-620: below this mood a late-night talk turns to a confession (the small hours loosen the tongue). */
  nightOwlConfessMood: 0.42,
  /** ORW-466 slice 4: at night, the chance a free houseguest with an awake roommate ends the day with them in their own bedroom (bed talk, or a squabble if they rub each other wrong). */
  roommateNightPull: 0.5,
  /** ORW-466 slice 4: when they do, the chance it is their double-bed partner (the closest roommate tie) rather than whichever roommate they warm to most. */
  bedPartnerPull: 0.6,
  /** Base chance a free hour with someone they don't warm to turns into a chore fight (scaled by dislike, temper and mood; ORW-324). */
  frictionChance: 0.33,
  /** ORW-324: affinity below this counts as dislike for friction (was 0.3: friction only between enemies made the house 99% friendly). */
  frictionAffinity: 0.45,
  /** ORW-324: how quick each archetype is to direct friction (confronting a target, a chore fight). */
  temper: {
    hothead: 0.75, wildcard: 0.6, villain: 0.5, "comp-beast": 0.45, mastermind: 0.25, analyst: 0.2, flirt: 0.3, floater: 0.15,
    "social-butterfly": 0.2, underdog: 0.3, loyalist: 0.35, peacemaker: 0.08,
  } as Readonly<Record<Archetype, number>>,
  /** ORW-324: chance a free hour with company turns to gossip about someone not in the room (the house's ordinary talk). */
  gossipChance: 0.58,
  /** Chance a light free hour with company is a prank. */
  prankChance: 0.15,
  /** Scheming speech (a long con, a frame, a plant) is false this much more often than the holder's normal candor. */
  schemingLieBoost: 0.35,
  /** A habit the archetype leans to gets this bonus in the habit draw (the draw itself is a 0..1 roll). */
  habitLeanBonus: 0.5,
  habitLean: {
    "comp-beast": ["gym-rat", "early-riser"], mastermind: ["night-owl", "card-shark"], "social-butterfly": ["storyteller", "house-cook"],
    floater: ["napper", "sun-seeker"], villain: ["night-owl", "camera-talker"], underdog: ["devout", "neat-freak"],
    flirt: ["sun-seeker", "night-owl"], loyalist: ["house-cook", "early-riser"], wildcard: ["camera-talker", "card-shark"],
    analyst: ["early-riser", "neat-freak"], hothead: ["gym-rat", "camera-talker"], peacemaker: ["house-cook", "devout"],
  } as Readonly<Record<Archetype, readonly Habit[]>>,
} as const;

/**
 * ORW-551 / spec 0168 slice 2: the season's house culture as plain multipliers on the house BASELINE of four dials (the caller reads them from `dialMult`; this module stays pure).
 * Absent (a headless game, the flag off, a load with no culture) = every multiplier exactly 1 = byte-identical house life. `conflict` is a THRESHOLD multiplier
 * (below 1 = a lower threshold = MORE conflict), so the chance is divided by it. The culture scales the baseline BEFORE the per-person terms (temper, mood, candor), so an individual still pushes against it.
 */
export interface HouseCulture {
  gossip: number; conflict: number; flirting: number; lying: number;
  /** ORW-566 (spec 0183): the meetings dial scales how often a close pair keeps its debrief; absent = 1. */
  meetings?: number;
}
/** How far a culture's lying multiplier (1 = none) shifts a speaker's candor, additively: (lying - 1) x this, so at the 1.35 clamp about 0.09 less candid. */
export const CULTURE_CANDOR_SHIFT = 0.25;

/**
 * ORW-621 (0198, the people in your room live too): the pacing of the steps the houseguests in the PLAYER's room take in front of them. Bounded on purpose, so the
 * room never turns into a stage play that drowns the player's own talk: the player's turn stays primary.
 */
export const ROOM_LIFE = {
  /** The chance a stretch with two or more houseguests in the player's room has ANY of them take a step there (a keyed roll, never a shared draw). */
  chance: 0.4,
  /** Most steps taken in the player's room in ONE stretch. */
  perStretch: 1,
  /** Most steps taken in the player's room in ONE in-game hour (the extra stretches of a beat that covered hours, a nap or a hang-out count together), and a houseguest takes at most one of them. */
  perHour: 2,
  /** How many recent events are read back to count the hour's steps (the cap lives in the record, so a restart cannot reset it). */
  lookback: 400,
} as const;
