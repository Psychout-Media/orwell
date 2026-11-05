/**
 * In-game time of day + the nightly sleep economy (ADR 0006), the accepted 24-HOUR model (#1125). A PURE
 * domain helper: the five public day-phases as HOUR BANDS, how the clock advances by PLAY (never a
 * wall-clock), each houseguest's character-driven bedtime HOUR, the BIDIRECTIONAL awake set (the house
 * thins toward midnight then refills toward the 8am wake), the player's own qualitative rest read, and the
 * hidden GRADED sleep DEBT the competition fold consumes. No I/O and — critically — no shared-stream
 * randomness: a bedtime is DERIVED deterministically from a houseguest's STATIC aptitudes (CHARACTER,
 * never the soul/Vault), so the seeded calibration spine (juryReach / UAT golden streams) stays
 * byte-identical and a bedtime is stable for the whole season (it is who they are, not a roll).
 *
 * THE DAY (hours-of-day, from the 8am forced wake):
 *   morning [8,12) · afternoon [12,16) · evening [16,20) · night [20,24) · late-night [24,32)
 * The clock runs `hourOfDay` ∈ [8, 32) and CLAMPS at the bitter end — it never silently wraps; a new day
 * begins ONLY at the 8am forced wake (everyone up). The player is never auto-slept (Principle 6); they
 * choose when to turn in. The bound on "functionally infinite" scheming is diegetic (Principle 3): as the
 * night runs past midnight, NPCs turn in and the awake set thins; then pre-dawn larks wake and it refills.
 */

import { CLOCK, SCENE, EARLY_WAKE_FLOOR_HOUR, EARLY_WAKE_MIN_BED_HOUR, SLEEP, EVENT_DURATION, AFTER_HOURS, type AfterHoursConstants } from "./sleepConstants";

export { SLEEP, type SleepConstants } from "./sleepConstants";

/** The five PUBLIC day-phases (ADR 0006). Not a clock — a coarse, shared, Vault-free band. */
export type TimeOfDay = "morning" | "afternoon" | "evening" | "night" | "late-night";

/** Phase order — the day runs front to back; `late-night` is the last phase before the 8am wake. */
export const TIME_OF_DAY_ORDER: readonly TimeOfDay[] = [
  "morning", "afternoon", "evening", "night", "late-night",
];

/** The day begins here (the 8am forced wake after every night). */
export const DAY_START: TimeOfDay = "morning";

/** The clock-hour a fresh day starts at (the 8am forced wake) — the canonical `hourOfDay` floor. */
export const WAKE_HOUR = CLOCK.wakeHour;
/** The clock-hour the day ENDS at (the next 8am): `hourOfDay` clamps just below this. */
export const DAY_END_HOUR = CLOCK.wakeHour + CLOCK.dayLengthHours;
/** The length of one day-PERIOD in hours (morning/afternoon/evening/night are each this; 4h). */
export const PERIOD_HOURS = CLOCK.phaseStartsHour.afternoon - CLOCK.phaseStartsHour.morning;

/** Public, natural display label for the time-of-day HUD (the morning→late-night graphic, no clock). */
export const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  night: "Night",
  "late-night": "Late night",
};

/** The player's OWN, qualitative rest read (ADR 0006 §Principle 5 — their own body, never a number). */
export type RestStatus = "rested" | "tired" | "running on empty";

/** Static aptitudes a bedtime is read off of (the CHARACTER `stats` — Vault-free, byte-stable). */
export interface BedtimeStats {
  physical: number;
  social: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** Position of a phase in the day (0 = morning … 4 = late-night). */
export function phaseIndex(phase: TimeOfDay): number {
  return TIME_OF_DAY_ORDER.indexOf(phase);
}

/**
 * The next phase as the day rolls forward by PLAY. Clamps at `late-night` — the day does NOT silently
 * wrap to the next morning here; a new day begins only at the 8am forced wake (`rollToMorning`). So
 * advancing the clock can never skip past the late-night band where the player's bedtime choice lives.
 */
export function nextPhase(phase: TimeOfDay): TimeOfDay {
  const i = phaseIndex(phase);
  return TIME_OF_DAY_ORDER[Math.min(i + 1, TIME_OF_DAY_ORDER.length - 1)]!;
}

/** Whether the day has reached its final, post-midnight hours (the bedtime decision is live here). */
export function isLateNight(phase: TimeOfDay): boolean {
  return phase === "late-night";
}

// --- The hour clock <-> the public phase band ------------------------------------------------------

/** Project a clock-HOUR (8..32) onto the public 5-phase band. Clamps to the day's bounds. */
export function phaseForHour(hour: number): TimeOfDay {
  const h = clamp(hour, WAKE_HOUR, DAY_END_HOUR - 0.0001);
  const p = CLOCK.phaseStartsHour;
  if (h < p.afternoon) return "morning";
  if (h < p.evening) return "afternoon";
  if (h < p.night) return "evening";
  if (h < p.lateNight) return "night";
  return "late-night";
}

/**
 * Back-compat shim: the live state field is still named `nightDepth`, but in the 24-hour model it carries
 * the clock-HOUR (8..32), not a 0..1 depth. `phaseForDepth` therefore just delegates to `phaseForHour`.
 * (The field name is kept so persisted saves round-trip; the value's meaning is the hour-of-day.)
 */
export function phaseForDepth(hour: number): TimeOfDay {
  return phaseForHour(hour);
}

/** A small deterministic string→[0,1) hash (FNV-1a; NO rng, NO imports) for per-NPC chronotype spread. */
function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// --- Character-driven bedtimes (in clock-hours) ----------------------------------------------------

/**
 * A houseguest's CHARACTER bedtime HOUR. DERIVED purely from static aptitudes — the `social − physical`
 * lean (the social game stays up to scheme; the comp-focused protect their sleep) blended with a
 * DETERMINISTIC per-NPC variation hashed off the id, so two similar-stat houseguests still differ, yet a
 * bedtime is byte-stable for the season and draws no randomness. Maps to `[earliestBedHour, latestBedHour]`
 * — roughly 21:00 for the earliest larks (→ a pre-dawn riser) to ~2am for the strongest owls (→ real
 * debt). With no `id` (the legacy call shape) the chronotype variation is omitted — a pure stats function.
 */
export function bedtimeHourFor(stats: BedtimeStats, id?: string): number {
  const lean = clamp((stats.social - stats.physical) / 0.5, -1, 1); // social → owl (+), comp-focused → lark (−)
  const jitter = id ? hashUnit(id) * 2 - 1 : 0;                     // deterministic per-NPC spread, ∈ [−1, 1)
  const chrono = clamp(0.6 * lean + 0.4 * jitter, -1, 1);          // ∈ [−1, 1]
  const span = SLEEP.latestBedHour - SLEEP.earliestBedHour;
  return SLEEP.earliestBedHour + ((chrono + 1) / 2) * span;        // ∈ [earliestBedHour, latestBedHour]
}

/**
 * Back-compat: `bedtimeDepthFor` now returns the bedtime as a clock-HOUR (the field name is legacy; the
 * value is the hour, consumed by `awakeSet`/`phaseForHour` consistently). Same signature as before.
 */
export function bedtimeDepthFor(stats: BedtimeStats, id?: string): number {
  return bedtimeHourFor(stats, id);
}

/**
 * The coarse 5-phase character bedtime (the legacy projection): the PHASE a houseguest's bedtime HOUR
 * falls in. Larks bed in `evening`/`night`, owls in `late-night`. Kept for the older callers/tests.
 */
export function bedtimeFor(stats: BedtimeStats): TimeOfDay {
  return phaseForHour(bedtimeHourFor(stats));
}

// --- The BIDIRECTIONAL awake set -------------------------------------------------------------------

/**
 * Whether a houseguest with bedtime hour `bedHour` is awake at clock-hour `hour`. BIDIRECTIONAL across the
 * late-night block (ADR 0006, the 24-hour model):
 *   • Before they turn in (`hour < bedHour`) they are awake.
 *   • After they turn in they sleep `sleepNeedHours`, UNLESS the 8am wake comes first.
 *   • If they bedded BEFORE midnight, they wake in the pre-dawn tail (`bedHour + sleepNeedHours`) and are
 *     awake again until the new day — the early-riser window.
 * So the awake set SHRINKS evening→midnight (owls retiring) then GROWS midnight→8am (larks rising).
 */
export function isAwakeAtHour(hour: number, bedHour: number): boolean {
  // P4d: the clock can now sit BEFORE the 8am wake (a player who bedded early wakes early). An hour before the wake belongs to the NEXT morning of last night's bed, so a
  // houseguest is up if their own 8h sleep (bed + 8 - 24) has ended by then. Hours >= the wake are untouched (byte-identical).
  if (hour < WAKE_HOUR) return hour >= bedHour + CLOCK.sleepNeedHours - CLOCK.dayLengthHours;
  if (hour < bedHour) return true;                     // still up tonight
  const wakeAgain = bedHour + CLOCK.sleepNeedHours;     // when their 8h sleep would end
  return hour >= wakeAgain;                             // back up in the pre-dawn window (if before the 8am wake)
}

/** Legacy phase-keyed awake predicate (coarse): awake through their bedtime phase, asleep after. Kept for
 *  the old call shape; the live society uses the hour-keyed `awakeSet` below. */
export function isAwakeAt(phase: TimeOfDay, bedtime: TimeOfDay): boolean {
  return phaseIndex(phase) <= phaseIndex(bedtime);
}

/**
 * The awake set at a clock-HOUR: the active houseguests still up (or risen again pre-dawn). The PLAYER is
 * always awake unless they have chosen to turn in (never auto-slept — ADR 0006 §Principle 6). `bedtimeOf`
 * returns each NPC's bedtime HOUR. As the night runs past midnight this thins toward the player + the
 * latest owls, then refills as pre-dawn larks rise — the diegetic, bidirectional bound.
 */
export function awakeSet(opts: {
  active: readonly string[];
  hour: number;
  player: string;
  playerRetired: boolean;
  bedtimeOf: (id: string) => number;
}): string[] {
  return opts.active.filter((id) =>
    id === opts.player ? !opts.playerRetired : isAwakeAtHour(opts.hour, opts.bedtimeOf(id)),
  );
}

// --- Sleep debt (graded, symmetric) ----------------------------------------------------------------

/**
 * The sleep DEBT in HOURS a houseguest carries from how late they were up: the hours of their 8-hour need
 * cut short by the 8am forced wake. Bed at/before midnight ⇒ 0 (their 8h finishes by 8am — a lark even
 * wakes early). Bed AFTER midnight ⇒ `bedHour − midnight`, capped at `maxDebtHours`. Symmetric (the same
 * math for the player and every NPC). Pure; no rng.
 */
export function sleepDebtHours(bedHour: number): number {
  return clamp(bedHour - CLOCK.midnightHour, 0, SLEEP.maxDebtHours);
}

/**
 * The GRADED hidden sleep deficit (0..1) from a bedtime HOUR — `sleepDebtHours` normalized by the cap.
 * 0 for a healthy night (bed by midnight), ramping to 1 for a full night up. This is the continuous
 * replacement for the old binary table; it feeds the comp fold + (ext2) social sway + (ext3) the meter.
 * Bounded; combined with the outcome `sleepPenalty` weight, never a raw number to the player.
 */
export function sleepDeficitForBedHour(bedHour: number): number {
  return sleepDebtHours(bedHour) / SLEEP.maxDebtHours;
}

/**
 * Back-compat: `restDeficitForDepth` now takes the clock-HOUR the houseguest was last awake to (the field
 * is `lastSleepDepth`, legacy name, now an hour) and returns the graded 0..1 deficit. Bed by midnight ⇒ 0.
 */
/**
 * P4d - the hour the player wakes after turning in at `bedHour`: bedtime + 8h of sleep, never later than the 8am wake and never earlier than `EARLY_WAKE_FLOOR_HOUR`. Only an
 * EVENING bed (>= `EARLY_WAKE_MIN_BED_HOUR`) wakes early; a daytime turn-in falls back to the 8am wake. Pure.
 */
export function wakeHourAfterBed(bedHour: number): number {
  if (bedHour < EARLY_WAKE_MIN_BED_HOUR) return WAKE_HOUR;
  return clamp(bedHour + CLOCK.sleepNeedHours - CLOCK.dayLengthHours, EARLY_WAKE_FLOOR_HOUR, WAKE_HOUR);
}

export function restDeficitForDepth(lastAwakeHour: number): number {
  return sleepDeficitForBedHour(lastAwakeHour);
}

/**
 * 0066 Extension 4 — an NPC's EMERGENT bedtime HOUR: how late they ACTUALLY stayed up, driven by their own
 * nature + circumstance, NOT capped at the player's bedtime (the fairness fix — the player is no longer the
 * only free agent of the night). A night-owl (chronotype `base` past the social floor) lingers toward their
 * full `base` ONLY with late-night COMPANY (`company` = other natural owls still up); ALONE they wind down
 * to the social floor and pay nothing (no flat archetype tax). The social floor is midnight, extended if the
 * player kept the house up past it (`nightEndHour` = when the night's sim ended / the player turned in) —
 * a late house keeps everyone up. A lark whose `base` is already before the floor keeps their own early bed.
 *
 * Purely deterministic (no rng), so it never perturbs a seeded stream. `company === 0` ⇒ the owl collapses
 * to the social floor = `min(base, max(midnight, nightEndHour))`, whose DEFICIT (via `restDeficitForDepth`)
 * is byte-identical to the pre-feature player-capped `min(base, nightEndHour)` — the calibration floor.
 */
export function emergentBedtimeHour(
  base: number, company: number, nightEndHour: number, c: AfterHoursConstants = AFTER_HOURS,
): number {
  const socialFloor = Math.max(CLOCK.midnightHour, nightEndHour); // the free late window; a late house extends it
  if (base <= socialFloor) return base;                           // beds before the window closes ⇒ their own (early) bed
  const companyFactor = clamp(company / c.companyFull, 0, 1);      // 0 alone → 1 with a crowd of fellow owls
  return socialFloor + companyFactor * (base - socialFloor);      // linger toward `base` with company; else the floor
}

/**
 * Legacy phase-keyed deficit (coarse): only `late-night` (post-midnight) carries any cost. Kept for the
 * old call shape (`restDeficitFor(bedtimeFor(stats))`); the live path uses the graded hour version.
 */
export function restDeficitFor(latestPhaseAwake: TimeOfDay): number {
  return latestPhaseAwake === "late-night" ? 1 : 0;
}

/**
 * The player's OWN qualitative tiredness, from the graded sleep deficit (0..1). Their own body is their own
 * knowledge (ADR 0006 §Principle 5) — a cue, never a number, and never any NPC's state. Rested below a
 * mild deficit, tired in the middle, running-on-empty near a full night up.
 */
export function restStatusForDeficit(deficit: number): RestStatus {
  if (deficit >= 0.6) return "running on empty";
  if (deficit > 0) return "tired";
  return "rested";
}

/**
 * Back-compat: `restStatusFor` now takes the clock-HOUR last awake (legacy `lastSleepPhase` was a phase;
 * callers pass the hour). Maps through the graded deficit so the cue tracks the real debt.
 */
export function restStatusFor(lastAwakeHour: number): RestStatus {
  return restStatusForDeficit(sleepDeficitForBedHour(lastAwakeHour));
}

// --- Event durations + seeded start-within-period (#1125 — deterministic, no shared-stream rng) ----
//
// A timed beat (a competition / ceremony / eviction) starts at a SEEDED offset WITHIN its 4-hour period
// (not pinned to the edge) and may SPILL into the next period. The offset is a deterministic hash of the
// seed + a beat key — a SIDE computation that draws NO shared-stream rng, so the seeded calibration spine
// is untouched (the comps/votes resolve on the same stream regardless of when, in-fiction, they "start").
// Comps vary BY TYPE (the 0042 library): pass the competition's own `durationHours` to override the default.

/** The hours a beat occupies. Comps default to the library/EVENT_DURATION value; pass an override per type. */
export function eventSpanHours(beat: "competition" | "ceremony" | "eviction", overrideHours?: number): number {
  if (overrideHours !== undefined && Number.isFinite(overrideHours) && overrideHours > 0) return overrideHours;
  return EVENT_DURATION.hoursByBeat[beat];
}

/**
 * The SEEDED start HOUR of a beat within its period: `periodStartHour` + a deterministic offset in
 * `[0, periodHours · startWindowFrac)`. Hashes the seed + `beatKey` (e.g. `"hoh:w1"`) — same seed+key ⇒
 * same start (replay-stable), different beats ⇒ different offsets (not all pinned to the period edge). The
 * 4-hour period length is `PERIOD_HOURS`. Draws NO shared rng. Pure.
 */
export function eventStartHour(periodStartHour: number, seed: number, beatKey: string): number {
  const window = PERIOD_HOURS * EVENT_DURATION.startWindowFrac;
  let h = (Math.imul(seed | 0, 0x01000193) >>> 0) ^ 0x811c9dc5;
  for (let i = 0; i < beatKey.length; i++) { h ^= beatKey.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  const frac = ((h >>> 0) % 100000) / 100000; // ∈ [0,1)
  return periodStartHour + frac * window;
}

/** Whether a beat starting at `startHour` and running `spanHours` SPILLS past its 4-hour period boundary. */
export function eventSpillsPeriod(startHour: number, spanHours: number): boolean {
  const periodStart = WAKE_HOUR + Math.floor((startHour - WAKE_HOUR) / PERIOD_HOURS) * PERIOD_HOURS;
  return startHour + spanHours > periodStart + PERIOD_HOURS;
}

// --- Phase-2 extension math (re-exported from the single tunable home) ----------------------------
//
// `socialSwayScale` (Extension 2) dampens a tired houseguest's fold EFFECTIVENESS; `accrueFatigue`/
// `combinedRestDeficit` (Extension 3) compound consecutive late nights; `conversationHours` (Extension 5)
// commits the LOOSE, type-bounded felt duration. All pure — no rng — and gated OFF (scale 1 / meter 0 /
// baseline floor) by their dedicated flags ⇒ byte-identical when off.
export {
  socialSwayScale, soreSwayScale, accrueFatigue, combinedRestDeficit, conversationHours,
  SOCIAL_FATIGUE, FATIGUE, CONVERSATION_DURATION,
  type ConversationKind,
} from "./sleepConstants";
// `CLOCK` + `EVENT_DURATION` are also used in this module's bodies (imported above) — re-export the local bindings.
export { CLOCK, SCENE, EVENT_DURATION };

// Legacy-name aliases for the few call/test sites that referenced the flat constants by name (kept so this
// refactor is byte-neutral to importers; the values now live in `sleepConstants`).
import { SOCIAL_FATIGUE, FATIGUE } from "./sleepConstants";
export const SOCIAL_SWAY_DAMP = SOCIAL_FATIGUE.swayDamp;
export const SOCIAL_SWAY_FLOOR = SOCIAL_FATIGUE.swayFloor;
export const CONFLICT_BEDTIME_DRAIN = SOCIAL_FATIGUE.conflictBedtimeDrainHours;
export const BEDTIME_DEPTH_FLOOR = SOCIAL_FATIGUE.bedtimeHourFloor;
export const FATIGUE_RECOVERY = FATIGUE.recovery;
export const FATIGUE_WEIGHT = FATIGUE.weight;

/**
 * P0 clock grounding - the engine's exact in-game clock as a short plain label, e.g. "9:40am, Day 1". `hour` is the engine's clock hour (`live.nightDepth`: 8 = 8:00am, 12 = noon, 24 = midnight,
 * 27.08 = 3:05am the next night); minutes are rounded to the nearest whole minute. Pure. Day is the in-game day number (1-based). Never a wall-clock; the narrator is told to use THIS and no other time.
 */
export function formatClockLabel(hour: number, day: number): string {
  const total = Math.round(hour * 60);
  const mins = ((total % 1440) + 1440) % 1440;
  const h24 = Math.floor(mins / 60);
  const mm = mins % 60;
  const suffix = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")}${suffix}, Day ${Math.max(1, Math.floor(day))}`;
}
