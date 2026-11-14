/**
 * ORW-253 slice 3 core: every tunable of hour-by-hour house life (`houseLife.ts`) in one module (the B59 pattern).
 */
import type { Archetype } from "./characterFactory";
import type { TimeOfDay } from "./timeOfDay";

/** A houseguest's everyday habits (kept here so houseLife.ts and this table share it without an import cycle). */
export type Habit = "early-riser" | "night-owl" | "gym-rat" | "house-cook" | "neat-freak" | "napper" | "devout" | "camera-talker" | "storyteller" | "card-shark" | "sun-seeker";

export const HOUSE_LIFE = {
  /** How strongly a goal pulls its holder into acting on it this hour (x commitment), against the pull of ordinary life. */
  goalDrive: 1.0,
  /** ORW-350: the most hours (share) a houseguest spends on their goals; the rest are ordinary life whatever their goals are. A pressing goal's commitment climbs toward 0.85+ as the weeks go (get-them-out 0.54 in the first days, 0.85-0.88 by
   *  week 2), and past the pull of ordinary life (0.5-0.9 by time of day) it won every hour, so the house turned into scheming: bonding 55% to 18%, gossip 13% to 69% across 800 chat-paced messages. */
  goalHourCeiling: 0.8,
  /** A season-long MAIN aim (run the house, be liked...) pulls at this share of a pressing goal's drive (ORW-315 tuning: it dominated hours). */
  mainAimDrive: 0.35,
  /** The pull of ordinary house life by time of day (a goal must beat this x a seeded roll to be pursued this hour). Mornings and late nights are for living. */
  lifePull: { morning: 0.9, afternoon: 0.6, evening: 0.5, night: 0.7, "late-night": 0.9 } as Readonly<Record<TimeOfDay, number>>,
  /** A content houseguest (emotional > 0.6) is pulled a little more toward plain living. */
  contentLifeBonus: 0.15,
  /** Chance a habit that fits the time of day is followed when no goal is pursued. */
  habitChance: 0.6,
  /** ORW-337 (spec 0146 lane 2): a house ritual's chance to pull anyone free into its action at its time of day. `npcMindsAuthored.AUTHORED.ritualPull` is this value. */
  ritualPull: 0.3,
  /** Chance a showmance pair spends a free hour together when both are around. */
  romanceChance: 0.5,
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
  gossipChance: 0.65,
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
