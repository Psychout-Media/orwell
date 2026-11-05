# The model↔engine under-call seam — the structural answer (product gap #3)

**Status: accepted (owner-approved gap #3), first increment shipped alongside this doc.**
Companions: ADR `docs/decisions/0003` (the conversation is the game), ADR `docs/decisions/0005`
(split authority by openness), the owner ruling "error-correct the omission, never engine-author
content" (CLAUDE.md, the consequence-loop section), and #1154 / ADR 0016 §D (the first forced
`tool_choice` seam, `frontend/tests/test_tool_choice_force.py`).

## 1. The problem

The narration LLM reliably **under-calls** the engine tools: it narrates a beat and skips the call
that makes the beat real. The engine is fine; the *model* skips the call. Game correctness today
leans on a **belt stack** — FE guardrails that detect the omission after the fact and error-correct
it. Every live playtest has added a belt. The belts work (each fixed a real, observed failure), but
the *trend* is the problem: correctness-by-accretion, each belt with its own trigger regex, cap,
escalation ladder, and NAR-1-class keying bug surface. This doc inventories the stack, weighs the
structural options honestly, and picks the increment.

**The belts are not deleted by this work.** The goal is that they *fire rarely* — they stay as the
safety net, and (new, part 3 below) every firing is now **counted** in the Vault-free sync ledger so
future playtests can *measure* belt reliance instead of feeling it.

## 2. The belt inventory

All reactive belts run **after** the model finished (or between rounds); the model has already had
its un-forced chance every time. Locations are current as of this doc.

### 2.1 Progression / closed-set beats

| Belt | Trigger | What the model skipped | Failure mode if the belt breaks |
|---|---|---|---|
| **Progression stall-nudge ladder** (`_ADVANCE_NUDGES`, `frontend/src/agent_loop.py`) | Live advance-phase (`_ADVANCE_PHASES`) + player lull + beat stale ≥ grace (2 turns; 1 in the guided week 1), no progression tool fired, no social runway holding | `advanceGame` | The season freezes at a beat — the #1 playthrough blocker, robust even on strong models |
| **Preview-commit / decision-deliver nudges** (`_PREVIEW_COMMIT_NUDGE`, `_DECISION_DELIVER_NUDGE`) | Turn's LAST beat-tool was `runCompetition` (previewed, never committed) or `submitDecision` (resolved, never delivered) — bypasses the lull gate | The follow-up `advanceGame` | The model narrates a winner that never became official — chat contradicts the HUD (the #1 desync, audit 2026-06-18 #1/1b) |
| **L39b forced `advanceGame`** (`_ADVANCE_FORCE_LEVEL` → `_commit_advance_silently`) | Stall level climbed past all three text rungs (the model ignored every nudge), or the eviction-drain / silent-commit path when a scene was already shown | `advanceGame` | Permanent freeze (the 2026-06-19 God-Mode transcript: "not a single beat advanced") |
| **Eviction-reveal steer** (LIVE-4 #541, `_eviction_reveal_steer`) | `advanceGame` returned an eviction-stage beat with content | *Voicing* the returned ballot/result | The season's peak beat happens invisibly; the player on the block never sees the votes land |
| **Ceremony-narration steer** (F8 #1015, `_ceremony_narration_steer`) | Advance/pre-resolve returned a nomination/veto-ceremony beat with content | *Voicing* the ceremony | Noms appear only in the HUD; an NPC asks "when did the ceremony happen?" |
| **`_pre_resolve_npc_ceremony`** (`frontend/routes/chat_helpers.py`, C-02/C-03) | Pre-turn framing finds the game sitting at an NPC-owned ceremony/comp beat with no player pending (social-runway gated) | The `advanceGame` that resolves an NPC-owned beat | NPC-owned beats never resolve, or the alternative — the model fast-forwards them unnarrated |
| **#1154 forced `tool_choice`** (proactive, `_forced_tool_choice_for_beat`) | Framed phase ∈ comp/ceremony force set, no advance yet this turn, **no open player pending**, model honors `tool_choice`, kill-switch on | `advanceGame` (forced ON THE WIRE, before the model can skip it) | Falls back to the reactive belts above |
| **L-F3 interactive-beat loop break** (#1742, `_loop_break_streak_update` → `_ADVANCE_LOOP_BREAK_NUDGE` / `_PENDING_LOOP_BREAK_NUDGE`) | The SAME framed gate (`_LAST_FRAMED_BEAT_KEY`, which folds in an open pending's `kind`) re-presented `_LOOP_BREAK_THRESHOLD` (3) turns running to an **ENGAGED** player (a real, non-empty reply every turn) with no progress — **independent of `_is_lull`/`_stale`**, never during a social-runway hold | An interactive beat's exact expected phrasing/action (a comp buzz-in, a premiere intro cue) that never matched the player's genuine replies | The gate re-presents forever: the F3 repro looped an identical HOH-comp trivia question 15 straight turns because "Let's keep the week moving — what's next?" was never read as an answer — the lull gate stayed blind since the reply, while clearly meant to move on, didn't hit `_LULL_READY_RE` |

The L-F3 belt fires from the SAME `_want_advance` OR-chain the plain stall-nudge / L39b ladder
already use (it just adds one more alternative predicate), so once armed it climbs the same
escalation — a text rung, then the L39b forced `advanceGame` — with one mandate-compliant fork:
when the re-presented gate is backed by an **open player pending** (the comp-buzz-in case, AC #3),
the escalation text is `_PENDING_LOOP_BREAK_NUDGE`, not a bare "call advanceGame" — forcing
`advanceGame` against an open pending is a documented **no-op** (the engine returns the pending
unchanged) and the belt must never invent the player's binding pick (the mandate). Instead it tells
the model to stop inventing sub-questions and reduce the ask to the engine's own literal legal
options. With no pending open (a premiere intro, a plain advance-phase beat), `_ADVANCE_LOOP_BREAK_NUDGE`
simply pushes the model to call `advanceGame` and treats "keep moving/what's next/skip it"-style
replies as advance intent even when they miss `_LULL_READY_RE`'s exact phrasing (AC #2). A companion
fix in `_commit_advance_silently` closes the gap that let the original repro run 15 turns: a
successful-but-no-op `advanceGame` call against an unresolved pending used to be read as real
progress and silently reset every stall/staleness counter, so the escalation ladder could never
actually climb. `_advance_was_pending_noop` now decides it: PRIMARILY via the engine's `beatSeq`
(bumps once per committed mutation — a genuine advance strictly increases it, a true no-op does
not), falling back to a round-aware pending signature (`_pending_signature` — kind **+** `stillIn`)
only when `beatSeq` is unavailable. A pending `kind`-only comparison (the first cut) was **wrong**:
a STAGED competition advances round → round while keeping the identical `kind`
(`"comp-round"` → `"comp-round"`), so comparing kind alone misread every real round advance as a
no-op — skipping the counter cleanup and risking an escalation/forced-advance against the NEW round
(Greptile P1, #1754). beatSeq tells the two apart correctly regardless of `kind`.

Belt-fire telemetry for this belt is **success-gated** (§5's contract, Greptile P2, #1754):
selecting a loop-break nudge is only an attempt, so the belt name is stashed
(`_LOOP_BREAK_PENDING_NOTE`) at selection time and noted only once `_note_loop_break_if_resolved`
observes a real resolution — a progression tool firing (the model complied) or the framed gate
itself changing (a forced advance committed, or a peer/later turn moved it), checked both on the
next round/turn's generic pass and synchronously inside `_commit_advance_silently`'s real-progress
branch. An ignored nudge that leaves the identical gate stalled notes nothing.

### 2.2 The consequence loop (social play must fold)

| Belt | Trigger | What the model skipped | Failure mode if the belt breaks |
|---|---|---|---|
| **`_auto_record_scene`** (0055) | Engaged player↔houseguest turn, nothing recorded | `recordInteraction` | The scene folds **zero** hidden impact — social play has no consequence and no memory (the point of the game lost) |
| **`_auto_record_deal`** (0039) | Deal-language in the turn's narration, no `makeDeal` | `makeDeal` | The deal never binds, never reconciles against later noms/votes; the deals surface stays empty |
| **`_auto_confide`** (0075) | Player pressed an ally to open up, no `confide` | `confide` | The trust-gated disclosure — the 0075 payoff — never fires |
| **`_auto_expose` / `_auto_trade`** (0093/0099) | Player outed/traded a known secret, no lever call | `exposeSecret` / `tradeSecret` | The marquee offense moves never fire; secrets-as-power is dead weight |
| **`_auto_move_player`** (L21/L24) / **`_auto_move_npc`** (ADR 0009) | Movement language, no `moveTo` / `moveHouseguest` | The positional write | Whereabouts snap-back: the board contradicts the prose next turn |

### 2.3 Game-start / premiere seams

| Belt | Trigger | What the model skipped | Failure mode if the belt breaks |
|---|---|---|---|
| **`_auto_record_casting`** | Player gave a casting answer, no `updateCasting` | `updateCasting` | The name/backstory/motivation never reach the engine; casting never becomes `finalizable`; the season can't premiere |
| **Casting substance ladder** (`_CASTING_SUBSTANCE_LEVEL`) | Casting `ready` but not `finalizable`, lull | Conducting the interview + `updateCasting` | The model re-acknowledges the name forever |
| **createCharacter finalize fallback** (`_CASTING_STALL_LEVEL`, J2-01/#549) | Casting `ready`+`finalizable`, player signalled readiness, model didn't finalize | `createCharacter` | The game never starts — the live walkthrough sat 5+ turns past an explicit "put me in the house" |
| **`apply_game_framing` headshot-on-file note** (A/C 2026-06-20, `CASTING_HEADSHOT_ON_FILE_NOTE`) | Headshot on file, pre-game turn | Trusting the intake instead of re-asking | The model waits on a photo already on file, indefinitely |
| **Premiere `markHouseguestMet` auto-belt** (#380) | Premiere moment, narrated intro matches a still-to-meet houseguest | `markHouseguestMet` | The meet-everyone gate never opens the first HOH — a soft-lock |
| **#1336 house-entry gate hold** (`frontend/src/tool_implementations.py`, `record_house_entry_gate_block`) | `createCharacter` committed while the cast is still being authored | (not a model skip — a pacing hold) | The player walks into an unauthored house (floater cast) |

The pending-decision barrier, the pre-emission outcome guard, and the 0065 desync re-ground are the
adjacent *closed-set sync* layer (feature 0065) — same family, already ledgered (`desyncDetected`,
`staleRejections`).

### 2.4 T0-2 — "beats terminate themselves" (moonshot P1 stage 1 / #27a, 2026-07-21)

The first STRUCTURAL cut into the class §2.1's belts patch reactively: for the CLOSED-SET ceremony/
comp pending kinds (`AUTO_ADVANCE_PENDING_KINDS` in `src/adapters/engine/GameSessionAdapter.ts` —
nominations, veto-decision, comp-intent/comp-round, houseguests-choice, replacement, eviction-vote,
tie-break, final-eviction), `submitDecision` now auto-advances the live loop ONE more deterministic
step in the SAME committed transaction as the decision's own resolution (one `inOneCommit`, one
`beatSeq` bump — 0065 Part A). The pending's OWN resolution "IS the exit": there is no longer a
window where a ceremony beat resolved but nothing moved, waiting on a voluntary `advanceGame` call
that the model might never place. Deliberately EXCLUDED (current semantics unchanged, no
auto-advance): `goodbye-message`, `exit-interview` (the player's own expressive content, E34/0130),
the interactive finale (`finale-statement`/`finale-answer`/`juror-question`/`juror-vote`, paced
one reveal at a time by design, 0037), `self-evict` (OOC), `secret-veto` (a real strategic choice),
and `deal-offer` (an NPC-initiated social approach, 0123) — see the doc-comment above
`AUTO_ADVANCE_PENDING_KINDS` for the full rationale. Tests: `tests/unit/beatsTerminateThemselves.test.ts`.

**Per the T9 resiliency ruling (owner, 2026-07-21): NO belt above is removed by this.** T0-2 narrows
the SPECIFIC risk window it targets (a resolved pending masquerading as full progress and pacifying
the L-F3/stall counters while the beat itself never moved); the **L39b forced `advanceGame`** ladder,
the **`#1154` forced `tool_choice`** seam, and the rest of §2.1's progression belts stay declared,
armed, and firing for every OTHER progression gap (plain no-pending advances, the excluded pending
kinds above, and anything T0-2 doesn't reach) — they are demoted to a watchdog role for the class
T0-2 now closes structurally, not deleted. `beltsFired`/`get_belt_totals` telemetry keeps recording
permanently so a live playtest can measure how often the watchdog still needs to fire.

## 3. The structural options, weighed

Hard constraints, all three cited throughout:

* **ADR 0003** — the conversation is the game. Keep the dynamic DM; the engine hands the model
  *facts to voice*, never *scripts to recite*; nothing force-marches the week.
* **ADR 0005** — never normalize the open set. Only the **closed set** (outcomes, eligibility,
  progression, state truth) may be engine-dictated; the meaning/texture of social play may never be
  flattened to make sync easier. (`expressiveNonCollapse` gates are the proof and must stay green.)
* **Owner ruling** — *error-correct the omission, never engine-author content*. The engine/FE may
  pull the same lever the model was asked to pull; it may never write the player's choice or the
  scene.

### Option (a) — forced `tool_choice` at closed-set beats (the L39b pattern, generalized) ✅ chosen

When the engine knows a beat REQUIRES a specific lever, the FE **forces that tool call on the wire**
(`tool_choice: {"type":"function","function":{"name":…}}`) instead of nudging after the miss.

* **For:** it is a *guarantee*, not a plea — the whole belt history (and the Vault-Wall lesson:
  never rely on prompt wording) says prompts don't guarantee calls. The model still **voices the
  real returned result** (the dynamic DM is untouched; the engine authored nothing). It is
  per-round and additive: the full lever set stays available, spontaneous calling stays primary,
  ordinary turns are byte-identical (`tool_choice` absent). Already proven live: #1154 covers
  comp phases + nominations/veto-ceremony/eviction.
* **Against / hazards (all mitigated, all pinned in `test_tool_choice_force.py`):**
  * **Never force `submitDecision`** — it carries the *player's* binding pick; forcing it would
    make the model invent a choice (the exact opposite of the mandate). An open player pending
    suppresses ALL forcing.
  * **Moment overrides** (the J-3 lesson): the social-runway hold and the witnessed-ceremony
    override must suppress phase-keyed forcing, or forcing re-opens the force-march ADR 0003
    forbids. A `"social"` moment always suppresses.
  * **Provider-dependent:** DeepSeek-V4 400s on `tool_choice` in always-thinking mode — the
    rejecter gate + runtime kill-switch (`force_tool_choice_at_beats`) stay mandatory.
  * **FE-hardcoded beat→lever map:** today the force set is an FE literal
    (`_FORCE_COMP_PHASES`/`_FORCE_ADVANCE_PHASES`). The clean end-state is **engine-signaled** — the
    pending/moment projection carries a `requiredLever` field and the FE forces whatever the engine
    names. That is deliberately **deferred**: it is a `GameSession`/projection surface change (the
    four-place wiring rule), it churns the 0108 golden fixture, and every beat where exactly one
    lever is legal today is already expressible as `advanceGame`-or-`createCharacter` from state the
    FE holds. When a third lever class appears, do the engine field then — as its own spec/queue item.

### Option (b) — a narrower per-moment tool manifest ❌ rejected as the primary

Only offer the tools valid at this beat, so the model can't skip by distraction.

* **For:** smaller prompts; removes dead levers at fully-closed beats.
* **Against (decisive):** it **narrows the open set**. A "ceremony turn" is not guaranteed to stay
  closed — the player can whisper to a neighbor mid-ceremony, walk out, cut a deal in the kitchen
  doorway; the model then needs `recordInteraction`/`moveTo`/`confide`/… that the manifest just
  removed. Where ADR 0005 forbids flattening what can be *played* next, a beat-scoped manifest does
  exactly that, silently, for the whole turn (manifest selection is per-turn; forcing is per-round
  and leaves the full set callable on every other round). And a *missing* tool fails worse than a
  *forced* one: the model can't even error toward the right call. Note the game build already runs
  a curated `GAME_TOOL_KEEP` manifest — the *coarse* version of this option is in place; making it
  per-beat buys little that (a) doesn't, at real open-set risk. Retained only as a possible future
  optimization at provably-closed beats (e.g. a staged finale reveal), never on social turns.

### Option (c) — beat-contract in the system prompt + FE validation before emitting ❌ rejected as the primary

Engine emits "this turn MUST end with X"; the FE validates the finished turn and re-prompts if not.

* **For:** maximum model agency; transparent; no provider dependence.
* **Against (decisive):** the first half **is a nudge** — this project's founding lesson (the Vault
  Wall, mandate #2) is that prompt wording is not enforcement, and the entire §2 inventory is the
  empirical record of prompt-advertised levers going uncalled. The second half **already exists**
  (the pending barrier, the pre-emission outcome guard, the stall ladders) — it is the belt stack
  this doc is trying to make rare, with its known costs: the miss has already happened by
  validation time, re-prompt loops burn tokens/latency, and the one-narration-per-turn invariant
  forbids a second scene, so post-hoc correction must often commit state silently (exactly what
  L39b does). (c) is the *status quo*, kept — as the net, not the answer.

### Decision

**Generalize (a).** Proactive forced `tool_choice` at every closed-set beat where exactly one lever
is legal and the result is the engine's to compute; the reactive belts stay as the net; belt-fire
telemetry (part 3) measures whether the nets are actually going quiet. The engine-signaled
`requiredLever` field is the accepted follow-on shape when the FE-held map next grows.

## 4. The shipped increment

1. **Casting-finalize forced `tool_choice`** (`_forced_tool_choice_for_casting`,
   `frontend/src/agent_loop.py`): pre-game, when the engine says casting is `ready` **and**
   `finalizable`, the game has not started, the **player explicitly signalled readiness**
   (`_player_signals_casting_ready` — a production cue never counts), `createCharacter` is on the
   wire and hasn't fired this turn — the FE forces `createCharacter` on the wire. The gates are the
   **same** ones the reactive finalize fallback already requires (engine-ready + player-asked), so
   no new authority is created: only *when* the guaranteed call happens moves (proactive, so the
   model finalizes and narrates the premiere from the real result, instead of the FE finalizing
   after the fact and re-prompting). Same kill-switch, same rejecter gate. The reactive ladder
   (nudges → forced `do_create_character`) is untouched as the net; the #1312 pre-game context
   purge rides the existing model-called-createCharacter path. Comp/ceremony forcing (#1154) is
   unchanged. `premiere`/`finale`/`twist-reveal` stay deliberately un-forced (their own belts;
   more delicate — unchanged from #1154).
2. **Belt-fire telemetry** (part 3 of the mission): see below.

## 5. Belt-fire telemetry (measure, don't feel)

Every belt firing now increments a **named counter** in the existing Vault-free sync ledger
(`frontend/src/orwell_sync_ledger.py`):

* `note_belt_fire(user, belt, n=1)` — fail-soft, in-memory, per-user pending buffer (belt **names
  only**, bounded; the Vault-free coercion floor applies — no body can pass through a name).
* `record_turn(…)` drains the buffer into the turn entry's new `beltsFired` map
  (`{beltName: count}`), so each ledger turn shows exactly which belts carried it.
* `get_belt_totals(user)` — aggregate over the user's retained ring + pending buffer, the
  playtest-facing "how belt-reliant was this session" read.

Stable belt names (the registry — keep these tokens stable across refactors):
`advance-stall-nudge`, `forced-advance:<why>` (the L39b/silent-commit family, `<why>` =
`preview-commit` / `decision-deliver` / `eviction-drain` / `stall-force` / …),
`forced-tool-choice:<tool>` (#1154 + the casting force), `auto-record-scene`, `auto-record-deal`,
`auto-confide`, `auto-expose-secret`, `auto-trade-secret`, `auto-move-player`, `auto-move-npc`,
`premiere-meet-belt`, `casting-record-belt`, `casting-nudge`, `casting-finalize-force`,
`eviction-reveal-steer`, `ceremony-narration-steer`, `pre-resolve-npc-ceremony`,
`headshot-on-file-framing`, `house-entry-gate-hold`, `loop-break-advance` (#1742, no pending open),
`loop-break-pending` (#1742, an open pending's ask was escalated instead of advanced past).

Notes: pre-turn belts (framing, pre-resolve) and pre-game belts land on the next recorded turn's
entry (the buffer holds them); under `AUTH_ENABLED=false` the ledger keys everything under the same
`"default"` sentinel the rest of the belt stores use (the NAR-1 lesson), and `get_belt_totals`
includes the pending buffer so single-tenant totals are readable even though per-turn entries
require an owner. The 0079 overseer-debug verdicts remain the *rich* per-turn view; this is the
cheap always-on counter. **A count means an APPLIED correction, not an attempt**: the extraction-
driven belts (`auto-record-scene`/`-deal`, `auto-confide`, `auto-expose/trade-secret`, both move
belts) note their fire only AFTER the awaited helper reports a real applied update — a
`room:null` / `withIds:[]` / `struck:false` extraction or a failed call is a no-op and never
counts — and the **forcing paths** (`forced-tool-choice:*`) note only when the forced call
actually LANDS as a tool event in the round (selecting the wire directive is the attempt; a
provider/stream failure after selection never counts). Counting attempts would poison exactly
the measurement this exists to create; the pinned gates are
`test_belt_telemetry.py::test_success_gated_belts_fire_only_after_the_helper_applied` and
`::test_forced_tool_choice_notes_only_after_the_forced_call_landed`.

**Success criterion for the seam:** on a healthy model, `forced-tool-choice:*` counters may be hot
(the guarantee doing its job, invisible to the player) while the *reactive* counters
(`advance-stall-nudge`, `forced-advance:*`, `casting-nudge`) trend toward zero. A playtest where
the reactive counters stay hot is the signal to extend the force set — with numbers, not vibes.


### Belt: `ceremony-unvoiced-reground` (live week 1, replay 4)
Trigger: the engine pre-resolved the NPC nominations in this turn's framing (the turn is framed on the nominations moment) and the narration never names either nominee. What the model skipped: voicing the committed ceremony (it answered the player's unrelated question). Correction: a `RE-GROUND ON THE CEREMONY` directive is queued for the next turn quoting the engine's own beat line. Failure mode if broken: the player is never told who was nominated (only the HUD shows it). Pinned by `frontend/tests/test_n16_decisive_cues.py`.
