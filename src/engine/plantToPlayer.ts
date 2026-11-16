import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";

/**
 * Feature 0159 / ORW-330 (theme 2, slice 6b) - A LIE PLANTED ON THE PLAYER (the owner's Q1 ruling, option C). A houseguest who holds an ACTIVE goal against another houseguest may tell the player
 * a false story about that houseguest, the way they would plant one on an NPC. The ENGINE decides whether, and about whom (this module); slice 3's `planSpeech` decides the claim itself and that it is
 * false; the narrator only words it, handed {kind, subject, object, certainty}: never that it is a lie, never why.
 *
 * Pure rules: no I/O, no rng handle, nothing about truth or intent. The caller supplies the draws from its own seeded side stream (`${seed}:plant-to-player:...`), so no other roll moves. There is NO
 * trust gate: a manipulator lies to anyone. Rare on purpose (the house mix must not move).
 */
export const PLANT_TO_PLAYER = {
  /** THE one tuning constant: the chance, per houseguest per in-game day with a target, before cunning, candor and the crowd. */
  base: 0.02,
  /** Cunning (0..1) scales the chance by 0.5 + cunning (a schemer plants about twice as often as a plain houseguest). */
  cunningFloor: 0.5,
  /** Candor (0..1): a candid houseguest plants less. Scales the chance by 1 -+ this. */
  candorSwing: 0.4,
  /** More than this many OTHERS in earshot and nobody plants a lie on the player; below it each extra person still lowers the odds. */
  crowdMax: 2,
  crowdPenalty: 0.3,
} as const;

export interface PlantScene {
  holder: EntityId;
  /** Houseguests the holder holds an ACTIVE goal against (get-them-out / revenge / long-con), other than the holder and the player. Empty => no plant. */
  candidates: readonly EntityId[];
  /** 0..1 archetype cunning. */
  cunning: number;
  /** 0..1 candor (archetype + style). */
  candor: number;
  /** Awake others in earshot besides the holder and the player. */
  audience: number;
  /** True when the holder already told the player something today (once per houseguest per in-game day). */
  toldToday: boolean;
  /** Two uniform draws in [0,1) from the caller's `plant-to-player` side stream: whether, and which target. */
  roll: number;
  pick: number;
}

/** The chance this scene leads to a plant. Zero in a crowd. Exposed so a test can prove the gates without sampling. */
export function plantChance(s: Pick<PlantScene, "cunning" | "candor" | "audience">): number {
  if (s.audience > PLANT_TO_PLAYER.crowdMax) return 0;
  const cunning = PLANT_TO_PLAYER.cunningFloor + clamp01(s.cunning);
  const candor = 1 - PLANT_TO_PLAYER.candorSwing * (2 * clamp01(s.candor) - 1);
  const crowd = Math.max(0, 1 - PLANT_TO_PLAYER.crowdPenalty * Math.max(0, s.audience));
  return clamp01(PLANT_TO_PLAYER.base * cunning * candor * crowd);
}

/** Decide whether the holder plants a lie on the player this scene, and about whom. Deterministic in its inputs. */
export function decidePlantToPlayer(s: PlantScene): { about: EntityId } | undefined {
  if (s.toldToday) return undefined;
  const pool = [...new Set(s.candidates)].filter((id) => id !== s.holder).sort();
  if (pool.length === 0) return undefined;
  if (!(clamp01(s.roll) < plantChance(s))) return undefined;
  return { about: pool[Math.min(pool.length - 1, Math.floor(clamp01(s.pick) * pool.length))]! };
}

/** Has the holder already told the player something this in-game day? A claim recorded before the day counter exists carries no day: that is day 0 (the same reading the caller's `day` uses). */
export function toldTodayBy(told: ReadonlyArray<{ week: number; day?: number }>, week: number, day: number): boolean {
  return told.some((c) => c.week === week && (c.day ?? 0) === day);
}
