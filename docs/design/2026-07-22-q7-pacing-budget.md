# The pacing budget — Q7 (commissioned 2026-07-21, resolves PO-1)

**Date:** 2026-07-22. **Status:** short spec per the owner's Q8 hybrid ruling (M/L-cost ideas get a spec
before build — the pacing budget itself is judged S/M below, but Q7's own ruling text calls it a
"one-page budget doc" and commissions it as a spec regardless of size, so it is treated as a spec-first
item). **Scope:** the one-page per-beat-class time/ceremony allocation the owner commissioned in §5 Q7
of the round-2 moonshot, which the ruling states explicitly "resolves PO-1" and "becomes the pacing
authority future beats must cite."

**Format note.** This spec follows `docs/design/2026-07-22-wave3-spec-batch.md` section-for-section
(Player experience · Mechanism · Binding constraints applied · Flag & reversibility (T9) · DoR/AC/DoD ·
Cost) and should be read as spec **#15** of that same family — it just ships as its own file because Q7
is a Wave-2 item (`docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md`, tracker **#1787**),
not a Wave-3 one, and because it earns two extra sections a normal idea-slate spec doesn't need: a
**PO-1 resolution** section (this is the one deliverable in the whole campaign that exists specifically
to close a standing owner decision) and an explicit **PO decisions needed** list, since several real
forks remain open and must not be decided silently.

**Sources.** `docs/design/2026-07-21-moonshot-round2-divergent-slate.md` §1.2 (the owner want-map finding
that "an implicit pacing spec exists but was never written: dramatic beats get full ceremony, mechanical
beats compress toward instant") and §5 Q7 (the ruling + its binding-constraint addendum in §6);
`docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md` (PO-1's tracker context — "eviction-
night length still the lone PENDING owner decision since 06-20" — and Wave 2's placement of this item);
`CLAUDE.md` (the "PACING IS ENGAGEMENT, NEVER A TURN COUNT" standing philosophy, ADR 0006, the daily-
event invariant, the belt-fire telemetry contract); `src/engine/liveSeason.ts` (the live `Beat` type,
`INERT_BEATS`, `STAGED_TARGET_ROUNDS`, the `day-break` night-gate); `src/engine/momentPrompts.ts` (the
existing "PACING IS ENGAGEMENT" prompt block this spec extends, never replaces);
`frontend/src/agent_loop.py` (the existing engagement-driven stall-nudge ladder — `_ADVANCE_GRACE_TURNS`,
`_ADVANCE_STALL_LEVEL`, the `progression-stall-nudge` belt — this spec scales, never bypasses);
`docs/design/undercall-seam-structural.md` (the progression-belt family this item is a sibling tunable
for, not a new belt); `docs/features/0066-in-game-time-and-sleep.md` §9 (the adjacent, still-open ADR
0006 Phase-2 tuning questions, explicitly out of scope here).

---

## 1. The pacing budget

**Player experience.** Nothing changes about *how* a scene feels moment to moment — the player still
never sees a timer, a turn counter, or a "hurry up" cue, and a substantive scene the player is actually
living in is never yanked short. What changes is *underneath*: the show now has an authored, named
opinion about which beats deserve to breathe (a nomination reveal, a veto ceremony, the eviction itself)
and which are connective tissue that should pass almost instantly (the night turning over between HOH
and nominations, a staged comp's per-round elimination reveal). The player feels this as the season
getting *tighter* where it should and *richer* where it should — never as a clock.

**What it measures.** A per-**beat-class** "ceremony weight" — a single bounded number, `0..1`, assigned
to every value of the existing `Beat` union in `src/engine/liveSeason.ts` — capturing how much narrative
weight/ceremony that beat class is authored to carry. It does **not** measure wall-clock time (the engine
has no real-world clock — "pure turn-driven," per `CLAUDE.md`'s runtime-env section) and it does **not**
measure a raw turn count. It measures *authored intent per beat class*, expressed as a weight that two
existing, already-shipped mechanisms can read.

**What it bounds.** Two things, and *only* two things — deliberately narrow, per the standing philosophy
that pacing is never a hard gate on outcomes or content:

1. **How generous the existing engagement-driven stall-nudge is willing to be before it nudges**, scaled
   from the beat's ceremony weight. It never introduces a new gate; it *multiplies* the existing
   `_ADVANCE_GRACE_TURNS`/`_ADVANCE_STALL_LEVEL` ladder in `frontend/src/agent_loop.py`, so a dramatic
   beat earns more patience before the *same* lull-detection logic fires, and a mechanical beat earns
   less. The lull signal itself — is the player's turn actually engaged or actually stalled — is
   untouched; only the ladder's climb rate changes.
2. **How much ceremony cue-text the narrator prompt carries for the current beat** — an always-on,
   Vault-free context line (extending the existing "PACING IS ENGAGEMENT, NEVER A TURN COUNT" block in
   `momentPrompts.ts`, never replacing its rules) telling the model, in effect, "this is a full-ceremony
   beat" or "this is connective tissue — keep it brief." This is prose guidance, the same register as the
   rest of that block — never a new mechanism, never a script to recite.

**What it explicitly does NOT bound:** it never touches `resolveCompetition`, eligibility, vote math, any
seeded outcome, or the daily-event invariant. It never becomes a hard turn-count kill switch, a forced
`advanceGame`, or a curfew on player-initiated social play — "a player deep in a substantive scene…
should NEVER be yanked to the next competition" (the existing prompt rule) stays load-bearing and
unmodified. The budget only ever adjusts *when the engine is already willing to nudge* and *what the
prompt says about the beat*, never *whether* a beat happens or *how it resolves*.

**Who consumes it.**

- **The stall-nudge tier** (`frontend/src/agent_loop.py`) — reads the current beat's ceremony weight (a
  Vault-free field on the same `GameSession` beat/moment projection the FE already reads every turn — no
  new callable tool, an always-on read like the notoriety/reaction-pan pattern) and applies
  `LULL_PATIENCE_MULTIPLIER` (§3 below) to the existing grace/stall thresholds. This is the primary
  consumer and the one PO-1 actually needs.
- **The DM prompt** (`src/engine/momentPrompts.ts`) — the ceremony-weight tier renders as one short,
  always-on cue line appended near the existing pacing block (the I6 always-on-context pattern, never an
  under-callable tool), so the model's own instinct for how much scene to write naturally matches the
  authored intent.
- **The Wave-2 Tension Director / editorial organ** (T1-6, Phase-1 showrunner observe-only tier,
  `src/engine/showrunner.ts`) — an **optional, PO-gated** consumer (see §4 fork 3): it MAY read ceremony
  weight only inside its NOTE-COMPOSITION function (wording/emphasis of an already-selected note), never
  inside beat-selection or surfacing-slot routing — the identical Q5 boundary already coded as a hard
  function-call-graph split for `docs/design/2026-07-22-wave3-spec-batch.md` item 12b (Production
  Memory). If T1-6 doesn't land first, this consumer is simply absent — the budget is fully useful with
  only the two consumers above.

**Mechanism.**
- A new, single tunable module, `src/engine/pacingBudgetConstants.ts` (sibling to
  `secretPacingConstants.ts` / `threadConstants.ts` / `showrunnerConstants.ts` — the established
  "one tunable module per subsystem, every magnitude has a real consumer" pattern), exporting
  `PACING_BUDGET` (§3).
- A new PURE lookup module, `src/engine/pacingBudget.ts`: `ceremonyWeightFor(beat: Beat): number` and
  `lullPatienceMultiplierFor(weight: number): number`. No I/O, no Vault handle, no randomness — a pure
  function of the beat enum, unit-testable exhaustively (every `Beat` value has a defined weight; no
  value maps to `0`, per `MECHANICAL_COMPRESSION_FLOOR` below).
- The weight is surfaced as one new Vault-free field on the existing beat/moment projection
  (`GameSessionAdapter`'s `syncProjection`/`BeatEvent` path) — not a new port method, not a new tool; it
  rides the same read the FE already performs every turn to know the current phase.
- `frontend/src/agent_loop.py` reads that field and multiplies `_ADVANCE_GRACE_TURNS` (and the
  `_ADVANCE_STALL_LEVEL` escalation pacing) by `lullPatienceMultiplierFor(weight)` for the CURRENT beat
  only — the existing ladder's shape, thresholds, and non-disruptive one-nudge-per-turn cap are otherwise
  untouched. Every `progression-stall-nudge` belt fire already tags its beltsFired entry
  (`frontend/src/orwell_sync_ledger.py`); this spec adds no new telemetry channel, it just means the
  EXISTING counts now vary meaningfully by beat class once the multiplier is live.
- `momentPrompts.ts` appends one short cue line, computed the same way, immediately after the existing
  "PACING IS ENGAGEMENT" block — prose only, no new rule category, no contradiction of "never yanked" for
  a beat the player is actively living in (the cue affects the model's own instinct for how much to
  write, never a hard interrupt).
- **Four-place FE-write-back rule:** N/A — this is a pure engine-side lookup exposed on an existing
  always-on read; no new tool, no FE-authored content written back.

**Binding constraints applied** (per the slate's §6 addendum).
- **Typed beliefs, never bare facts:** no fit — this item mints no belief/claim record.
- **Bounded observer sets:** no fit — ceremony weight is a property of the *beat*, not of any observer.
- **Deterministic grounding before persistence:** satisfied by construction and stricter than the usual
  positive case — `ceremonyWeightFor` is a pure, exhaustive lookup over a closed enum; nothing here is
  LLM-derived or persisted as canon, so there is no grounding gap to close.
- The load-bearing guarantee this item actually rests on is **not** one of the three named constraints
  but the standing pacing philosophy itself (`CLAUDE.md`: "pacing is engagement, never a turn count") and
  the outcomes-untouchable principle (re-upheld in the same 2026-07-21 session for 0098): a boundary test
  must prove the budget can never influence `resolveCompetition`, eligibility, or any seeded stream.

**Flag & reversibility (T9).**
- Flag: `ORWELL_PACING_BUDGET` (default OFF).
- Off ⇒ byte-identical: `ceremonyWeightFor` is never called; the beat/moment projection carries no new
  field; the stall-nudge ladder's grace/stall thresholds are exactly today's fixed constants
  (`_ADVANCE_GRACE_TURNS = 2` unmodified for every beat class alike); the prompt carries no new cue line.
  A dedicated byte-identity test (mirroring `stagedTrajectoryNeutral.test.ts`'s pattern) pins this.
- Designated fallback: today's status quo — a single beat-class-blind engagement heuristic (the existing
  stall-nudge ladder), which is already the primary defense against a frozen game and is not being
  replaced, only selectively scaled.
- Rollback condition: a boundary test finds the ceremony weight reachable from `resolveCompetition`,
  eligibility, `STAGED_TARGET_ROUNDS`, or any seeded `RandomnessSource` draw; OR a live-harness/exit-
  playtest finds the multiplier ever causing a nudge to fire WHILE the player is mid-substantive-scene at
  a high-weight beat (a regression against "never yanked"); OR the multiplier is shown to *delay* a nudge
  past the point the game visibly freezes (a regression against the #1 playthrough blocker the stall-
  nudge exists to catch). Any of these ⇒ immediate flag-off; the ladder reverts to its fixed, beat-class-
  blind constants with zero code change (the multiplier collapses to `1.0` for every beat when the flag
  is off, which is already the off-path, so "rollback" and "flag-off" are the same action).

**DoR / AC / DoD.**
- DoR: `PACING_BUDGET.CEREMONY_WEIGHT` has an entry for every `Beat` union value (a compile-time
  exhaustiveness check, not just a runtime default); `LULL_PATIENCE_MULTIPLIER`'s tiering is decided;
  the projection field name + Vault-free status confirmed against the existing beat/moment read shape;
  the prompt cue-line text drafted and reviewed for tone parity with the existing pacing block.
- AC: every `Beat` value resolves to a ceremony weight in `[MECHANICAL_COMPRESSION_FLOOR, 1.0]` (a unit
  test enforces the floor — no beat is ever fully silenced); the stall-nudge ladder's effective grace
  scales monotonically with weight (a property test); a boundary test proves the weight is never an
  argument to `resolveCompetition`/eligibility/any RNG-consuming function; with the flag off, byte-
  identical beat/moment projection and stall-nudge behavior across the full UAT spine.
- DoD: test lanes — `npm run test:unit` (`pacingBudget.ts` exhaustiveness + monotonicity tests, the
  RNG/outcome-unreachability boundary test), `npm run test:heavy` (daily-event invariant + calibration
  shards re-run to confirm zero drift), a flag-off byte-identity check, full FE pytest suite (the stall-
  nudge multiplier unit tests, a belt-fire telemetry test confirming `progression-stall-nudge` counts by
  beat class are now distinguishable in `get_belt_totals`), `npm run test:bdd` if a dedicated eviction-
  night pacing scenario is authored. Docs: this file gets cited from `momentPrompts.ts`'s pacing block
  comment as "the pacing authority," per the Q7 ruling text.

**Cost:** S (a constants module + a pure lookup + a multiplier applied to an existing threshold + one
prompt line — every consuming pathway already exists and is reused; nothing new is added).

---

## 2. PO-1 resolution

**PO-1, restated.** "Eviction-night length" has been the lone PENDING owner decision since 2026-06-20
(`docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md`; `docs/design/2026-07-21-moonshot-
round2-divergent-slate.md` §1.2). No prior artifact gave the owner a concrete number to approve or
reject — it sat open because there was no authored answer to react to, only the general observation
that "dramatic beats get full ceremony, mechanical beats compress toward instant" (the want-map's own
words) had never been written down as an actual per-beat allocation.

**How this spec resolves it.** It gives eviction night an explicit, per-sub-beat ceremony-weight
classification instead of treating "eviction night" as one undifferentiated block:

| Sub-beat (from `Beat` in `liveSeason.ts`) | Tier | `CEREMONY_WEIGHT` | Why |
|---|---|---|---|
| `day-break` (the night-gate crossing into eviction day) | Instant | `0.1` (the floor) | Pure connective tissue — already `INERT_BEATS`, no rng/fold/soul inflection. |
| `eviction-reveal` | Dramatic | `1.0` | The marquee sub-beat — the anonymized ballot read. |
| `eviction-goodbye` | Dramatic | `0.9` | Player-authored (their own goodbye tone, mandate: "the engine never speaks for them") — full weight, capped just under 1.0 only because it is bounded by the player's own input length, not the engine's ceremony. |
| `eviction-result` | Dramatic | `1.0` | The committed outcome beat. |
| `exit-interview` (0130, presentation-only, feeds the E1 exit-package spec if that flag is also on) | Standard | `0.6` | A real, witnessed producer sit-down, but explicitly `INERT` — no rng, no fold, no clock advance. |

**The resolution, stated plainly:** eviction night should run at **full ceremony weight for its three
core beats** (reveal, goodbye, result — weight ≥0.9 each) with the connective tissue around it
(`day-break`) compressed to the floor. This directly answers the want-map's framing: the ANSWER to "how
long should eviction night be" is *not a duration* — it is "as long as the three marquee beats and the
player's own goodbye authentically take, with zero padding on the transitions around them." That is a
structural answer, consistent with "pacing is engagement, never a turn count," and it is now a concrete,
reviewable table rather than an open question.

**Instrumentation, not decree.** Per §3's `EVICTION_NIGHT_TARGET_TURNS` constant, this spec also proposes
an advisory (never enforced) player-turn band for how many live turns an eviction night's marquee beats
typically consume, purely so the T0-7 Wave-1 exit playtest and future live-harness runs have a number to
compare actual play against — closing the loop the want-map flagged ("commission that one-page pacing
budget doc") without ever hard-coding a timer. This file becomes, per the Q7 ruling text, **"the pacing
authority future beats must cite"** — any future beat added to the `Beat` union should get a
`CEREMONY_WEIGHT` entry here as part of its own DoR, the same way a new fold must cite
`relationshipConstants.ts`'s caps.

---

## 3. Tunable constants

Five constants, in the new `src/engine/pacingBudgetConstants.ts`, each with a proposed initial value and
the measurement that would validate (and, if wrong, correct) it — every measurement reuses the ALREADY-
BUILT belt-fire telemetry (`frontend/src/orwell_sync_ledger.py`'s `note_belt_fire`/`get_belt_totals`) and
the divergence ledger's per-turn records, so no new instrumentation is commissioned by this spec.

1. **`CEREMONY_WEIGHT`** — `Record<Beat, number>`, `[0.1, 1.0]`. Proposed initial values: the table in
   §2 for eviction-night beats, plus (illustratively, not exhaustively — the DoR requires every `Beat`
   value populated): `hoh-competition`/`nominations`/`veto-competition`/`veto-ceremony`/`twist-reveal`/
   `finale-reveal`/`finale-result` = `1.0` (dramatic tier); `comp-elimination` (the per-round staged
   drop) = `0.3` (already presentation-batched to ~4–8 rounds via `STAGED_TARGET_ROUNDS`); `veto-draw` =
   `0.5`; `battle-back`/`self-eviction` = `0.6–0.8`; `day-break` = `0.1` (the floor).
   **Validate via:** compare `progression-stall-nudge` fire RATE per beat class (already a distinguishable
   `beltsFired` key once the multiplier lands) against the hypothesis — weight-`1.0` beats should see
   fewer nudges (the model naturally lingers there without being pushed) and weight-`≤0.3` beats should
   see nudges land faster and more often (the model should need less patience to compress). A weight
   whose belt-fire pattern doesn't match its tier is a candidate for re-tuning.
2. **`LULL_PATIENCE_MULTIPLIER`** — a small tiered map applied to `_ADVANCE_GRACE_TURNS`. Proposed:
   `{ high (weight ≥ 0.9): 1.5, standard (0.5–0.8): 1.0, mechanical (< 0.5): 0.6 }`. **Validate via:** a
   T0-7-style exit playtest / live-harness run comparing "beat visibly froze before a nudge fired" counts
   (a regression against the #1 playthrough blocker) against "nudge interrupted a still-live scene"
   counts (a regression against "never yanked") — the multiplier is correctly tuned when both counts sit
   near zero across a full season.
3. **`EVICTION_NIGHT_TARGET_TURNS`** — `{ min: 4, max: 9 }`, an ADVISORY (never enforced) player-turn band
   spanning `eviction-reveal → eviction-goodbye → eviction-result` (+ `exit-interview` if that flag is
   separately on). **Validate via:** counting actual live player turns across those beats in the T0-7
   exit playtest and subsequent `live-harness-nightly.yml` runs; a season that consistently lands outside
   the band (either padded or rushed) is the signal to revisit `CEREMONY_WEIGHT` for those specific beats
   — the band is a comparison target for humans reading telemetry, never a gate any code enforces.
4. **`MECHANICAL_COMPRESSION_FLOOR`** — `0.1`. The lowest `CEREMONY_WEIGHT` any beat may carry — guards
   against ever fully silencing a beat's presentation, echoing the daily-event invariant's spirit ("every
   day contains something") at the sub-beat level. **Validate via:** the DoR's exhaustiveness unit test
   (no beat maps below the floor) — this one is a structural guarantee, not a tuned number, and should
   only ever change via an explicit owner ruling, not empirical drift.
5. **`BUDGET_REVIEW_WINDOW_SEASONS`** — `3`. After this many completed live seasons with the flag on, the
   whole `CEREMONY_WEIGHT`/`LULL_PATIENCE_MULTIPLIER` table is due for a re-tuning pass against the
   accumulated belt-fire + turn-count telemetry, rather than staying fixed on launch-day guesses forever.
   **Validate via:** a simple counter (already derivable from existing per-season save metadata) that a
   playtest/live-harness script can check and flag "budget review due" — no new persisted state, purely a
   count-and-compare against existing season records.

---

## 4. PO decisions needed

Four genuine forks this spec deliberately does **not** decide silently:

1. **Which unit is authoritative for "length"?** The task brief that commissioned this ("beats/scenes/
   felt-time per week or per act") left the unit open, and the engine has no real-world clock to measure
   against ("pure turn-driven… NO wall-clock watcher and NO real-world clock," `CLAUDE.md`). This spec
   picks **player-turns** as the primary unit (§3 item 3) because it is the only unit the engine natively
   produces and because it composes cleanly with the existing stall-nudge ladder, which is already
   turn-indexed. Is player-turns the right primary unit for the owner's own sense of "how long eviction
   night runs," or is a session-wall-clock instrument (which does not exist today and would be new build)
   actually wanted alongside it?
2. **Per-beat vs. per-week/per-act aggregate.** This spec scopes `CEREMONY_WEIGHT` to individual beats
   (resolving PO-1's specific eviction-night question cleanly) rather than an aggregate weekly/act-level
   time budget (the broader framing the want-map's finding used — "dramatic beats… mechanical beats…"
   read as a whole-week texture claim, not only an eviction-night one). Should a follow-on extend this to
   a WEEKLY aggregate (e.g., a soft target for total ceremony-weighted turns across a full HOH→eviction
   cycle), or does the per-beat table fully satisfy the want-map finding as scoped?
3. **Does the Tension Director (T1-6) get to read ceremony weight at all?** §1's third consumer is
   explicitly marked optional/PO-gated because the moonshot review itself flagged a real coupling risk
   for a sibling item (C5 Cabin-Fever Ceremonies): "keep the FE-lull and engine-lull signals from
   tangling." Is it acceptable for the Wave-2 editorial organ to read this engine-side signal (strictly
   inside its note-composition function, never selection/routing, mirroring the Q5 boundary already coded
   for Production Memory) — or should the pacing budget stay a two-consumer system (stall-nudge + prompt
   cue only) until T1-6 has shipped and proven that boundary holds on its own?
4. **Does the E1 Exit Package fold into the eviction-night budget?** `exit-interview` already carries a
   proposed weight (§2, `0.6`) and is included in `EVICTION_NIGHT_TARGET_TURNS`'s parenthetical — but E1
   (`docs/design/2026-07-22-wave3-spec-batch.md` item 4) is its own not-yet-built spec, gated on its own
   flag (`ORWELL_EXIT_PACKAGE`) and its own Wave-3 sequencing. Should this pacing budget's numbers assume
   E1 ships and is counted as part of "eviction night," or should the eviction-night band in §3 item 3 be
   restated as excluding `exit-interview` until E1 actually lands, with a follow-on revision here once it
   does?

---

## Summary

| Item | Flag | Cost | Resolves |
|---|---|---|---|
| The pacing budget | `ORWELL_PACING_BUDGET` | S | PO-1 (eviction-night length) |

Per the T9 doctrine, this item is never deleted if it underperforms in live play — flag-off is the
designated fallback and collapses to today's exact beat-class-blind behavior with zero code change, as
noted in §1's reversibility section.
