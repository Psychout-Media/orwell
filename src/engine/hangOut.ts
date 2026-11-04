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

export function runHangOut(p: HangOutProbes, rng: RandomnessSource, opts: { maxBeats?: number } = {}): HangOutResult {
  const cap = Math.max(1, Math.min(HANGOUT.maxBeats, Math.floor(opts.maxBeats ?? HANGOUT.maxBeats)));
  if (p.eventDue()) return { stopReason: "event-due", beats: 0, minutes: 0 };
  if (p.bedtime()) return { stopReason: "bedtime", beats: 0, minutes: 0 };
  let minutes = 0;
  for (let beat = 1; beat <= cap; beat++) {
    let beatMin = HANGOUT.beatMinutesBase + HANGOUT.beatMinutesStep * rng.int(HANGOUT.beatMinutesChoices);
    const until = p.hoursUntilEvent();
    // Float residue guard (the 11.999... stall): a sub-minute remainder IS the event - without this every beat clamps to ~0 minutes and burns the cap doing nothing.
    if (until !== null && until * 60 < 1) return { stopReason: "event-due", beats: beat - 1, minutes: Math.round(minutes) };
    if (until !== null) beatMin = Math.min(beatMin, Math.max(0, until) * 60); // never past the event
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
  }
  return { stopReason: "max-beats", beats: cap, minutes: Math.round(minutes) };
}
