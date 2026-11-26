import type { RandomnessSource } from "../ports/RandomnessSource";

/**
 * "Hang out until X" (PO ask 2026-11-04) - the player's safe fast-forward. A bounded run of SHORT engine-timed beats
 * (15-30 in-game minutes each) that stops at the FIRST of: the scheduled event coming due, the player being pulled
 * (diary room / production), an NPC approaching or interrupting, something noteworthy observed, or bedtime.
 *
 * PURE: all world knowledge arrives through `HangOutProbes`, all chance through the injected (side-stream) rng, so the
 * runner never touches the season spine. The probes are consulted in a FIXED priority order after every beat, and the
 * beat itself is CLAMPED to the next scheduled event so a hang-out can never fire - or skip past - an event.
 */
export const HANGOUT = {
  /** Beat length, minutes: 15 + 5*k for k in 0..3 (15, 20, 25, 30). */
  beatMinutesBase: 15,
  beatMinutesStep: 5,
  beatMinutesChoices: 4,
  /** Hard cap on beats per call (the PO said ~6-8). */
  maxBeats: 8,
  /** ORW-445: hard cap on a player-STATED wait, minutes (never more than 3 h, whatever they asked for). */
  maxStatedMinutes: 180,
  /** ORW-1054: hard cap on a wait for the NEXT SCHEDULED EVENT ("hang out until production calls"), minutes: the rest of a day's waking span; bedtime still stops it sooner. */
  maxUntilEventMinutes: 480,
} as const;

export type HangOutStopReason = "event-due" | "pulled" | "npc-approach" | "observed" | "bedtime" | "max-beats";

export interface HangOutProbes {
  /** Advance the in-game clock by `hours` (the caller owns clamping at the pre-dawn edge). */
  advance(hours: number): void;
  /** Hours until the next scheduled event is due; `null` when nothing is scheduled. Never negative. */
  hoursUntilEvent(): number | null;
  /** Is the scheduled event due NOW? */
  eventDue(): boolean;
  /** Has the player reached bedtime (the evening threshold they have not turned in past)? Checked BEFORE the first beat too. */
  bedtime(): boolean;
  /** Is the player pulled (diary room / production) after this beat? Draws only from `rng`. */
  pulled(rng: RandomnessSource, beat: number): { by: "diary-room" | "production" } | null;
  /** Does an awake NPC approach/interrupt the player after this beat? */
  approach(rng: RandomnessSource, beat: number): { npc: string; desire?: string } | null;
  /** Does the player observe something noteworthy after this beat? */
  observed(rng: RandomnessSource, beat: number): { kind: string; who: string[] } | null;
}

export interface HangOutResult {
  stopReason: HangOutStopReason;
  /** Beats actually run (0 when the stop fired before the first one). */
  beats: number;
  /** Total in-game minutes spent (sum of the beats actually advanced). */
  minutes: number;
  /** Vault-free public detail of the stop: who pulled / approached / what was seen. */
  detail?: { by?: string; npc?: string; desire?: string; kind?: string; who?: string[] };
}

export function runHangOut(p: HangOutProbes, rng: RandomnessSource, opts: { maxBeats?: number; maxMinutes?: number; capMinutes?: number } = {}): HangOutResult {
  // ORW-445: a player-stated target. Absent/invalid => the original behaviour, byte-identical (same rng draws, same cap).
  const target = typeof opts.maxMinutes === "number" && Number.isFinite(opts.maxMinutes) && opts.maxMinutes > 0 ? Math.min(typeof opts.capMinutes === "number" && opts.capMinutes > 0 ? opts.capMinutes : HANGOUT.maxStatedMinutes, opts.maxMinutes) : null;
  // A target needs room to be reached with the shortest beats (15 min): the beat count scales to it, never past the 3 h cap.
  // Review of #2772: an explicitly supplied `maxBeats` still caps a stated wait; only an OMITTED cap scales to the target.
  const stated = typeof opts.maxBeats === "number" && Number.isFinite(opts.maxBeats) ? Math.max(1, Math.floor(opts.maxBeats)) : null;
  const cap = target !== null
    ? Math.max(1, stated !== null ? Math.min(stated, Math.ceil(target / HANGOUT.beatMinutesBase)) : Math.ceil(target / HANGOUT.beatMinutesBase))
    : Math.max(1, Math.min(HANGOUT.maxBeats, Math.floor(opts.maxBeats ?? HANGOUT.maxBeats)));
  if (p.eventDue()) return { stopReason: "event-due", beats: 0, minutes: 0 };
  if (p.bedtime()) return { stopReason: "bedtime", beats: 0, minutes: 0 };
  let minutes = 0;
  for (let beat = 1; beat <= cap; beat++) {
    let beatMin = HANGOUT.beatMinutesBase + HANGOUT.beatMinutesStep * rng.int(HANGOUT.beatMinutesChoices);
    const until = p.hoursUntilEvent();
    // Float residue guard (the 11.999... stall): a sub-minute remainder IS the event - without this every beat clamps to ~0 minutes and burns the cap doing nothing.
    if (until !== null && until * 60 < 1) {
      // ORW-437: a REAL sub-minute remainder (more than the clock's own 1e-6 h tolerance) is spent now so the event fires once; returning without advancing left it un-due and every call repeated this stop.
      if (until > 1e-6) {
        // Review of #2778: never past a stated target. If the target ends before the event, spend only what is left of it and stop on the target.
        const room = target !== null ? Math.max(0, target - minutes) : Infinity;
        const spend = Math.min(until * 60, room);
        if (spend > 0) { p.advance(spend / 60); minutes += spend; }
        if (spend < until * 60 - 1e-9) return { stopReason: "max-beats", beats: beat, minutes: Math.round(minutes) };
      }
      return { stopReason: "event-due", beats: beat - 1, minutes: Math.round(minutes) };
    }
    if (until !== null) beatMin = Math.min(beatMin, Math.max(0, until) * 60); // never past the event
    if (target !== null) beatMin = Math.min(beatMin, target - minutes); // never past the stated target
    p.advance(beatMin / 60);
    minutes += beatMin;
    if (p.eventDue()) return { stopReason: "event-due", beats: beat, minutes: Math.round(minutes) };
    const pulled = p.pulled(rng, beat);
    if (pulled) return { stopReason: "pulled", beats: beat, minutes: Math.round(minutes), detail: { by: pulled.by } };
    const ap = p.approach(rng, beat);
    if (ap) return { stopReason: "npc-approach", beats: beat, minutes: Math.round(minutes), detail: { npc: ap.npc, ...(ap.desire ? { desire: ap.desire } : {}) } };
    const ob = p.observed(rng, beat);
    if (ob) return { stopReason: "observed", beats: beat, minutes: Math.round(minutes), detail: { kind: ob.kind, who: ob.who } };
    if (p.bedtime()) return { stopReason: "bedtime", beats: beat, minutes: Math.round(minutes) };
    if (target !== null && minutes >= target - 1e-9) return { stopReason: "max-beats", beats: beat, minutes: Math.round(minutes) };
  }
  return { stopReason: "max-beats", beats: cap, minutes: Math.round(minutes) };
}

/**
 * ORW-734a - "wait until <clock time>": the minutes from the engine's clock `nowDepth` (the 8..32 day scale; an early-morning wake reads 0..8) to the NEXT time the wall clock reads
 * `clockHour` (0..24, e.g. 22 for 10pm, 22.5 for 10:30pm). Never a day later: a time that already passed within this day is 0, nothing to wait. null = not a usable hour. Pure, no rng.
 */
export function minutesUntilClock(nowDepth: number, clockHour: number, wakeHour = 8, dayEnd = 32): number | null {
  if (!Number.isFinite(nowDepth) || !Number.isFinite(clockHour) || clockHour < 0 || clockHour >= 24) return null;
  // ORW-911: an early-morning wake (the player up before the house, the clock reading 0..wakeHour) is the NEW day already: the day scale resumes at the house's wake-up call, so a later clock time (9am, 1pm) is simply
  // that many hours on: reading it as the small hours of the day before (+24) put every target after the wake-up call past the day's end and waited nothing ("I wait until 9am" moved the clock 0 minutes).
  if (nowDepth < wakeHour) return clockHour > nowDepth + 1e-6 ? (clockHour - nowDepth) * 60 : 0;
  const cur = nowDepth;
  const candidates = clockHour < wakeHour ? [clockHour + 24] : clockHour === wakeHour ? [clockHour, dayEnd] : [clockHour];
  const next = candidates.find((c) => c > cur + 1e-6 && c <= dayEnd);
  return next === undefined ? 0 : (next - cur) * 60;
}

/**
 * Is it "bedtime" for a hang-out? From midnight on, or once the NIGHT block (20:00+) has thinned the house to the player plus at most one awake houseguest. The thin-house rule applies
 * ONLY in the evening/night: at 5am after an early wake (P4d) a sleeping house is not "bedtime" - the hang-out should run on until the house wakes. Pure.
 */
export function hangOutBedtime(hour: number, awakeNpcs: number, nightStartHour = 20, midnightHour = 24): boolean {
  return hour >= midnightHour || (hour >= nightStartHour && awakeNpcs <= 1);
}

/**
 * ORW-22 - the PLAYER-FACING line for a hang-out stop (public facts only: names and the stop kind, never a hidden state). Every stop kind the engine produces has one, so the stop is
 * visible on screen whether or not the narrator voices it. Pure.
 */
export function hangOutStopLine(r: Pick<HangOutResult, "stopReason" | "detail">): string {
  const d = r.detail ?? {};
  switch (r.stopReason) {
    case "event-due": return "The house is being called together.";
    case "pulled": return d.by === "diary-room" ? "You are called to the Diary Room." : "Production pulls you aside.";
    case "npc-approach": return `${d.npc ?? "A housemate"} comes over to talk to you.`;
    case "observed": {
      const who = d.who ?? [];
      return d.kind === "overheard-whisper" ? `${who.join(" and ")} are whispering together out of earshot.`
        : d.kind === "argument" ? `${who.join(" and ")} are in a tense exchange.`
        : `${who[0] ?? "Someone"} is crossing the house.`;
    }
    case "bedtime": return "It is getting late; the house is winding down.";
    default: return "A stretch of time passes with nothing demanding you.";
  }
}
