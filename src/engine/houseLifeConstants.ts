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
  /** A season-long MAIN aim (run the house, be liked...) pulls at this share of a pressing goal's drive (ORW-315 tuning: it dominated hours). */
  mainAimDrive: 0.35,
  /** The pull of ordinary house life by time of day (a goal must beat this x a seeded roll to be pursued this hour). Mornings and late nights are for living. */
  lifePull: { morning: 0.9, afternoon: 0.6, evening: 0.5, night: 0.7, "late-night": 0.9 } as Readonly<Record<TimeOfDay, number>>,
  /** A content houseguest (emotional > 0.6) is pulled a little more toward plain living. */
  contentLifeBonus: 0.15,
  /** Chance a habit that fits the time of day is followed when no goal is pursued. */
  habitChance: 0.6,
  /** Chance a showmance pair spends a free hour together when both are around. */
  romanceChance: 0.5,
  /** Chance two houseguests who dislike each other turn a shared hour into a chore fight. */
  frictionChance: 0.4,
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
