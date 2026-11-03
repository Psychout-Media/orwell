# 0117 — The house lives in in-game time (society ticks track the clock, not the beat)

> **Status:** Built (BDD/TDD-first; BDD-gated in `cucumber.cjs`). **Phase 1 of the in-game-time
> pivot** (owner directive, 2026-07-11): make **in-game time the single spine** so all off-screen NPC
> scheming, movement, and gossip happen *as the in-game clock passes during the player's social play* —
> not only in a burst when a ceremony beat resolves. Competitions/ceremonies stay the milestones that
> push circumstances forward; the *gameplay* is the scheming that fills the time between them, on both
> sides of the glass.
> **In-game time only — never real-world time.** This feature does **not** reintroduce the wall-clock
> watcher (deleted, real-time purge 2026-07-10). In-game time still advances *only* from the player's own
> committed turns and the ceremony beats; the house still does **not** live while the player is away.
> **Executable spec:** [`0117-house-lives-in-in-game-time.feature`](./0117-house-lives-in-in-game-time.feature)
> **Also proven by:** `tests/unit/houseLivesInInGameTime.test.ts`

## 1. Summary — the gap this closes

The off-screen society (0038), gossip diffusion (0038), motivated movement (0078), campaigns/drives
(0085/0086), trajectories (0087), and reactive confessionals (0089) are the game's living hidden layer —
NPCs scheming behind the player's back. **Today every one of them fires on the *off-screen tick*, and in
the production runtime that tick fires only on a *progressed (ceremony) beat*.** The load-bearing line is
`orchestrator.ts` `maybeTurnDrivenTick`: `if (!progressed && this.auxTicksNever) return;` — a pure social
turn (a `recordInteraction`, a Diary-Room entry) does **not** progress the live loop, so under the
production `auxTicksNever` flag it returns early and the house does **nothing**. It also never reaches the
per-conversation clock advance below it, so **in-game time itself does not move during social play** in
production.

The result is the rhythm the owner flagged: *ceremony fires → house schemes once → dead air while the
player socialises → next ceremony → house schemes once.* The house lives in **bursts tied to ceremonies**
and goes quiet in exactly the between-ceremony window where the scheming should be richest.

This feature makes the house live **with the in-game clock**: as in-game time passes during the player's
social play, the off-screen society keeps scheming, paced to the player's own play — so NPCs "move with
time, not beats."

## 2. The mechanic — one seam, gated so nothing seeded moves

Change is confined to `maybeTurnDrivenTick`. When **in-game time is genuinely flowing this turn**
(`perConversationClockLive()` — master clock on **and** the per-conversation clock on **and** the day has
started), a social (aux) turn is **no longer silenced**:

1. **Time flows during social play.** The per-conversation clock advances a small step on the aux turn
   (it previously only advanced on beat turns), so the in-game clock moves as the player lingers.
2. **The house lives with the clock, not per tool call.** A social-play off-screen tick fires only once
   **`SOCIETY_TICK_HOURS` of in-game time** have elapsed since the house last lived — an **in-game-time
   debounce** (replacing the play-clock-ms debounce, which the logical clock defeats). So the society
   schemes roughly every couple of social turns, "with the clock," never once per tool call. A ceremony
   beat (a +3h jump) always clears the threshold, so beat-driven ticks are unchanged.
3. **Who schemes is already motivated + varied** (0038/0078/0085): participants are drawn by tie strength
   and the initiator's directed read, so the *cadence* is time-paced while the *content* keeps the
   personality/strategic variance the owner asked for (0038 review) — no new randomness needed.

### Why this is byte-identical where it must be (the two hard guardrails)

- **Seeded calibration spine (UAT / juryReach / gradient):** these run with **time-of-day OFF**, so
  `perConversationClockLive()` is `false`, the new branch is never taken, aux turns still return early, and
  every seeded competition/jury roll is **byte-identical**. The off-screen society already uses side-rng
  (never the seeded spine), so even the extra live-game ticks can't perturb a seeded outcome.
- **Golden record/replay (0108, historical — decommissioned 2026-07-21):** the golden driver pinned
  `ORWELL_TIME_PER_CONVERSATION=0`. The same property is now guarded in two parts:
  `perConversationClockNeutral` proves the seeded competition/vote/jury **outcome** stream is byte-identical,
  and `tests/unit/houseLivesInInGameTime.test.ts` proves that with the **master in-game clock off**
  `perConversationClockLive()` is `false` and no extra off-screen society tick fires on social turns. The
  master-on / per-conversation-off combination is not separately asserted as a no-tick case.
- **No token cost:** the off-screen society is **pure engine simulation** (templates + seeded rng), not an
  LLM call, so a livelier cadence costs no tokens — only richer hidden state.

## 3. Scope

**In:**
- `GameSessionAdapter.perConversationClockLive(): boolean` — master clock ∧ per-conversation clock ∧ day
  started. Vault-free; reads only clock flags + `live.timeOfDay`.
- `GameSessionAdapter.inGameHour(): number | undefined` — the current in-game clock-hour (`nightDepth`,
  8..32), or `undefined` when the clock isn't running. Vault-free.
- `maybeTurnDrivenTick` rewrite: un-silence social turns when the clock is live; advance the
  per-conversation clock on the aux turn; fire the society tick on an **in-game-time debounce**
  (`SOCIETY_TICK_HOURS`); track `lastSocietyTickHour` per user (reset on a beat's jump too).
- `SOCIETY_TICK_HOURS` in `src/engine/sleepConstants.ts` — the tunable in-game-hours cadence.

**Out (later phases):**
- Ceremonies as time-triggered interrupts + a real daily time budget that caps lingering (**0118, Phase 2**).
- Per-event felt durations (a quiz costs less of the day than an endurance comp) (**0119, Phase 3**).
- Any change to the seeded spine, the Vault Wall, or NPC decision logic (untouched).

## 4. Contracts (stack-agnostic)

```
GameSessionAdapter.perConversationClockLive(): boolean     // in-game time is flowing this turn (all flags on, day started)
GameSessionAdapter.inGameHour(): number | undefined        // current in-game clock-hour 8..32, or undefined if the clock is off
SOCIETY_TICK_HOURS: number                                 // in-game hours of elapsed time between social-play house-ticks
// maybeTurnDrivenTick: a social (aux) turn now advances the per-conversation clock and, once
// SOCIETY_TICK_HOURS have elapsed since the house last lived, fires one off-screen society tick.
```

## 5. Definition of Done

- [x] **Un-silencing:** with the clock live, a run of social (aux) turns advances the in-game clock **and**
      fires at least one off-screen society tick between ceremonies (the house schemes during social play).
      *(`tests/unit/houseLivesInInGameTime.test.ts`; BDD scenario 1.)*
- [x] **In-game-time pacing:** the society ticks track elapsed in-game hours (~every `SOCIETY_TICK_HOURS`),
      not once per tool call — some social turns scheme, others stay quiet. *(BDD scenario 2; the pacing test.)*
- [x] **Byte-identical guardrails:** with time-of-day OFF (the seeded spine) social turns still return
      early — no clock advance, no extra tick; the heavy calibration sims stay **byte-identical**
      (`juryReach` band unchanged; `perConversationClockNeutral` / `nightGateNeutral` green); with the per-conversation clock off no new tick can fire (guarded by `perConversationClockNeutral`). *(BDD scenario 3; the clock-off test.)*
- [x] **Vault-free:** the two new getters read no Vault state; `npm run test:arch` green. *(BDD scenario 4.)*
- [x] Name-agnostic tests (roles only); BDD-gated in `cucumber.cjs`; `npm test` green.

## 6. Dependencies & traceability

Extends **0066 / ADR 0006** (in-game time & the per-conversation clock — the clock this rides), un-silences
**0038** (off-screen society + gossip), **0078** (motivated movement), **0085/0086** (campaigns/drives),
**0087** (trajectories), **0089** (reactive confessionals) into the between-ceremony window, and preserves
the seeded calibration spine (and, historically, **0108** golden replay, decommissioned 2026-07-21) by gating strictly on the live clock. Governed by
**ADR 0005** (open-set texture is never normalized into the closed set — the livelier society is open-set
richness only) and the **real-time purge** ruling (2026-07-10 — in-game time only, never the wall clock).
First phase of the in-game-time pivot (owner directive, 2026-07-11).
