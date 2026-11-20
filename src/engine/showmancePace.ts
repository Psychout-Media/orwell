import type { EntityId } from "../domain/ids";
import { agendaRoll } from "./agenda";
import { SHOWMANCE_PACE } from "./attractionLife";

/**
 * ORW-736 (0207 amendment, PO ruling: "showmances are a slower build over several weeks, not a switch turned on"): the PACE of a showmance. Pure, no I/O, no shared rng (the per-pair jitter is one draw on the keyed side stream
 * `${seed}:showmance-pace:${pairKey}`), no Vault, never a number shown to anyone. One machine for every pair: a seeded NPC pair and the player's own romance (the player's pair is only ever created by the player's own acts, and
 * only ever moves with the time the player actually spends with them: the engine never advances it FOR the player).
 *
 * Levels: 0 spark, 1 bond (the two have grown close; nobody has registered it), 2 sensed (close allies of either have caught it), 3 noticed (the room has), 4 known (house-wide: the public couple). The seeded showmance stage
 * maps 0 -> spark, 1..3 -> bond, 4 -> visible, so every existing reader of the stage keeps working and only becomes slower.
 * A step up needs ALL of: the days spent in the level before it, the chemistry accumulated (shared days x the pair's mutual chemistry) past that level's bar, and (from level 2 up) that many people having caught it. The public couple
 * additionally needs the season to be late enough. Progress only accrues while the pair is together and neither is in crisis; it decays while they are apart and a level that loses its footing falls back ONE step (a couple the whole house knows does not become unknown: it can only end). Every step, up or
 * down, is appended to `steps` with who had caught it at that moment: history is append-only (non-degradation); only `progress` and `level` are state.
 */
export type PaceLevel = 0 | 1 | 2 | 3 | 4;

export interface PaceStep { day: number; from: PaceLevel; to: PaceLevel; /** who had caught the pair at that step (the player included only if they did) */ seenBy: EntityId[] }
export interface PaceRecord {
  level: PaceLevel;
  /** accrued chemistry-days (shared days x mutual chemistry); decays while apart */
  progress: number;
  /** the in-game day the pair entered the current level */
  since: number;
  /** the in-game day of the last tick (progress accrues over the days between ticks) */
  lastDay: number;
  /** the last in-game day the pair were together (apart counts from here) */
  lastTogetherDay: number;
  /** the shared days (the pair's `together` count in days) at the last tick, so the next tick adds only what is new */
  lastShared: number;
  steps: PaceStep[];
}

export const freshPace = (day: number, shared: number): PaceRecord => ({ level: 0, progress: 0, since: day, lastDay: day, lastTogetherDay: day, lastShared: shared, steps: [] });

/** The keyed per-pair pace factor (1 +/- jitter): how fast THIS pair builds. One draw on a keyed side stream, never the shared rng. */
export function paceFactor(seed: number, pairKey: string): number {
  const r = agendaRoll(seed, "showmance-pace" as EntityId, pairKey); // the keyed side stream for `${seed}:showmance-pace:${pairKey}`: a hash of the keys, never the shared rng
  return 1 + SHOWMANCE_PACE.jitter * (2 * r - 1);
}

export interface PaceInput {
  day: number;
  /** the pair's shared days so far (monotone) */
  shared: number;
  /** the weaker side's chemistry for the other (0..1); for the player's pair, the houseguest's (the player's own side is never modelled) */
  mutualChemistry: number;
  /** either of them is in a crisis today (on the block) */
  inCrisis: boolean;
  /** the houseguests who have caught the romance (saw a scene of it or were told), not the pair themselves */
  observers: readonly EntityId[];
  /** how many houseguests are in the house to notice (the pair excluded) */
  room: number;
  /** how many of those count as close allies of either of the pair */
  closeObservers: number;
  factor: number;
}

/** The chemistry-days a level needs (cumulative) to be reached, scaled by the pair's own pace. */
export const barFor = (level: PaceLevel, factor: number): number => SHOWMANCE_PACE.bars[level - 1]! * factor;

/** Does the noticing this level needs hold: people who caught it (levels 2..4), by who they are and how many. */
function noticed(level: PaceLevel, p: PaceInput): boolean {
  if (level <= 1) return true;
  if (level === 2) return p.closeObservers >= 1;
  const share = p.room > 0 ? p.observers.length / p.room : 0;
  return level === 3 ? share >= SHOWMANCE_PACE.roomShare : share >= SHOWMANCE_PACE.houseShare;
}

/** One tick: returns a NEW record (pure). A step up or down is appended to `steps`; at most one step per tick. */
export function paceTick(rec: PaceRecord, p: PaceInput): PaceRecord {
  const elapsed = Math.max(0, p.day - rec.lastDay);
  const newShared = Math.max(0, p.shared - rec.lastShared);
  let progress = rec.progress;
  if (!p.inCrisis && newShared > 0) progress = Math.min(barFor(4, p.factor), progress + newShared * Math.max(0, Math.min(1, p.mutualChemistry))); // together and calm: it builds (up to the public couple's bar, no further)
  else if (newShared <= 0 && elapsed > 0 && p.day - rec.lastTogetherDay > SHOWMANCE_PACE.apartGraceDays) progress = Math.max(0, progress - elapsed * SHOWMANCE_PACE.decayPerDayApart); // apart past the grace: it cools
  // (in crisis while together: it neither builds nor cools: a stall)
  const next: PaceRecord = { ...rec, progress, lastTogetherDay: newShared > 0 ? p.day : rec.lastTogetherDay, lastDay: Math.max(rec.lastDay, p.day), lastShared: Math.max(rec.lastShared, p.shared), steps: rec.steps };
  const days = p.day - rec.since;
  const up = (rec.level + 1) as PaceLevel;
  if (rec.level < 4 && days >= (SHOWMANCE_PACE.minDays as readonly number[])[rec.level]! * p.factor && progress >= barFor(up, p.factor) && noticed(up, p) && (up < 4 || p.day >= SHOWMANCE_PACE.publicNotBeforeDay)) {
    return { ...next, level: up, since: p.day, steps: [...rec.steps, { day: p.day, from: rec.level, to: up, seenBy: [...p.observers] }] };
  }
  if (rec.level > 0 && rec.level < 4 && progress < barFor(rec.level, p.factor) * SHOWMANCE_PACE.fadeBelow) {
    const down = (rec.level - 1) as PaceLevel;
    return { ...next, level: down, since: p.day, steps: [...rec.steps, { day: p.day, from: rec.level, to: down, seenBy: [...p.observers] }] };
  }
  return next;
}

/** The seeded showmance stage a pace level stands for. */
export const stageOfLevel = (level: PaceLevel): "spark" | "bond" | "visible" => (level === 0 ? "spark" : level === 4 ? "visible" : "bond");
