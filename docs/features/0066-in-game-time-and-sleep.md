# 0066 — In-game time of day & the nightly sleep economy

> **Current default (AMEND 2026-11-04):** `ORWELL_TIME_OF_DAY` is now **default ON** in code
> (`src/featureFlags.ts`, `defaultOn`) as well as in the FE session default and the deploy profile
> (`deploy/orwell-env-defaults.sh`). The "code default off" wording below is the original rollout history, kept as written;
> off/0/false still gives the dormant, byte-identical clock-off spine (what the calibration harness pins).

**Status:** ✅ Built · **gate: BDD (`cucumber.cjs`) + unit** — the Phase-2 / 24-hour-model build (#1125,
2026-06-28) promoted 0066 into the Cucumber gate (`docs/features/0066-in-game-time-and-sleep.feature` +
`features/step_definitions/in_game_time_sleep.steps.ts`), alongside the Vitest suites named under
Definition of Done. Phase-1 (the original opt-in clock/sleep) shipped earlier.
**Executable spec:** [`0066-in-game-time-and-sleep.feature`](./0066-in-game-time-and-sleep.feature)
**Provenance:** ADR [`0006`](../decisions/0006-in-game-time-sleep-and-the-presence-economy.md) (in-game
time, sleep & the nightly presence economy); PO direction 2026-06-20; the **24-hour model amendment**
(owner, 2026-06-28 — recorded in ADR 0006 and §10 below) built as #1125.

## 1. Summary

Give the house a finite day. Time of day becomes first-class engine state (morning → afternoon →
evening → night → late-night), and with it the **nightly sleep economy**: managing sleep vs.
late-night conversation time is a trade-off **every** houseguest runs. Staying up late buys scarce
private scheming time at a hidden, bounded cost to the next competition; the comp-focused protect
their sleep and stay sharp. The bound on "functionally infinite" scheming is **diegetic** — the house
puts itself to sleep as houseguests reach their bedtimes — and the **player always chooses their own
bedtime** (never auto-slept). A simple time-of-day graphic surfaces in the HUD.

## 2. What exists today

- "Days" are ceremony beats only (`schedule.ts`); "morning/evening" is narration flavor, never state.
- Competition outcome already blends a hidden, bounded **soul emotional modifier** (0041) — the exact
  precedent a sleep term plugs into (`competitionOutcome.ts`).
- Presence/lingering (0049) seeds occupancy but is not time-aware.
- Pacing is engagement-driven (the FE lull-nudge) with no upper bound on a single beat.

## 3. Scope

**In:**
- The five-phase `TimeOfDay` model + character-driven bedtimes + the awake-set predicate (pure).
- **The awake set wired into the LIVING house** — the off-screen society pairs only houseguests still
  up (the night owls scheme on; an early-to-bed houseguest, or a turned-in player, misses it), and the
  player's `whereabouts` + approaches thin as the house empties. Calibration-safe by the flag gate (off
  ⇒ identity awake set ⇒ byte-identical), and no new shared-stream rng (bedtimes are deterministic off
  static stats), so the juryReach calibration spine is unmoved.
- A hidden, bounded sleep→competition penalty (symmetric; never protective).
- The player's bedtime lever (`turnIn`) and their own qualitative rest cue.
- Vault-free `timeOfDay` + player `restStatus` projections; the HUD clock + rest cue.
- **Flag-gated** via `ORWELL_TIME_OF_DAY`: the engine's code default is off, so the seeded calibration spine stays byte-identical, but the **deploy profile boots it ON** (`deploy/orwell-env-defaults.sh`) and the FE session default is ON, so real play runs with the clock on.

**Out (clean follow-ups):**
- NPC fatigue bleeding into **next-day social volatility**; a compounding fatigue meter (ADR 0006
  Phase-2 extensions).
- Per-social-turn clock advance (today the clock moves on each `advanceGame`).

## 4. Design

- **Time advances by play, never a wall-clock** (ADR Principle 1). The clock moves one phase per
  enabled `advanceGame`, cycling morning→late-night and wrapping to a new morning — banking that the
  player was up to the bitter end if they never turned in. Dormant (and byte-identical) when off.
- **Bedtimes are character-driven** (`bedtimeFor` = `social − physical`): the social game stays up
  (night owls), the comp-focused bed early. Derived from static stats ⇒ no randomness, byte-stable.
- **The bound is diegetic** (`awakeSet` shrinks toward the player + night owls) — no curfew; the
  player is never auto-slept (`turnIn` is the only thing that retires them — Principle 6).
- **Sleep is a hidden, bounded comp term** (`outcome.sleepPenalty = 0.20`, #1419) added beside the emotional
  modifier in `resolveCompetition`; 0 by default ⇒ byte-identical (Principle 4, never protective).
- **The Vault Wall holds** (Principle 5): NPC sleep is engine-only; the player's *own* tiredness is a
  qualitative `restStatus` cue (never a number, never any NPC's).

## 5. Contracts (stack-agnostic)

```
domain:  TimeOfDay = morning|afternoon|evening|night|late-night
state:   liveSeason.timeOfDay?, playerRetired?, lastSleepPhase?   (engine-only; optional ⇒ dormant)
pure:    nextPhase · bedtimeFor(stats) · isAwakeAt · awakeSet · restDeficitFor · restStatusFor
comp:    Competitor.restPenalty? (0..1) → score −= restPenalty·sleepPenalty   (0 ⇒ byte-identical)
ctx:     SeasonCtx.restOf?(id)   (player: last night; npc: bedtime habit; 0 unless clock running)
lever:   GameSession.turnIn()    (player-only; rolls to morning, banks the bedtime)
read:    GameStateView.timeOfDay, PublicGameStatus.timeOfDay, PlayerCard.restStatus  (Vault-free)
flag:    ORWELL_TIME_OF_DAY (code default ON; `=0` opts out) gates every clock mutation + restOf
```

## 6. Definition of Done

- `tests/unit/timeOfDay.test.ts` — the pure model: phases advance/clamp; bedtimes are deterministic;
  the awake set shrinks monotonically to the player + night owls; the player is never auto-slept; the
  rest deficit/cue are monotonic in lateness.
- `tests/unit/sleepCompetition.test.ts` — the comp term is real, symmetric, never protective, refuses
  non-finite input, and is **byte-identical when absent**.
- `tests/unit/timeOfDaySession.test.ts` — end-to-end through the adapter (flag on): the clock surfaces
  and advances; `restStatus` appears; the bedtime lever rolls to morning; **NPC sleep never leaks**;
  and the whole feature is **dormant when off**.
- `tests/unit/timeOfDaySociety.test.ts` — the awake set wired into the living house: the house thins
  monotonically at night (whereabouts + approaches + the society occupancy show only the awake), the
  off-screen society pairs only houseguests still up, and it is **byte-identical when off** (the identity
  awake set). The juryReach calibration gate + `movementStreamIsolation` stay green.
- The full fast suite stays green (the dependency-cruiser Vault-Wall + vault-sentinel + replayability
  + persistence all unchanged): the opt-in guarantees the juryReach/UAT calibration spine is unmoved.

## 7. Dependencies & traceability

- Builds on: 0049 (presence), 0041 (the hidden emotional modifier), 0028/0006 (outcome resolution).
- Governed by: ADR 0006; the Vault Wall (0001) and anti-sycophancy mandates.
- Followed by: the Out items in §3 (off-screen awake-set pairing; NPC social fatigue; the calibration
  pass once enabled).

## 8. Implementer-ready (built)

- Pure: `src/engine/timeOfDay.ts` (the 24-hour clock, bedtimes-in-hours, the bidirectional awake set, graded
  debt, the event/conversation duration helpers) + **`src/engine/sleepConstants.ts`** (the single tunable
  home — `CLOCK`/`SLEEP`/`SOCIAL_FATIGUE`/`FATIGUE`/`CONVERSATION_DURATION`/`EVENT_DURATION`/`WEEKLY_CADENCE`).
- Engine: `src/engine/liveSeason.ts` (state + `advanceClock`/`advanceClockPerConversation`/`playerTurnIn`/
  `playerRestDeficit`/`npcRestDeficit` — all hour-based),
  `src/domain/competitionOutcome.ts` + `src/domain/temperatureConstants.ts` (the sleep term).
- The three Phase-2 flags (`ORWELL_TIME_PER_CONVERSATION` / `ORWELL_SOCIAL_FATIGUE` /
  `ORWELL_MULTI_NIGHT_FATIGUE`) + per-instance `set*Enabled` setters live on `GameSessionAdapter`
  (siblings of the `ORWELL_CAMPAIGNS`/`ORWELL_TRAJECTORIES` pattern); the per-conversation advance rides the
  orchestrator's once-per-turn debounced tick (`maybeTurnDrivenTick`).
- Gates: BDD (`docs/features/0066-in-game-time-and-sleep.feature` + `features/step_definitions/
  in_game_time_sleep.steps.ts`, in `cucumber.cjs`) + the Vitest suites: `tests/unit/{timeOfDay,nightDepth,
  sleepEconomyFairness,sleepCompetition,timeOfDay{Session,Society,Toggle},conversationDurationLoose,
  eventDuration,weeklyCadence}.test.ts` and the per-extension neutrality proofs `tests/unit/
  {perConversationClock,socialFatigue,multiNightFatigue}Neutral.test.ts`.
- Adapter: `src/adapters/engine/GameSessionAdapter.ts` (the opt-in clock advance, `restOf`, `turnIn`,
  the `timeOfDay`/`restStatus` projections, and the social economy — `awakeNow`/`awakeAmong` filtering
  `societyOccupancy`/`whereabouts`/`socialInitiatives`).
- Engine: `src/composition/orchestrator.ts` — the off-screen tick routes the living NPCs through
  `awakeAmong`, so the night's society pairs only houseguests still up.
- Port + seam: `src/ports/GameSession.ts`, `src/surfaces/tools/registry.ts`, `src/adapters/mcp/McpServer.ts`.
- FE: `frontend/static/js/orwellStatusPanel.js` (the clock chip + the player's rest cue);
  `frontend/static/js/orwellNightStatus.js` (the "Nightfall" gadget — phase indicator + who's turned in).
- **Toggle (PR #460):** an "In-Game Time & Sleep" settings switch (default ON) flips it on the live
  engine at runtime via the admin `setTimeOfDay` tool (no restart) — re-applied on FE boot. The
  `ORWELL_TIME_OF_DAY` env var is the boot default the switch overrides.

## 9. Phase-2 extensions — BUILT (#1125, 2026-06-28)

> **RESOLVED + BUILT (owner, 2026-06-28): the three flagged Phase-2 extensions, on the 24-hour model below;
> plus Extension 4 (emergent NPC bedtimes, owner 2026-07-12).** Each of 1–3 rides its OWN opt-in flag,
> byte-identical to the seeded calibration spine when off (a dedicated per-extension neutrality proof each),
> priority-ordered per the owner: per-conversation clock advance first (pacing-only), then NPC next-day
> social fatigue, then the compounding multi-night meter. **Extension 4** has no separate flag — it is the
> *definition* of the NPC sleep deficit and rides the master clock, byte-identical when the clock is off (or
> when the co-owl company count is 0). The env-default split stays for the code (engine `ORWELL_TIME_OF_DAY` OFF for
> calibration; the FE session default ON for real play, ruling #583), but the **deploy profile boots the engine ON too** (#1912) so an engine-only restart never leaves the clock dark. See `docs/decisions/PO-DECISIONS-LOG.md`
> (2026-06-27/28).

1. **Per-conversation clock advance** — `ORWELL_TIME_PER_CONVERSATION`. The clock advances as the player
   *lingers/plays* within a beat (the orchestrator's once-per-turn, debounced off-screen tick), so the
   day's finite scheming time is felt turn-by-turn. Pacing-only; it clamps at the bitter pre-dawn edge and
   never wraps the night without the player's own `turnIn` (ADR 0003 / the lull rule) — an engaged scene is
   never cut. The felt per-turn duration is the LOOSE, type-bounded conversation duration (§10, Extension 5).
2. **NPC next-day social fatigue** — `ORWELL_SOCIAL_FATIGUE`. A tired houseguest moves the needle LESS in
   the next day's social scenes (`socialSwayScale` dampens the off-screen fold magnitude — effectiveness,
   never a personality change), and a character conflict drains the houseguest in it to an earlier bedtime.
3. **A compounding multi-night fatigue meter** — `ORWELL_MULTI_NIGHT_FATIGUE`. An EMA of nightly deficits
   (`accrueFatigue`/`combinedRestDeficit`): consecutive late nights stack a deeper deficit; a rested night
   recovers. It adds (bounded) to both the comp fold and the social sway.
4. **EMERGENT, INDEPENDENT NPC bedtimes — the sleep-debt fairness fix** (owner ruling 2026-07-12; #TBD).
   The original ENG-NEW-1 model capped an NPC's sleep debt at *the player's* bedtime (`min(chronotype,
   nightRanTo)` where `nightRanTo` is when the player turned in) — so an NPC never accrued more debt than the
   *player* chose to, and a player who bedded early left even natural night-owls fresh. That is a player-only
   freedom: sleep debt did NOT apply on equal footing. **Fix:** an NPC's night is now EMERGENT
   (`emergentBedtimeHour` in `timeOfDay.ts`) and INDEPENDENT of the player — a night-owl lingers to their own
   chronotype bedtime ONLY with late-night **company** (`AFTER_HOURS.companyFull` = other natural owls still
   up), or when the player kept the house up (the social floor rises past midnight); **alone on a dead night
   they wind down to the social floor and pay nothing.** So an owl who genuinely stayed up (with company)
   pays their OWN debt whether or not the player did — but a lone owl is NOT taxed for a trait (the debt is
   **earned**, never structural). The adapter counts the live co-owl **company** (`lateCompanyFor`) and feeds
   it to `npcRestDeficit`; **company omitted (0) collapses to the social floor, whose DEFICIT is byte-identical
   to the old player-capped value** — so the seeded calibration spine and the `sleepEconomyFairness` gate are
   unmoved. Rides the master clock (`timeOfDayEnabled`) like the rest of 0066; no separate flag (it is the
   *definition* of the NPC deficit, not an add-on effect). *(This intentionally REVERSES the ENG-NEW-1 "no
   owl tax on a normal night" stance where it conflicted with player↔NPC parity: an owl who stays up with
   company is now legitimately a touch tired next comp, exactly as a player who stays up every night would be.)*

All four are PURE (no rng — bedtimes are derived, the meter is a running average, company is a deterministic
count), so they add ZERO draws to the seeded competition/vote/jury stream; the proofs are `tests/unit/
{perConversationClock,socialFatigue,multiNightFatigue}Neutral.test.ts` and `tests/unit/
npcBedtimeIndependence.test.ts`. Tunables live in the single `src/engine/sleepConstants.ts`.

### Extension 6 — the SCENE-based clock: scenes, not turns (owner ruling 2026-07-12)

**The problem Extension 1 left.** Extension 1 advances the clock once per player **turn** (the orchestrator's
per-turn tick), and Extension 5 sizes each *scene's* felt duration — but the two units are **mismatched**: a
single conversation that runs six turns of back-and-forth gets billed **six times** (the small per-turn floor
each turn), not once. Turns are too quick and too plentiful to be the unit of in-game time. The felt-duration
system was *designed* per scene (`SCENE_FELT_MINUTES`, "the narrator sizes each **scene**") but the clock
never had a notion of a scene, so in practice the per-turn floor dominates and "the narrator determines the
length" rarely gets to matter.

**The fix — the SCENE is the unit of time; turns are texture inside it.**

- **A scene = (room + the co-present participant set).** It stays OPEN across many turns and **closes** on: a
  room change (`moveTo`), a **participant-set change** (someone walks in or leaves; the player pulls a
  different person aside), a **beat** (comp/ceremony — its own scene, already duration-priced by Extension 5),
  an explicit **lull** ("let's move on"), or the scene's **max-duration cap**.
- **Model B — capped accumulation (not a single jump).** Each turn inside a scene adds a SMALL increment, but
  the scene is **capped** at its felt duration (`SCENE_FELT_MINUTES.max`, 240 min): a 3-turn chat ≈ 20 min, a
  12-turn marathon caps at ~60–90 min instead of running to 6 h. A longer conversation *is* a touch longer
  in-fiction, but turn count can never run the clock away. Degrades gracefully if boundary detection misfires
  (a scene that never "closes" still can't exceed its cap).
- **The scene's duration is sourced** (best-available, all bounded to `SCENE_FELT_MINUTES`): the narrator's
  `feltMinutes` when proposed (Extension 5; shipped as the **preferred** source: the moment prompt asks the
  narrator to always include it on `recordInteraction`, and `EngineCommandsAdapter` feeds it to the clock;
  see also 0119 for per-event felt durations) → else a **deterministic** richness/turn estimate (turns-in-scene ×
  a small per-exchange rate, capped), which is now the **fallback** → the floor only as the last resort.
- **Solo time is NOT free.** The player alone in a room is a real scene that accrues time (capped, same
  machinery). It is **theirs to end** — they leave or turn in, nothing force-marches them (ADR 0003) — **or an
  NPC walks in**, which is a participant-set change that closes the solo scene and opens a social one (ties
  straight into presence 0049 — NPCs already wander in on their own motivation).
- **Scene-time participants ≠ consequence targets.** Scene-*time* is anchored on who is **co-present** (the
  room's set — "who's in the scene"); the **consequence fold** still targets whoever the player actually
  addressed (`withIds` — "who they worked"). Two different jobs; kept separate.

Rides the SAME `ORWELL_TIME_PER_CONVERSATION` flag (it *is* the per-conversation clock, done per scene), so
it is byte-identical to the seeded calibration spine when the clock is off and **prompt-neutral** (the since-decommissioned
(2026-07-21) golden replay ran the per-conversation clock off; the current guard is `perConversationClockNeutral`). PURE (the scene tracker is deterministic state + a bounded
estimate — no rng), so it adds ZERO draws to the seeded stream. Proof: `tests/unit/sceneClockNeutral.test.ts`
(off ⇒ byte-identical) + scene-boundary/cap unit tests. Tunables (`SCENE_*`) live in `src/engine/sleepConstants.ts`.

## 10. The 24-hour model (accepted amendment — owner, 2026-06-28; #1125)

The five phases are now real HOUR BANDS on a 24-hour day measured from the **8am forced wake**:

| phase | hours | span |
|---|---|---|
| morning | 8–12 | 4h |
| afternoon | 12–16 | 4h |
| evening | 16–20 | 4h |
| night | 20–24 | 4h |
| late-night | 24–32 | **8h** (midnight → the next 8am) |

- **Clock.** The live field `nightDepth` carries the clock-HOUR (8..32; the field name is legacy). A new
  day begins ONLY at the 8am wake (everyone up); the clock CLAMPS at the bitter end and never silently
  wraps. Advances by play: `CLOCK.perBeatHours` (~3h) per substantive ceremony beat; `CLOCK.perConversationHours`
  (the type-bounded felt duration) per lingering turn.
- **Sleep / wake (symmetric, player + NPC).** An 8-hour need against the fixed 8am wake. Bed at midnight →
  8h → 0 debt. Bed AFTER midnight → debt = hours past midnight (`sleepDebtHours`), graded into 0..1
  (`sleepDeficitForBedHour`). Bed BEFORE midnight → the 8h sleep lands before 8am → wake in the **pre-dawn
  window** (0 debt + bonus awake time). So the awake set SHRINKS evening→midnight (owls retiring) then GROWS
  midnight→8am (larks rising) — the **bidirectional ramp** (`isAwakeAtHour`), two distinct late-night
  windows: post-midnight owls (costly) vs pre-dawn larks (free). Bedtimes are character-driven HOURS
  (`bedtimeHourFor` = `social − physical` + deterministic per-NPC jitter, ∈ [21, 26]). The graded debt is a
  hidden comp penalty + (ext2) social fatigue + (ext3) the multi-night meter; the player sees only their own
  qualitative cue (rested / tired / running on empty), never a number, never an NPC's.
- **Weekly 5-cycle + period placement** (`WEEKLY_CADENCE`). One HOH reign, STRICT order, no default rest
  days, the daily-event invariant: Day 1 HOH (morning) · Day 2 nominations (morning) · Day 3 veto player
  draw (morning) + veto competition (afternoon) · Day 4 veto ceremony (morning) · Day 5 eviction (evening) ·
  next HOH = Day 6 morning (the morning AFTER eviction, not eviction night — the eviction→HOH gap is the one
  light "process the eviction" beat). HOH-in-the-morning maximizes the post-HOH playable window.
- **Event durations + seeded start-within-period** (`EVENT_DURATION`, `eventSpanHours`/`eventStartHour`/
  `eventSpillsPeriod`). A comp ~3h, ceremony ~1h, eviction ~2h; each starts at a DETERMINISTIC offset WITHIN
  its 4-hour period (a hash of seed + beat-key — NOT pinned to the edge, NO shared-stream rng, so the seeded
  spine is untouched), may SPILL into the next period, and comps vary BY TYPE (the 0042 library overrides the
  default).
- **Conversation durations (LOOSE — ADR 0005 for time)** (`CONVERSATION_DURATION`, `conversationHours`). A
  scene's felt duration is open-set: the LLM proposes how long it took; the engine COMMITS it BOUNDED to the
  type range (passing ~0.5h, casual ~1h, game ~1.5h, summit ~2h) — never 0, never a day-skip. Absent a
  proposal ⇒ the type baseline, byte-identical (the `expressiveNonCollapse`-for-time floor:
  `tests/unit/conversationDurationLoose.test.ts`).

**Magnitudes — ✅ BLESSED FINAL (owner ruling 2026-07-12, #1419).** The sleep-economy magnitudes are set;
the §10 DoD "final magnitudes set" is **done**. The settled values:

| magnitude | value | home |
|---|---|---|
| comp `sleepPenalty` | **0.20** (#1419 — staying up costs MORE at comps: a full rest deficit shaves ~0.20 off the outcome score vs. the 1.0 stat weight; still hidden/bounded, a tired favorite can still lose) | `temperatureConstants.outcome` |
| social fatigue `swayDamp` / `swayFloor` | 0.6 / 0.4 (tired ⇒ worse at charm) | `sleepConstants.SOCIAL_FATIGUE` |
| social fatigue `soreGain` / `soreCap` | 0.35 / 1.4 (asymmetric — tired barbs cut deeper; default-on #1474) | `sleepConstants.SOCIAL_FATIGUE` |
| multi-night meter `recovery` / `weight` | 0.5 / 0.5 | `sleepConstants.FATIGUE` |
| character bedtimes | `[21, 26]` (`earliestBedHour` / `latestBedHour`) | `sleepConstants.SLEEP` |
| `maxDebtHours` | 8 | `sleepConstants.SLEEP` |
| after-hours `companyFull` | 3 | `sleepConstants.AFTER_HOURS` |

Only fine adjustment remains open (not new scope): the per-beat / per-conversation hour steps and the
conversation/event duration tables — all in `src/engine/sleepConstants.ts`.
