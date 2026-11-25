# 0006 — In-game time, sleep, and the nightly presence economy

> **Status:** **Accepted & built** — Phase-1 (the opt-in clock/sleep/presence economy) shipped as feature
> 0066; the **24-hour model + Phase-2 extensions** were accepted by the owner (2026-06-28) and built as
> #1125 (see the **Amendment** section at the end of this record). Originally *Proposed* on PO direction
> 2026-06-20; mechanism built BDD/TDD-first.
> **Source:** Product-owner direction, 2026-06-20 (the "in-game clock / sleep" thread): *"there
> should be an element of in-game time… a cap on how much time exists between events… this should
> not be functionally infinite… maybe a simple graphic for Morning, afternoon, evening, night, late
> night… sleep may be an interesting metric… if I go to bed really late the night before a HUGELY
> IMPORTANT HOH comp, it may affect my performance."* Refined in-thread: *"managing sleep versus
> private times for conversation is a major element each houseguest manages,"* and *"there should be
> the freedom for a few night owls to stay up so late it impacts gameplay… the player decision to
> head to bed in these edge cases. The house putting itself to sleep should be enough most nights."*
> **Refines:** the 2026-06-10 pacing ruling ("the game clock is the player's play-clock; seize the
> lull; nothing force-marches the week," `docs/audits/2026-06-10-full-product-audit.md`).
> **Builds on:** 0049 (house presence & lingering), 0041 (character evolution / the hidden emotional
> modifier), 0028 + 0006 (outcome resolution + temperature constants).
> **Inherits / bounded by:** the Vault Wall (mandate #2) and anti-sycophancy (mandate #3); ADRs 0003
> (the conversation is the game) and 0005 (split authority by openness).

## Context

Today the live game has **no modeled time**. "Days" exist only as ceremony beats
(`src/engine/schedule.ts`: HOH comp → noms → veto → ceremony → eviction); "morning/evening" appear
only as narration flavor in the moment prompts, never as state. Progression is purely
engagement-driven: the front-end nudges `advanceGame` only when the player's turn reads as a *lull*,
with a force-advance backstop (`frontend/src/agent_loop.py`). That was deliberate, and it solved a
real failure mode — don't rush good play, and don't let the house run while the player is away (the
player can leave the house; NPCs cannot, so a background advance during an absence is a structural
disadvantage).

But it leaves the **opposite** failure mode open: within a single beat, scheming is *functionally
infinite*. Nothing in the fiction pushes back. Real Big Brother is the opposite — a day is finite,
privacy is scarce and contested, and **managing sleep vs. private conversation time is itself a core
part of the game every houseguest plays.** The houseguest who goes to bed early every night cedes
the late-night alliance-building; the last ones awake get the house to themselves — and pay for it
the next day. The night before a big HOH, that trade-off is at its sharpest. None of that texture
exists yet, and it is squarely a behavioral-fidelity gap (priority #1).

This record settles *how* to introduce finite in-game time **without** reintroducing the failure
mode the 2026-06-10 ruling closed.

## Decision

Introduce **time of day** as first-class engine state and model the **nightly presence economy** it
drives. Time is not a wall-clock and not a turn counter — it is an **in-fiction budget the house
spends by playing**. The bound on "functionally infinite" is **diegetic**: as the night gets late,
houseguests go to sleep (per their own character/soul), the *awake set* shrinks, and play runs out
of *people*, not out of a timer. Sleep is the currency — staying up buys scarce private access at a
hidden cost to the next competition. **Every houseguest runs this trade-off**, player and NPC
alike — and the player always chooses their own bedtime (the game never sends them to bed).

This rides on systems that already exist (occupancy/adjacency 0049, the hidden bounded-modifier
pattern 0041, the Vault-free projection 0001) and adds **no new authority over outcomes** — the
engine still decides, the model still only narrates.

### Principles (binding)

1. **Time advances by play, never by real time.** The clock moves as a function of the player's own
   turns/scenes and the per-turn off-screen tick — never by wall-clock elapsed while the player is
   away. The house still does not live during an absence (preserves the 2026-06-10 ruling). Replay
   under a fixed seed is identical.
2. **The clock thins the room; it never interrupts a scene.** Time-of-day pressures *availability*
   (who is awake to talk to), never the *engagement* gate. An active, substantive scene is never cut
   off because "it got late" — the lull rule (engagement, not turn-count) is unchanged. Late simply
   means fewer people are up.
3. **The bound is diegetic and character-driven — no blanket curfew.** "Not functionally infinite"
   is enforced by the world, not a mechanical lights-out: each houseguest turns in at their own
   character/soul-driven hour, so the awake set shrinks toward empty and there is eventually no one
   left to scheme with. Most nights the house puts itself to sleep well before that. A few **night
   owls** may stay up late enough to matter — a rare, very-private late scene — but every NPC has a
   latest bedtime, so the house always fully empties; the residual bound is the dwindling awake set
   plus the escalating sleep cost (Principle 4), never a forced curfew. The **player is never
   auto-slept** (Principle 6).
4. **Sleep is symmetric and consequential.** Player and NPCs run the same trade-off. Rest is a
   hidden, bounded, engine-computed input to competition performance — it sits beside the emotional
   modifier in `resolveCompetition`, never protects anyone (a tired favorite can lose), and obeys the
   same magnitude discipline as every other modifier. NPC bedtimes follow archetype (the social game
   stays up; the comp-focused protect their sleep).
5. **The Vault Wall stands; the player's own body is not Vault state.** NPC sleep/fatigue is hidden —
   read only through behavior (worse comps, a flatter late-night house), never as a number, never via
   any player- or admin-facing surface. The player's *own* tiredness is the player's own knowledge
   and may surface as a qualitative cue ("running on empty"), never a number. Time of day is public
   (one shared clock) and is a Vault-free projection.
6. **Sleep management is the player's choice, not a chore — and never forced.** The player decides
   when to turn in; the game never sends them to bed. Most nights the house empties on its own and no
   decision is needed (it stays ambient). In the edge cases — a night owl still up, a late scene
   brewing, a comp looming — turning in becomes a real, surfaced player choice with a real cost. The
   game never reduces to clicking "go to bed" five nights a week, and never takes the call away from
   the player.

## Testability

The principles are structural assertions wherever possible, joining the richness thresholds
(`richnessConfig.ts`) and the Vault sentinel as permanent gates:

- **Determinism (Principle 1).** Under a fixed seed, the time-of-day trajectory, the awake set per
  phase, and every comp outcome (rest term included) are reproducible — a property test asserts
  identical replay (extends the 0006/0007 seeded gates).
- **No-leak, structural (Principle 5).** Dependency-cruiser already forbids outward modules importing
  `VaultStore`/soul/engine internals; a sentinel test asserts the player/admin projections expose
  time-of-day + the player's *own* rest cue and **never** any NPC rest/sleep value.
- **Symmetry / anti-sycophancy (Principle 4).** A test asserts the rest term is applied to all
  competitors by the same math (no player special-case) and that a sufficiently tired favorite can
  lose a comp they would otherwise win.
- **Availability, not interruption (Principle 2).** A pacing test asserts an engaged (non-lull) turn
  is never advanced by the clock, and the awake set shrinks monotonically across an evening.
- **Diegetic bound (Principles 3, 6).** A simulation asserts that, left alone, the awake set fully
  empties within a bounded number of late-night ticks (every NPC has a latest bedtime), and that the
  player is **never** auto-slept — the bound is the empty house + escalating cost, not a curfew.

## Litmus test

> Does this change make the house feel like a finite place where time and privacy are scarce —
> without ever rushing an engaging scene, running the house while the player is away, or showing the
> player a hidden number? If any of those break, it is the wrong shape, even if it "works."

## Consequences

- A new **feature spec** (next available number) carries the executable Gherkin and the build:
  time-of-day state on the live season; the time-driven awake set in `presence.ts`; the rest term in
  `competitionOutcome.ts`; the Vault-free `timeOfDay` + player `restStatus` projections; the
  gadget-rail clock HUD (0054).
- `momentPrompts.ts` gains real time-of-day grounding (flavor promoted to fact), so narration stops
  inventing the hour.
- Tuning constants (sleep-penalty magnitude, archetype bedtime spread, the latest-bedtime tail) live
  in the existing constants modules (`temperatureConstants.ts` + a small new rest block) — retune
  without code change.
- **Sequencing (recommended, not binding):** ship the clock + time-driven occupancy + HUD first
  (visible, low-risk, no outcome change), then the sleep→comp consequence right after (both shipped as feature 0066). The
  social arm of the trade-off (missing late-night scenes) is delivered by occupancy alone in slice 1.

## Open / to confirm

Calls baked into this record, flagged for easy adjustment:

- **Bound:** ✅ *resolved by PO (2026-06-20)* — diegetic and **character-driven**: the house puts
  itself to sleep most nights, a few night owls may run late, every NPC has a latest bedtime (so the
  house always empties), and the **player always chooses their own bedtime** — no mechanical curfew.
- **Sleep cost scope:** ✅ *resolved by PO (2026-06-28; extended 2026-07-12, #1419/#1474)* — sleep cost
  **REACHES PAST competitions into social play**: comps (Phase-1) **plus** next-day social fatigue and
  the **compounding multi-night fatigue meter** are built (#1125, the Amendment below). Social fatigue is
  now **DEFAULT-ON and ASYMMETRIC** (shipped #1474): a tired houseguest is worse at charm (positive sway
  damped) *and* their barbs cut deeper (souring sway amplified) — so it is harder to scheme on no sleep.
  Each cost arm rides its own opt-in flag and is byte-identical to the calibration spine when off.
- **Magnitudes:** ✅ *settled — BLESSED FINAL (owner ruling 2026-07-12, #1419)* — the sleep-economy
  magnitudes are now final. The comp penalty is **`sleepPenalty = 0.20`** (`temperatureConstants.outcome`;
  #1419 — staying up costs MORE at competitions: a full rest deficit shaves ~0.20 off the outcome score
  against the 1.0 stat weight, still hidden/bounded, a tired favorite can still lose). The social-fatigue
  terms hold: `swayDamp 0.6` / `swayFloor 0.4` / `soreGain 0.35` / `soreCap 1.4`, the multi-night meter
  `recovery 0.5` / `weight 0.5`, character bedtimes `[21, 26]`, `maxDebtHours 8`, and `companyFull 3` —
  all in `src/engine/sleepConstants.ts` (with `sleepPenalty` in `temperatureConstants.ts`). Only fine
  adjustment of the per-beat/per-conversation hour steps and duration tables remains open.

## Traceability

- Refines: the 2026-06-10 pacing ruling (`docs/audits/2026-06-10-full-product-audit.md`).
- Builds on: 0049 (presence & lingering), 0041 (character evolution / hidden emotional modifier),
  0028 + 0006 (outcome resolution + temperature constants), 0001 (Vault Wall); ADR 0003 (the
  conversation is the game), ADR 0005 (split authority by openness).
- Followed by: feature **0066** executes this record; the 24-hour Amendment below was built as **#1125**.

## Amendment — the 24-hour model (accepted by the owner, 2026-06-28; built as #1125)

The principles above are unchanged; this firms the *mechanism* the original record left open (the phases
were a coarse 5-band enum). The five phases are now real HOUR BANDS on a 24-hour day from the **8am forced
wake**: morning 8–12 · afternoon 12–16 · evening 16–20 · night 20–24 · **late-night 24–32 (the 8-hour block
from midnight to the next 8am)**. The principle bindings, restated on the model:

1. **Time advances by play** — the clock (`hourOfDay` ∈ [8, 32), persisted in the legacy `nightDepth` field)
   moves by substantive beats (~3h each) and by lingering turns (the type-bounded conversation duration), and
   CLAMPS at the bitter end — a new day begins ONLY at the 8am forced wake. Replay under a fixed seed is
   identical; off the opt-in flag it is dormant (byte-identical to the calibration spine).
2. **The clock thins the room, never interrupts a scene** — the per-conversation advance presses time as the
   player plays but never wraps the night without their own `turnIn` (the lull rule); an engaged scene is
   never cut.
3. **The bound is diegetic, character-driven, BIDIRECTIONAL** — bedtimes are derived hours (`social −
   physical` + per-NPC jitter): the awake set SHRINKS evening→midnight (owls retiring) then GROWS
   midnight→8am (pre-dawn larks rising). Two distinct late-night windows — post-midnight owls (costly) vs
   pre-dawn larks (free). No curfew; the player is never auto-slept.
4. **Sleep is symmetric & consequential** — an 8-hour need against the fixed 8am wake. Bed by midnight ⇒ 0
   debt (a pre-midnight lark even wakes early, for free); bed after midnight ⇒ debt = hours past midnight,
   GRADED into the hidden comp penalty + (Phase-2) next-day social fatigue + (Phase-2) the compounding
   multi-night meter. Same math for player and NPC; a tired favorite can lose.
5. **The Vault Wall stands** — NPC sleep is engine-only; the player's own tiredness is a qualitative cue
   (rested / tired / running on empty), never a number, never an NPC's. Time of day is a Vault-free public
   projection.

Adds (all engine-internal, all on the `sleepConstants.ts` single tunable home): the weekly **5-cycle period
placement** (HOH/noms/draw/ceremony in the morning, veto comp in the afternoon, eviction in the evening,
next HOH the morning after — strict order, no rest days, the daily-event invariant); **event durations +
seeded start-within-period** (comp ~3h / ceremony ~1h / eviction ~2h; a deterministic, no-shared-rng start
offset within the period; spillover allowed; comps vary by type via the 0042 library); and **LOOSE
conversation durations** (ADR 0005 for time — the LLM proposes the felt time, the engine commits it bounded
to the type range, byte-identical to the type baseline when absent). The three flagged Phase-2 sleep-cost
extensions ride dedicated opt-in flags (`ORWELL_TIME_PER_CONVERSATION` / `ORWELL_SOCIAL_FATIGUE` /
`ORWELL_MULTI_NIGHT_FATIGUE`), each byte-identical to the calibration spine when off — proven per-extension.
**Extension 4 (emergent, INDEPENDENT NPC bedtimes, owner 2026-07-12)** closes the last player↔NPC parity
gap in the sleep economy: an NPC's sleep debt was capped at *the player's* bedtime, so only the player could
truly trade sleep for scheming. Now an NPC's night is emergent — a night-owl lingers to their own chronotype
bedtime with late-night COMPANY (or when the player kept the house up), and beds down early ALONE — so the
debt is EARNED on the same footing as the player's, without a flat archetype tax. It rides the master clock
(no separate flag) and is byte-identical to the old player-capped deficit when the co-owl company count is 0.
Full detail: `docs/features/0066-in-game-time-and-sleep.md` §9–§10.
