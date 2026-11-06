import type { Beat, LiveSeasonState } from "./liveSeason";
import type { TimeOfDay } from "./timeOfDay";
import { WAKE_HOUR, eventSpanHours, DAY_END_HOUR } from "./timeOfDay";
import { CLOCK } from "./sleepConstants";

/**
 * 0118 (in-game-time pivot, Phase 2) — THE DAY HAS A SHAPE. Each week's ceremonies sit at scheduled
 * in-game times, the player is TOLD when the next one lands ("the comp is this afternoon"), and when the
 * clock reaches that time the ceremony fires + gathers the whole house (the 0106 set-piece). This module
 * is the pure, deterministic, Vault-free schedule: a beat→phase map and two reads over the live state.
 *
 * It is a PURE READ — it never mutates the seeded sim, so everything built on it is calibration-identical,
 * and it is only ever SURFACED when the per-conversation clock is live (the 0108 golden replay that once pinned
 * that clock off was decommissioned 2026-07-21). In-game time only; never a wall clock.
 */

/** The player-facing structural milestones the schedule telegraphs (the ceremonies, not presentation drops). */
export type StructuralMilestone =
  | "hoh-competition"
  | "nominations"
  | "veto-competition"
  | "veto-ceremony"
  | "eviction"
  | "final-eviction"
  | "finale";

/**
 * The scheduled in-game PHASE each ceremony lands in — the day's shape, tunable in one place. Comps in the
 * AFTERNOON (the house has a morning to scramble first); ceremonies + evictions in the EVENING (the day
 * builds to them). The player is told this ahead of time, so every run-up conversation is primed for the
 * interruption. The day-position boundaries (which day each lands on) are owned by the existing night-gate
 * (0066/#1320); this map is the WITHIN-day slot.
 */
export const DAY_SCHEDULE: Record<StructuralMilestone, TimeOfDay> = {
  "hoh-competition": "afternoon",
  "nominations": "evening",
  "veto-competition": "afternoon",
  "veto-ceremony": "evening",
  "eviction": "evening",
  "final-eviction": "evening",
  "finale": "evening",
};

/** ORW-116: the veto player draw happens in the MORNING of the veto-competition day (the competition itself follows in the afternoon, `DAY_SCHEDULE["veto-competition"]`). */
export const VETO_DRAW_PHASE: TimeOfDay = "morning";

/** Readable names for the telegraphed milestones (narration priming + the HUD cue). Public, Vault-free. */
export const MILESTONE_LABEL: Record<StructuralMilestone, string> = {
  "hoh-competition": "HOH competition",
  "nominations": "nomination ceremony",
  "veto-competition": "Power of Veto competition",
  "veto-ceremony": "veto ceremony",
  "eviction": "eviction",
  "final-eviction": "final eviction",
  "finale": "finale",
};

const MILESTONE_BEATS: ReadonlySet<Beat> = new Set<Beat>(Object.keys(DAY_SCHEDULE) as Beat[]);

/** The clock-HOUR (8..32) a day-phase begins at (mirrors the per-beat clock's phase bands). */
function phaseStartHour(phase: TimeOfDay): number {
  const p = CLOCK.phaseStartsHour;
  switch (phase) {
    case "morning": return p.morning;
    case "afternoon": return p.afternoon;
    case "evening": return p.evening;
    case "night": return p.night;
    case "late-night": return p.lateNight;
  }
}

export interface NextMilestone {
  /** The next ceremony the player is heading toward (the live loop's `beat`). */
  beat: StructuralMilestone;
  /** The in-game phase it is scheduled for — what the player is told ("this afternoon"). */
  phase: TimeOfDay;
  /** The clock-hour that phase begins at (the due threshold). */
  targetHour: number;
}

/**
 * The next scheduled milestone (the current structural beat), its telegraphed phase, and its target hour —
 * or `null` when the game is not sitting on a milestone beat (pre-game, an inert/presentation beat, or the
 * `complete` terminal). A pure read of the live loop state.
 */
export function nextMilestone(live: LiveSeasonState | null | undefined): NextMilestone | null {
  const beat = live?.beat;
  if (!beat || !MILESTONE_BEATS.has(beat)) return null;
  const m = beat as StructuralMilestone;
  // ORW-116 (Ryne: "veto player draw in the morning", "the day of the veto comp"): the veto DRAW is the first advance of the veto-competition beat and is scheduled for the MORNING of the veto
  // day; the competition itself (once the field is drawn) is the afternoon. `vetoField` is set exactly when the draw has happened.
  const phase = m === "veto-competition" && !live?.vetoField ? VETO_DRAW_PHASE : DAY_SCHEDULE[m];
  return { beat: m, phase, targetHour: phaseStartHour(phase) };
}

/**
 * Has the in-game clock reached the scheduled milestone's time (⇒ the ceremony should fire + gather now)?
 * The signal the FE's time-aware forced-advance nudge consults. `false` when there is no milestone or the
 * clock hasn't started. A pure read — never mutates state, never draws rng.
 */
export function milestoneDue(live: LiveSeasonState | null | undefined): boolean {
  const m = nextMilestone(live);
  if (!m || live?.timeOfDay === undefined) return false;
  const hour = live.nightDepth ?? WAKE_HOUR;
  // ORW-116 (a): the first HOH is the afternoon of the NEXT day after the premiere evening and the social night - never that same night (the clock reads past the afternoon hour at night).
  if (live.beat === "hoh-competition" && live.week === 1 && !live.firstNightPassed && (live.dayNumber ?? 1) < 2 && hour < DAY_END_HOUR - 0.01) return false; // ...unless the night has run out: then the advance IS the day-break to the first morning (no stall on a player who never turns in)
  // Float-safe: the clock accrues in 0.2h steps (0.2 * 20 = 3.999999999999986...), so a scene that reaches EXACTLY the scheduled hour (the 8am wake + a 4h scene
  // cap = the 12:00 afternoon start) landed at 11.999999999999986 and was never "due" - a stall once the front-end stopped firing events ahead of the schedule.
  return hour + 1e-6 >= m.targetHour;
}

/**
 * 0119 (in-game-time pivot, Phase 3) — which duration CATEGORY a resolved beat belongs to. Comps run
 * long, ceremonies are quick, evictions are in between; the finale is a long endgame event. Beats with no
 * distinct duration (staged presentation drops, twists, the terminal) are absent ⇒ the caller keeps the
 * flat per-beat default.
 */
const DURATION_CATEGORY: Partial<Record<Beat, "competition" | "ceremony" | "eviction">> = {
  "hoh-competition": "competition",
  "final-hoh-part": "competition", // 0128: each part of the three-part Final HOH costs a competition's time
  "veto-competition": "competition",
  "nominations": "ceremony",
  "veto-ceremony": "ceremony",
  "eviction": "eviction",
  "final-eviction": "eviction",
  "finale": "eviction",
};

/**
 * 0119 — the in-game HOURS a resolved beat COSTS the day: a quick nomination/veto ceremony ~1h, a
 * competition ~3h, an eviction/finale ~2h (from the shared `EVENT_DURATION` library, via `eventSpanHours`).
 * `null` for a beat with no distinct felt duration ⇒ the caller keeps the flat per-beat default. Pure; no
 * rng. The caller applies this ONLY when the per-conversation clock is live, so golden replay (that clock
 * off) keeps the flat default and stays byte-identical — the different-events-cost-different-time layer is
 * dormant exactly where the seeded/recorded streams must not move.
 */
export function beatFeltHours(beat: Beat | undefined): number | null {
  if (!beat) return null;
  const cat = DURATION_CATEGORY[beat];
  return cat ? eventSpanHours(cat) : null;
}

/**
 * A7 - whole MINUTES of in-game time until the next scheduled milestone is due (0 once due), or `null` when there is no milestone / the clock has not started.
 * Feeds the FE's optional "production announces it in a few minutes" warning. A pure read - never mutates, never draws rng.
 */
export function minutesUntilDue(live: LiveSeasonState | null | undefined): number | null {
  const m = nextMilestone(live);
  if (!m || live?.timeOfDay === undefined) return null;
  const hour = live.nightDepth ?? WAKE_HOUR;
  return Math.max(0, Math.ceil((m.targetHour - hour) * 60 - 1e-6));
}
