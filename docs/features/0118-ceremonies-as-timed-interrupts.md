# 0118 — Ceremonies as timed, telegraphed interrupts (the day has a shape)

> **Status:** Built (BDD/TDD-first; engine + FE). **Phase 2 of the in-game-time pivot** (owner directive,
> 2026-07-11; design confirmed 2026-07-12). Phase 1 (0117) made the house live *between* ceremonies;
> Phase 2 makes the ceremonies themselves **milestones on the in-game clock**: the day has a known
> schedule, the player is **told when the next one lands** ("the HOH competition is this afternoon"),
> every run-up conversation is **primed** for it, and when the clock reaches that time the ceremony
> **fires and gathers the whole house** — a fair, telegraphed hard interrupt. Your **bedtime stays
> yours** (soft, player-owned); only the ceremonies are hard.
> **In-game time ONLY** — no wall clock; gated on the per-conversation clock exactly like 0117, so the
> seeded calibration spine and golden replay are untouched.
> **Executable spec:** [`0118-ceremonies-as-timed-interrupts.feature`](./0118-ceremonies-as-timed-interrupts.feature)
> **Also proven by:** `tests/unit/dayScheduleTimedInterrupts.test.ts`

## 1. Summary — the two caps, one soft one hard

The owner's model (confirmed): what bounds the player's day is **(a) their own bedtime** *or* **(b) a
competition/ceremony interrupting** — never a forced curfew. So:

- **Soft cap — bedtime (unchanged, already built):** the player owns `turnIn`; nothing auto-sleeps them
  (ADR 0006 Principle 6). Phase 2 does **not** touch this. The emptying night house (0117/0066) is the
  soft, diegetic bound on late lingering.
- **Hard cap — the timed ceremony (new):** each week's ceremonies sit at scheduled in-game times. The
  player **knows the schedule ahead of time** ("the comp is this afternoon"), so any conversation in the
  run-up phase is **primed for the interruption**; when the clock reaches the scheduled time, the
  ceremony fires and the **whole house gathers** — an exclusive set-piece with no side rooms (the 0106
  gather, reused unchanged). Because it is telegraphed, the interrupt is fair, not a yank.

## 2. What already exists vs. what 0118 adds

- **Already built (0106):** while a comp/ceremony is the live pending beat, `whereabouts()` gathers the
  whole house into one room (competitors vs. spectators), and the player cannot wander off. The *gather*
  is done. **What's missing is its trigger:** today a ceremony fires when the front-end hits a
  conversation *lull* and nudges the game forward — lull-driven, not time-driven.
- **0118 adds:**
  1. **A known day schedule.** Each upcoming structural milestone maps to a scheduled in-game phase
     (`DAY_SCHEDULE`, tunable). A Vault-free `daySchedule` projection — *next milestone + its scheduled
     phase + whether it is now due* — rides the game view (HUD) and the narrator's game context (priming).
  2. **Telegraphing + priming.** The narrator's context names the upcoming milestone and its phase, so
     run-up scenes carry the awareness ("everyone knows the veto comp is this afternoon"). The player
     surface shows the same cue.
  3. **Time-triggered firing (the FE companion).** When the schedule is **due** (the clock reached the
     milestone's phase), the front-end's existing forced-advance nudge fires the ceremony **regardless of
     lull** — the time-aware evolution of the L39b stall-nudge. It reuses `advanceGame`; the engine's
     `milestoneDue()` read is the signal.

## 3. The mechanic — deterministic, Vault-free, clock-gated

- `DAY_SCHEDULE: Record<StructuralMilestone, TimeOfDay>` — the scheduled phase per ceremony (comps in the
  afternoon, ceremonies/evictions in the evening; tunable in one place).
- `nextMilestone(live)` — the next structural milestone (`live.beat`), its scheduled phase, and its target
  clock-hour, derived purely from the live loop state. `null` when the game is between/pre live.
- `milestoneDue(live)` — the clock-hour has reached the scheduled target hour (⇒ the ceremony should fire
  now). Pure read; no rng.
- The `daySchedule` view field + the narrator priming are populated **only when `perConversationClockLive()`**
  (master + per-conversation clock on, day started). Off ⇒ the field is absent, the prompt is unchanged.

### Why byte-identical / golden-safe (the guardrails, same as 0117)

- **Seeded calibration spine** runs time-of-day **off** ⇒ `perConversationClockLive()` false ⇒ no
  `daySchedule`, no priming, no due-signal, no firing change ⇒ **byte-identical** (the schedule is a pure
  read; it never touches the seeded stream).
- **Golden replay (0108)** pins the **per-conversation clock off** ⇒ `perConversationClockLive()` false ⇒
  the projection and the priming text never render ⇒ the recorded prompt/beat stream is **unchanged, no
  re-record needed**. (A future clock-on re-cut captures the timed pacing.)
- The ceremony *arrival* still happens on the player's own turn (pure turn-driven — no background driver,
  no wall clock); the schedule only decides **when in the in-game day** the forced-advance is allowed to
  fire, and telegraphs it first.

## 4. Contracts (stack-agnostic)

```
DAY_SCHEDULE: Record<StructuralMilestone, TimeOfDay>        // scheduled phase per ceremony (tunable)
nextMilestone(live): { beat, phase, targetHour } | null    // next milestone + its scheduled in-game time
milestoneDue(live): boolean                                // the clock has reached the scheduled time
GameStateView.daySchedule?: { next, phase, due }           // Vault-free HUD/priming cue; absent unless the clock is live
GameSessionAdapter.milestoneDue(): boolean                 // the FE forced-advance nudge's time signal
renderGameContext(view): string                            // primes the narrator with the upcoming, telegraphed milestone
```

## 5. Definition of Done

- [x] **Schedule + telegraphing:** with the clock live, the game view exposes the next milestone and its
      scheduled phase; the narrator context names it ("the veto competition is set for this afternoon —
      the house knows it's coming"), so run-up scenes are primed. *(`dayScheduleTimedInterrupts.test.ts`; BDD 1.)*
- [x] **Due signal:** `milestoneDue()` is false before the scheduled phase and true once the clock reaches
      it; it drives the FE forced-advance nudge (time-aware), which fires the ceremony + the 0106 gather.
      *(engine: BDD 2 + unit due-flip; FE: `chat_helpers._LAST_MILESTONE_DUE` → `agent_loop._want_advance`
      bypass, `test_0118_timed_ceremony_nudge.py`.)*
- [x] **Soft bedtime preserved:** `turnIn` stays the only player-sleep path; no forced curfew is added
      (untouched).
- [x] **Byte-identical / golden-safe:** with time-of-day off (the seeded spine) and with the
      per-conversation clock off (golden replay), the `daySchedule` field and the priming text are absent
      and the beat stream is unchanged; the FE `due` cache is False; heavy calibration sims
      **byte-identical**; **no golden re-record**. *(BDD 3; clock-off unit test; the FE bypass reads False.)*
- [x] **Vault-free:** the schedule reads only the live loop state + clock; `npm run test:arch` green. *(BDD 4.)*
- [x] Name-agnostic tests (roles only); BDD-gated in `cucumber.cjs`; `npm test` green; FE nudge covered by
      a pytest gate keyed the single-tenant-safe way (`test_0118_timed_ceremony_nudge.py`).

## 6. Dependencies & traceability

Builds on **0117** (the per-conversation clock that carries time through social play — its `SOCIETY_TICK_HOURS`
sibling), **0106** (the whole-house gather set-piece, reused unchanged), **0066 / ADR 0006** (in-game time +
the night-gate day structure), and the FE **L39b** forced-advance nudge (made time-aware). Preserves **0108**
(golden replay) and the seeded spine by gating strictly on the per-conversation clock. Phase 2 of the
in-game-time pivot (owner directive 2026-07-11; interrupt-must-be-telegraphed confirmed 2026-07-12).
