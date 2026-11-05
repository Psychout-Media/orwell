# 0119 — Different events cost different amounts of the in-game day

> **Status:** Built (BDD/TDD-first). **Phase 3 (final) of the in-game-time pivot** (owner directive,
> 2026-07-11). Phase 1 made the house live *with* the clock; Phase 2 made ceremonies *timed, telegraphed*
> interrupts; Phase 3 makes each event cost its **own felt duration** — a quick nomination ceremony barely
> dents the day, a competition eats a real chunk, an eviction sits in between — instead of every beat
> advancing a flat +3h. So the day's shape is *lived*, not uniform.
> **In-game time ONLY** — no wall clock. Gated so the seeded calibration spine is
> byte-identical.
> **Executable spec:** [`0119-per-event-felt-durations.feature`](./0119-per-event-felt-durations.feature)
> **Multi-step events (owner ruling 2026-11-01, #1912):** eviction night and the finale cost about **two in-game hours in total**, not about 2h per step. `eventBeatHours` (`src/engine/liveSeason.ts`) charges the event's budget (`eventSpanHours("eviction")`) on its first presentation step (vote reveal batches, goodbye, the 0130 exit-interview stage, result) and 0 on every later step, tracked on `live.eventClock` (survives save and restart). The per-beat felt durations below apply to single-step beats (competition about 3h, ceremony about 1h).

## 1. Summary — the gap this closes

The per-beat clock advances a **flat `CLOCK.perBeatHours` (+3h) for every resolved beat**, regardless of
what happened — a 5-minute nomination ceremony costs the same slice of the day as an endurance
competition. The felt-duration data already exists (`EVENT_DURATION.hoursByBeat = { competition: 3,
ceremony: 1, eviction: 2 }`, read by `eventSpanHours` for narration *placement*), but it was never threaded
into the actual clock advance. Phase 3 threads it in: a resolved beat advances the clock by its **own**
felt duration, so ceremonies are quick and comps are long — the day fills up at a *lived* rate, leaving
more play around the cheap ceremonies and a real dent for the big competitions.

## 2. The mechanic — one call site, gated on the per-conversation clock

- `advanceClock(s, hours = CLOCK.perBeatHours)` gains an optional felt-duration (defaulting to the flat
  value — byte-identical when not passed).
- `beatFeltHours(beat)` maps a resolved beat to its felt hours via the shared `EVENT_DURATION` library
  (comps ~3h, ceremonies ~1h, evictions/finale ~2h); `null` for beats with no distinct duration (staged
  presentation drops, twists, the terminal) ⇒ the flat default.
- At the per-beat clock site in `advanceGame`, the felt duration is applied **only when
  `perConversationClockLive()`** (master + per-conversation clock on, day started); otherwise the flat
  default holds.

### Why byte-identical where it must be (the guardrail)

Unlike Phases 1–2, the per-beat clock is active whenever the master clock is on. So the gate
is deliberately the **per-conversation clock**:

- **Per-conversation clock off** ⇒ `perConversationClockLive()` false ⇒
  `feltHours` is never applied ⇒ every ordinary beat still advances the flat `perBeatHours` ⇒ the
  time-of-day/beat stream is **unchanged** for them (guarded by `perEventFeltDurations.test.ts`).
  **Exception — the multi-step event path:** eviction-night and finale beats go through
  `eventBeatHours` (the 2026-11-01 owner ruling, #1912), which is gated on the master time-of-day clock
  only, NOT on the per-conversation clock. With time-of-day on and the per-conversation clock off, an
  eviction/finale event therefore still charges its ~2h budget once on its first step and 0 on every later
  step, instead of the flat `perBeatHours` per step.
- **Seeded calibration spine:** time-of-day **off** ⇒ the whole per-beat clock block is skipped ⇒
  **byte-identical** (proven by `perConversationClockNeutral`).
- The felt duration is **pure presentation** (a deterministic constant, no rng) — it changes *when in the
  in-game day* a beat lands, never *who wins*: the seeded competition/vote stream is untouched.

## 3. Scope

**In:**
- `advanceClock(s, hours?)` — optional felt-duration parameter (flat default preserved).
- `beatFeltHours(beat)` in `src/engine/daySchedule.ts` — the beat→felt-hours read (via `eventSpanHours`).
- The `advanceGame` per-beat clock site applies it when `perConversationClockLive()`.

**Out (a clean hook, not built):** per-*competition* durations (an endurance comp vs. a quick quiz) — the
`eventSpanHours(beat, overrideHours)` override already accepts a per-comp value, but the 0042 competition
library does not yet assign one, so all comps share the category default for now. Wiring library durations
is a future 0042 extension. No change to the seeded spine, the Vault Wall, or NPC logic.

## 4. Contracts (stack-agnostic)

```
advanceClock(s, hours = CLOCK.perBeatHours): void   // per-beat clock advance; flat default = byte-identical
beatFeltHours(beat): number | null                  // a beat's felt in-game hours (comp ~3 / ceremony ~1 / eviction ~2), or null
// advanceGame applies beatFeltHours(ev.beat) ONLY when perConversationClockLive(); else the flat default.
```

## 5. Definition of Done

- [x] **Differentiated cost:** a resolved ceremony beat advances the clock **less** than a competition beat
      (quick vs. long); `beatFeltHours` returns the library values (comp 3 / ceremony 1 / eviction 2), null
      for inert/twist/terminal beats. *(`perEventFeltDurations.test.ts`; BDD 1.)*
- [x] **Clock-gated:** with the per-conversation clock off every beat advances the
      flat `perBeatHours` (the felt duration is never applied); with time-of-day off (the
      seeded spine) the block is skipped — **byte-identical** (`perConversationClockNeutral` green).
- [x] **Outcome-preserving:** the felt duration never perturbs the seeded stream — heavy calibration sims
      **byte-identical** (`juryReach` band unchanged); it is pure presentation.
- [x] Name-agnostic tests (roles only); BDD-gated in `cucumber.cjs`; `npm test` green.

## 6. Dependencies & traceability

Threads the existing `EVENT_DURATION` / `eventSpanHours` (0066/#1125) library into the per-beat clock,
builds on **0117** (the per-conversation clock it gates on) and **0118** (`daySchedule.ts`, where
`beatFeltHours` lives), and preserves the seeded calibration spine by gating on
the per-conversation clock. Final phase of the in-game-time pivot (owner directive 2026-07-11).
