import type { Archetype, StrategyStyle } from "./characterFactory";

/**
 * ORW-963 item 3 (Ryne 2026-11-26: "Depends on the houseguest"): how long an unanswered alliance pitch stays open comes from the pitcher's own character, never a fixed timer. Patient or loyal types keep it open
 * longer; impatient or paranoid types read silence as a no sooner, and may cool on the one who did not answer. The same for a pitch to the player and to a houseguest. Pure; no draw; no number leaves the engine.
 */
const STYLE_DAYS: Readonly<Record<StrategyStyle, number>> = { loyal: 3, "under-the-radar": 2, strategic: 1, social: 0, emotional: -1, aggressive: -2 };
const ARCHETYPE_DAYS: Partial<Record<Archetype, number>> = { loyalist: 2, peacemaker: 1, analyst: 1, floater: 1, hothead: -2, wildcard: -1, villain: -1 };

export const PITCH_PATIENCE = {
  baseDays: 4,
  minDays: 1,
  maxDays: 9,
  /** At or under this many days the pitcher is the impatient kind: a lapsed pitch cools their read of the one who left it hanging. */
  coolsAtDays: 3,
  cool: { trust: -0.05, affinity: -0.03 },
} as const;

export function pitchPatienceDays(p: { archetype?: Archetype; style?: StrategyStyle; volatility?: number; paranoia?: number }): number {
  const days = PITCH_PATIENCE.baseDays + (p.style ? STYLE_DAYS[p.style] : 0) + (p.archetype ? ARCHETYPE_DAYS[p.archetype] ?? 0 : 0)
    - Math.round(2 * Math.max(0, (p.volatility ?? 0) - 0.5) * 2) - Math.round(2 * Math.max(0, p.paranoia ?? 0));
  return Math.max(PITCH_PATIENCE.minDays, Math.min(PITCH_PATIENCE.maxDays, days));
}
