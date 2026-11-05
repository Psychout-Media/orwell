import { clamp } from "../domain/num";
/**
 * 0066 — the single tunable home for the in-game-time / sleep economy (ADR 0006), the accepted 24-hour
 * model (#1125). One module per layer (the B59 convention — siblings: `trajectoryConstants`,
 * `juryHouseConstants`, `triggerConstants`): NO sleep/time magnitude is inlined at a call site, so the
 * whole economy retunes here without touching logic. Everything is ENGINE-ONLY and Vault-class — no
 * number here ever crosses to the player or admin (mandate #2); the player feels these only as later
 * behavior (a worse comp, a flatter late-night house, a crankier tired houseguest) + their own cue.
 *
 * THE 24-HOUR MODEL. A day is 24 hours, measured from the 8am forced wake:
 *   morning   [8,12)  · afternoon [12,16) · evening [16,20) · night [20,24) · late-night [24,32)
 * The clock runs `hourOfDay` ∈ [8, 32): 8 = the morning wake, 32 = the next 8am (a new day). It clamps
 * at the bitter end (never silently wraps) — a new day begins ONLY at the 8am forced wake (everyone up).
 *
 * SLEEP (symmetric, player + NPC): an 8-hour sleep need against the fixed 8am wake.
 *   • bed at midnight (h=24) → 8h → wake exactly at 8am → 0 debt.
 *   • bed AFTER midnight (h>24) → woken early at 8am → debt = h − 24 (hours of sleep lost).
 *   • bed BEFORE midnight (h<24) → 8h sleep lands BEFORE 8am → wake in the pre-dawn tail (h+8) → 0 debt
 *     + bonus awake time (the early-riser window). Two distinct late-night windows: post-midnight owls
 *     (costly) vs pre-dawn larks (free).
 * Debt is GRADED → a hidden, bounded comp penalty + (ext2) next-day social fatigue + (ext3) the
 * compounding multi-night meter. No rng anywhere — bedtimes are DERIVED, the meter is a pure EMA — so
 * with every flag ON the seeded competition/vote/jury stream is never re-phased (zero extra draws); and
 * dormant off the opt-in clock ⇒ byte-identical to the calibration spine.
 */

/** Clamp helper — shared by the pure sleep math (kept local so this module imports no logic). */

// --- The 24-hour clock ----------------------------------------------------------------------------

export interface ClockConstants {
  /** The forced morning wake — the hour a new day begins; everyone is up (8 = 8am). */
  wakeHour: number;
  /** Hours in a full day (the clock runs `wakeHour` … `wakeHour + dayLengthHours`). */
  dayLengthHours: number;
  /** Phase boundaries in hours-of-day (start of each band; `late-night` runs to wakeHour+24). */
  phaseStartsHour: { morning: number; afternoon: number; evening: number; night: number; lateNight: number };
  /** Midnight in clock-hours (the pivot: bed past here costs debt; bed before earns a pre-dawn window). */
  midnightHour: number;
  /** The fixed 8-hour sleep need (bed → +sleepNeedHours → wake, unless the 8am wake comes first). */
  sleepNeedHours: number;
  /**
   * How far one SUBSTANTIVE-PLAY beat (a resolved ceremony/eviction/finale beat — `advanceGame`) advances
   * the clock, in HOURS. A few hours per beat, so a day fits a believable handful of ceremony beats and
   * the public phase rolls over several of them (the anti-lurch fix).
   */
  perBeatHours: number;
  /**
   * Phase-2 (Extension 1 — per-conversation clock advance). How far ONE player social TURN — a beat of
   * lingering/playing WITHIN a ceremony beat — advances the clock, in HOURS, when no felt duration is
   * proposed (the FLOOR; Extension 5 supplies the real per-conversation felt time). Deliberately SMALL: a
   * long, engaging conversation moves time believably (a day has finite scheming time, felt turn-by-turn)
   * but NEVER rushes — the clock clamps at the bitter end and never wraps the night without the player's
   * own `turnIn` (or a ceremony beat), so it can never skip the player past their bedtime choice (ADR 0003
   * / the lull rule: engagement-driven, never a turn counter).
   */
  perConversationHours: number;
}

/** P4d (ASSUMED, pending Ryne): the earliest a player can wake, and the earliest bedtime that wakes early (a daytime turn-in never wakes before lying down). */
export const EARLY_WAKE_FLOOR_HOUR = 5;
export const EARLY_WAKE_MIN_BED_HOUR = 20;

export const CLOCK: ClockConstants = {
  wakeHour: 8,
  dayLengthHours: 24,
  phaseStartsHour: { morning: 8, afternoon: 12, evening: 16, night: 20, lateNight: 24 },
  midnightHour: 24,
  sleepNeedHours: 8,
  // ~3h/beat: a morning HOH (8–11) leaves the rest of the day playable; a 5-beat week spans a few days.
  perBeatHours: 3,
  // ~0.5h/lingering turn — the floor when no felt duration is proposed (Extension 5 sets the real value).
  perConversationHours: 0.5,
};

/**
 * P4c (PO ruling, Ryne 2026-11-04): the clock ticks per MESSAGE, continuously, so production and NPCs can interrupt mid-conversation and 3 messages are never hours.
 * ONE constant to tune: `MINUTES_PER_MESSAGE` (5 => ~48 ordinary messages per 4h block). Cost depends ONLY on message count: nothing bills by conversation kind or by the
 * narrator's proposed `feltMinutes` (conversation types - passing / casual / strategy / summit - emerge from how many messages they run).
 */
export const MINUTES_PER_MESSAGE = 5;

export const SCENE = {
  perExchangeHours: MINUTES_PER_MESSAGE / 60,
} as const;

/** The default pace a player experiences: ordinary messages from a morning wake (8am) to the afternoon start (12) - derived, never set independently (= 48). */
export const MESSAGES_PER_MORNING = Math.round((CLOCK.phaseStartsHour.afternoon - CLOCK.wakeHour) / SCENE.perExchangeHours);

/**
 * 0117 (in-game-time pivot, Phase 1) — the in-game hours that must elapse during the player's social
 * play before the off-screen house schemes again. This is the cadence at which the hidden society
 * (0038 scenes + gossip + motivated movement + campaigns/drives) lives BETWEEN ceremonies, paced to the
 * in-game clock rather than to a per-tool-call counter. With the per-conversation clock stepping the
 * floor (~0.5h/turn), the house lives roughly every few social turns; a ceremony beat's +3h jump always
 * clears it, so beat-driven ticks are unchanged. Tunable; a lower value = a livelier between-ceremony
 * house. Purely gates the OPEN-set texture layer — the seeded spine and the Vault Wall never read it.
 */
export const SOCIETY_TICK_HOURS = 1.5;

// --- Bedtimes & the immediate (single-night) sleep debt -------------------------------------------

export interface SleepConstants {
  /**
   * Character-driven bedtime in clock-HOURS, mapped off the night-owl lean (`social − physical`). The
   * earliest larks bed at `earliestBedHour`; the latest owls at `latestBedHour` (past midnight → real
   * debt). A lark bedding before midnight wakes in the pre-dawn window; an owl bedding after pays debt.
   */
  earliestBedHour: number;
  latestBedHour: number;
  /**
   * The most sleep debt counted (hours). A houseguest who never turns in is "awake" to the 8am wake — a
   * full night lost; the debt saturates here so it stays bounded for the graded penalty.
   */
  maxDebtHours: number;
}

export const SLEEP: SleepConstants = {
  // Larks bed at ~21:00 (→ sleep to 05:00, a pre-dawn riser); owls bed at ~26:00 / 2am (→ 2h debt).
  earliestBedHour: 21,
  latestBedHour: 26,
  // A full night up to the 8am wake ≈ 8h lost; cap the counted debt there so it stays bounded.
  maxDebtHours: 8,
};

// --- Extension 2: NPC next-day social fatigue (its own opt-in flag) -------------------------------
//
// A tired houseguest is less able to MOVE THE NEEDLE socially — the magnitude of the relationship fold
// their scenes drive on others is dampened (EFFECTIVENESS, never a personality change: the scene's nature
// is unchanged, only how far it shifts the other's belief). Floored so even a wrecked houseguest still
// has SOME sway. A CHARACTER conflict also drains the houseguest in it, so they turn in EARLIER that night
// (the causation runs conflict → earlier bedtime; sleep debt never AUTHORS conflict). All dormant unless
// the dedicated social-fatigue flag is on ⇒ scale 1 / no drain ⇒ byte-identical.

export interface SocialFatigueConstants {
  /**
   * The dampening of WARMING (positive) social sway at a FULL sleep deficit (1). Tired ⇒ worse at charm:
   * bonding, building trust, warming a bond all land LESS. 0 ⇒ no effect even at max deficit.
   */
  swayDamp: number;
  /** The floor WARMING sway-scale: even a fully-wrecked houseguest still charms this much. */
  swayFloor: number;
  /**
   * The ASYMMETRIC negative bias (#1419 owner ruling): tired ⇒ barbs cut DEEPER. A SOURING (negative)
   * fold — conflict, souring a bond, raising threat — is AMPLIFIED by this gain × the deficit, so it
   * is *harder to scheme* when you're not sleeping (positive nudges weaken) while spats hit harder.
   */
  soreGain: number;
  /** The cap on the souring amplification, so a tired spat stays bounded (never runs away). */
  soreCap: number;
  /** How many HOURS earlier ONE conflict pulls a houseguest's character bedtime tonight. */
  conflictBedtimeDrainHours: number;
  /** The earliest a conflict-drained houseguest will bed (hour floor) — never before the early-evening. */
  bedtimeHourFloor: number;
}

export const SOCIAL_FATIGUE: SocialFatigueConstants = {
  swayDamp: 0.6,   // at full deficit a WARMING fold lands at the floor (×0.4)
  swayFloor: 0.4,
  soreGain: 0.35,  // at full deficit a SOURING fold hits ~×1.35 (capped)
  soreCap: 1.4,
  conflictBedtimeDrainHours: 1, // one fight pulls bedtime ~an hour earlier
  bedtimeHourFloor: 20,         // never before 8pm (the start of `night`)
};

/**
 * The WARMING fold-magnitude scale (≤1) for a houseguest carrying `deficit` sleep debt (0..1). 1 at
 * deficit 0 (rested ⇒ byte-identical), dropping to the floor at a full deficit — a tired houseguest is
 * worse at charm (bonding / trust-building / warming a bond). Pure (no rng) — it scales an ALREADY-decided
 * fold; it never adds a draw to any stream. Pairs with `soreSwayScale` for the asymmetric (#1419) model.
 */
export function socialSwayScale(deficit: number): number {
  return Math.max(SOCIAL_FATIGUE.swayFloor, 1 - SOCIAL_FATIGUE.swayDamp * clamp(deficit, 0, 1));
}

/**
 * The SOURING fold-magnitude scale (≥1) for a houseguest carrying `deficit` sleep debt (#1419 asymmetric
 * ruling: "a bias for negative consequence"). 1 at deficit 0 (rested ⇒ byte-identical), rising to
 * `soreCap` at a full deficit — a tired houseguest's spats and threat-reads cut DEEPER. Pure (no rng).
 */
export function soreSwayScale(deficit: number): number {
  return Math.min(SOCIAL_FATIGUE.soreCap, 1 + SOCIAL_FATIGUE.soreGain * clamp(deficit, 0, 1));
}

// --- Extension 3: the compounding multi-night fatigue meter (its own opt-in flag) -----------------
//
// One late night stings the next day (the immediate deficit); a STRING of them wears you down further.
// The meter is an EMA of the nightly deficits — each new night adds last night's deficit and decays the
// prior by RECOVERY (so a rested night recovers, consecutive late nights stack toward 1). It ADDS to the
// immediate deficit (weighted, bounded) for both the comp fold and social sway. Pure (no rng). Dormant
// unless the dedicated multi-night flag is on ⇒ the meter is never accrued ⇒ 0 ⇒ byte-identical.

export interface FatigueMeterConstants {
  /** How much of yesterday's accumulated fatigue carries into today (a rested night decays it by this). */
  recovery: number;
  /** How much the accumulated meter adds on top of the immediate single-night deficit. */
  weight: number;
}

export const FATIGUE: FatigueMeterConstants = {
  recovery: 0.5, // a rested night halves yesterday's fatigue
  weight: 0.5,   // the accumulated meter adds up to half-again on top of the immediate deficit
};

/** Roll the fatigue meter forward one night: decay the prior, add last night's deficit. Bounded [0,1]. */
export function accrueFatigue(prevMeter: number, lastNightDeficit: number): number {
  return clamp(prevMeter * FATIGUE.recovery + lastNightDeficit, 0, 1);
}

/** Combine tonight's immediate deficit with the accumulated multi-night fatigue (bounded). */
export function combinedRestDeficit(immediate: number, fatigueMeter: number): number {
  return clamp(immediate + FATIGUE.weight * fatigueMeter, 0, 1);
}

// --- Extension 4: EMERGENT NPC bedtimes — independent sleep debt (its own opt-in flag) -------------
//
// The fairness fix (owner ruling 2026-07-12): an NPC's sleep debt must be incurred on the SAME footing as
// the player's — driven by how late THEY were up, not capped by the player's own bedtime. But we must NOT
// re-introduce a flat archetype tax (a social/owl NPC always a touch tired): a night-owl lingers late ONLY
// when they have late-night COMPANY (other natural owls still up) or the player kept the house up — and
// beds down at the social floor on a dead night, paying nothing. So the debt is EARNED (you stayed up with
// company), never structural. Pure + deterministic (company is a count off the same chronotype math). Off
// (company 0 / clock off) ⇒ byte-identical to the pre-feature player-capped deficit.

export interface AfterHoursConstants {
  /**
   * How many OTHER natural night-owls (active NPCs whose own bedtime runs past midnight) count as FULL
   * late-night company. At/above this many, an owl lingers to their full chronotype bedtime (real debt);
   * ALONE (0), they wind down to the social floor — midnight, or later if the player kept the house up —
   * and carry no debt. Linear between. Tunable; ~3 reads as "a few people still up" in a 15-guest house.
   */
  companyFull: number;
}

export const AFTER_HOURS: AfterHoursConstants = { companyFull: 3 };

// --- Extension 5: conversation durations (LOOSE — ADR 0005 for time) ------------------------------
//
// A scene's FELT duration is open-set: the LLM proposes how long it took; the engine COMMITS it BOUNDED
// to the scene type's range (never 0, never a day-skip). Absent a proposal ⇒ the type BASELINE, so the
// clock advance is byte-identical to "no proposal" (the expressiveNonCollapse-for-time floor). An engaged
// scene is NEVER cut by the clock — the duration only ADVANCES time after the scene; it never ends one.

export type ConversationKind = "passing" | "casual" | "game" | "summit";

export interface ConversationDurationConstants {
  /** Per scene-kind: the baseline felt hours (the floor when no duration is proposed) + the bound. */
  baselineHours: Record<ConversationKind, number>;
  minHours: Record<ConversationKind, number>;
  maxHours: Record<ConversationKind, number>;
}

export const CONVERSATION_DURATION: ConversationDurationConstants = {
  // passing word ~0.5h · casual chat ~1h · a game conversation ~1.5h · a long summit ~2h.
  baselineHours: { passing: 0.5, casual: 1, game: 1.5, summit: 2 },
  minHours: { passing: 0.25, casual: 0.5, game: 0.75, summit: 1 },
  maxHours: { passing: 1, casual: 2, game: 3, summit: 4 },
};

/**
 * Commit a conversation's felt duration in HOURS, BOUNDED to the kind's range (ADR 0005 for time): the LLM
 * proposes the open-set felt time; the engine keeps the bounded interpretation. No proposal (`undefined`)
 * ⇒ the kind BASELINE — byte-identical to the pre-feature floor. A non-finite/≤0 proposal ⇒ the baseline
 * too (never 0, never a day-skip). Pure; no rng.
 */
export function conversationHours(kind: ConversationKind, proposedHours?: number): number {
  const baseline = CONVERSATION_DURATION.baselineHours[kind];
  if (proposedHours === undefined || !Number.isFinite(proposedHours) || proposedHours <= 0) return baseline;
  return clamp(proposedHours, CONVERSATION_DURATION.minHours[kind], CONVERSATION_DURATION.maxHours[kind]);
}

/**
 * Phase 2 (duration-based clock) — the LLM's per-scene felt-time proposal, in MINUTES, bounded to a sane
 * envelope in HOURS. The narrator sizes each social scene ("a quick word ~15–30 min, a long strategy
 * summit ~2–3 h") and the engine keeps the bounded value (ADR 0005 for time): the clamp stops the model
 * moving the clock absurdly (anti-abuse) and keeps the day realistic — a scene is at least a short beat
 * and at most a long summit, mirroring the CONVERSATION_DURATION envelope (passing.min … summit.max). A
 * non-finite / ≤0 proposal ⇒ the small per-conversation floor (byte-identical to "no proposal").
 */
export const SCENE_FELT_MINUTES = { min: 15, max: 240 };

export function feltHoursFromMinutes(minutes: number | undefined): number {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return CLOCK.perConversationHours;
  return clamp(minutes, SCENE_FELT_MINUTES.min, SCENE_FELT_MINUTES.max) / 60;
}

// --- Event durations + seeded start-within-period (deterministic, no shared-stream rng) -----------
//
// A ceremony/comp/eviction has a typical DURATION and starts at a SEEDED offset WITHIN its period (not
// pinned to the edge), and may spill into the next period. The offset is a deterministic hash of the
// seed + beat — a SIDE computation that draws NO shared-stream rng, so the seeded calibration spine is
// untouched. Comps vary BY TYPE via the 0042 library (endurance long, quick-fire short); the durations
// here are the defaults a competition def can override.

export interface EventDurationConstants {
  /** Typical hours each timed beat occupies (comps can be overridden per 0042 competition def). */
  hoursByBeat: { competition: number; ceremony: number; eviction: number };
  /** The fraction of a 4-hour period a beat's seeded start may fall within (0..startWindowFrac). */
  startWindowFrac: number;
}

export const EVENT_DURATION: EventDurationConstants = {
  hoursByBeat: { competition: 3, ceremony: 1, eviction: 2 },
  // a beat starts somewhere in the first ~60% of its period (leaves room to run without always spilling).
  startWindowFrac: 0.6,
};

// --- The weekly 5-cycle cadence + period placement (#1125) ----------------------------------------
//
// The within-day PERIOD of each beat is NOT here: DAY_SCHEDULE (daySchedule.ts) is the one timetable.
//
// A "week" is one HOH reign (HOH → noms → veto comp → veto ceremony → eviction), STRICT order, no default
// rest days, the daily-event invariant holds. The 24-hour model places each beat in a PERIOD so the HOH
// crowns in the MORNING (maximizing the post-HOH playable window — the rest of Day 1), the veto comp runs
// in the AFTERNOON (Day 3 has the player draw in the morning + the comp after), and the EVICTION is in the
// EVENING (Day 5). The next HOH begins the MORNING AFTER the eviction (Day 6 — NOT eviction night), so the
// eviction→HOH gap is the one light "process the eviction" beat. This is the canonical placement the BDD
// cadence scenario asserts; the live clock advances by `perBeatHours` and the schedule (`schedule.ts`)
// owns the strict beat ORDER — this just records which time-of-day each lands in.

export type WeekBeat = "hoh" | "nominations" | "veto-draw" | "veto-competition" | "veto-ceremony" | "eviction";

export interface WeeklyCadenceConstants {
  /** The strict 5-cycle beat order (one HOH reign), the daily-event spine. */
  order: readonly WeekBeat[];
  /** Which day (1-indexed within the week) each beat falls on. */
  dayOf: Record<WeekBeat, number>;
}

export const WEEKLY_CADENCE: WeeklyCadenceConstants = {
  order: ["hoh", "nominations", "veto-draw", "veto-competition", "veto-ceremony", "eviction"],
  // Day 1 HOH · Day 2 noms · Day 3 veto draw + veto comp · Day 4 veto ceremony · Day 5 eviction.
  dayOf: { hoh: 1, nominations: 2, "veto-draw": 3, "veto-competition": 3, "veto-ceremony": 4, eviction: 5 },
};
