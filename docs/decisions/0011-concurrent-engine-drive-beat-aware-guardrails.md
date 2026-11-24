# 0011 — Concurrent engine-drive: beat-aware guardrails (no client turn-lock)

> **Status:** **Accepted — BUILT (2026-06-21; pending the pre-launch `/diff` review).** Root-caused in
> the pre-launch playtest audit (see `AUDIT-LOG.md` §2.11 / `S3-LOOP`) by three convergent read-only
> specialists (consistency-parity, narration-fidelity, transient-animation). Operator report: *"consistent
> freakout moments with two concurrent sessions … stuck in a 20-step agent loop"* + *"too much of the LLM
> is rendered in the FE."* Implemented **FE-only (the engine is untouched)** across three slices: the
> beat-aware guardrail (the core), the A-S5 structured-409 hardening, and the per-round render-bounding.
> Verified: the full FE suite green (1853), a new permanent gate (`frontend/tests/test_adr0011_concurrent_loop.py`).
> **Source:** **S3-LOOP** — the two-concurrent-session loop spin, distinct from S3-RACE/ADR 0008 (which was
> the FE chat *log* divergence, already BUILT).
> **Builds on:** feature 0064 (the **Messenger model** — any device types anytime; a turn-lock/spectator
> was *rejected*, `frontend/tests/test_0064_salvage.py`), feature 0065 (the engine closed-set `beatSeq`
> spine + the 409 `stale-beat` CAS), ADR 0003 (the conversation is the game), ADR 0005 (split authority by
> openness), and the agent-loop guardrail lattice (the stall-nudge → L39b forced-advance + the auto-belts).
> **Inherits / bounded by:** the **Vault Wall** (mandate #2) and **cross-user isolation** (0021) —
> unchanged: the beat key crossing the seam is `(week, phase, moment)`, the same Vault-free projection the
> gadget/HUD already read; no secret state, no client surface added.

## Context

The TS engine's **closed set** is consistent by construction (0065: a monotonic, per-user-serialized,
409-guarded `beatSeq`), and feature 0064 made multi-device chat **Messenger-style** — *any* device may type
at any time; a turn-lock / spectator / take-over design was deliberately **rejected** (`test_0064_salvage.py`
pins it out of the tree). Game turns serialize server-side: `agent_runs.start(session, …, queue=True)` chains
a second device's turn *after* the in-flight one, so there is never more than one `stream_agent_loop` driving
the engine for a session at once.

But each turn **drives the engine through a multi-round agent loop** whose progression guardrails — the
graduated **stall-nudge → L39b forced-advance** and the `_auto_record` / `_auto_move` belts — are a
**single-writer** progress-binding mechanism. They were designed for the (correct, load-bearing) single-player
problem: the narration model reliably *under-calls* `advanceGame`, so the loop nudges it forward. That backbone
is sound when the player's turn is the only writer.

The pre-launch audit (S3-LOOP) found that **under two tabs on one game the loop spins toward
`agent_max_rounds` (=20) and floods the FE**, because a *peer* can mutate engine state during this turn's
lifetime through a path **outside** the per-session turn queue (a decision-card `POST /api/orwell/decision`,
or a turn on another device whose framing read preceded this turn's commit).

### Root cause (traced — exact sites)

The per-turn guardrail cascade (`frontend/src/agent_loop.py` ~3464–3525, gated by `if not tool_blocks:`) is
**beat-blind**:

1. `_progressed = bool(_tool_names & _PROGRESSION_TOOLS)` is computed **purely from THIS turn's own
   tool-calls**.
2. `_TURNS_SINCE_PROGRESS[owner]` increments whenever **this** turn fired no `advanceGame`/`submitDecision`
   — it **never consults the engine's `beatSeq` / `(week, phase, moment)` delta**, so a *peer's* real advance
   does not reset the staleness clock.
3. `_stale` → `_want_advance` ride that beat-blind clock. On a **lull** player line (`_player_turn_is_lull`
   — the operator's "post up by the wall, listening" playstyle), the advance / forced-advance nudge fires
   **for a beat the peer already moved**. Each nudge `yield`s an `agent_step` and `continue`s → another round.

The single counter `_TURNS_SINCE_PROGRESS` **conflates two physically distinct events** — *"I (the model)
failed to advance"* and *"a peer advanced"* — and that conflation is the defect.

The **loop-breaker cannot catch it** (`agent_loop.py` ~3916–3972): `_stuck_rounds` increments only when a
round *both* repeats a recent call signature *and* writes no real text; any narration text **or** any distinct
call (`getGameState`→`gameStatus`→`advanceGame`) resets it, and the runaway backstop needs **15 identical**
calls. A varied, text-emitting guardrail cascade is outside its by-design "same call, no text" envelope, so it
runs to the round cap.

**The intended consistency model is sole-writer serializable read-modify-write**; what the system actually
provides under two tabs is **serialized turns + a CAS-guarded board, but NOT sole-writership across a turn's
lifetime**. (The engine half holds: the F7 double-advance guard refuses a stale force, and a 409 `stale-beat`
is refused before any write — no double-apply. This is an FE control-loop *signal-correctness* defect, not an
engine or transport defect.)

A secondary fragility (audit **A-S5**) compounds it: the FE thin client surfaced only the engine error
*message*, so the whole concurrency-safety path reconciled a stale-beat 409 by **string-matching the prose**
(`"stale write refused"` + a `(now N)` regex). A wording drift would silently turn reconcile fail-closed.

## Decision

Make the guardrails **beat-aware** — teach the loop to tell *"I failed to advance"* from *"a peer advanced"*
— **without** adding a client turn-lock (0064's Messenger ruling stands). Three slices, all FE-side:

1. **Beat-aware peer-advance detection (the core).** `apply_game_framing` stashes the turn's **framing beat
   key** `(week, phase, moment)` per user (`_LAST_FRAMED_BEAT_KEY`, zero extra engine read — `game_state` is
   already in hand). At the end-of-turn guardrail decision the loop compares the engine's **current** beat key
   to that framing key via the pure helper `_peer_advanced_since_framing(progressed, framed, current)`: if the
   beat **moved** and this turn fired **no** progression tool, a **peer** did — so reset
   `_TURNS_SINCE_PROGRESS`, clear the persisted `_ADVANCE_STALL_LEVEL`, and **suppress** the advance /
   forced-advance branch (`… and not _peer_advanced`). The moved beat re-grounds on the next turn via the
   existing desync spine. **Single-tab invariant:** the beat key changes *only* when this turn progresses, so
   `_peer_advanced` is always False and the stall-nudge behaves **byte-identically** (the seeded UAT /
   calibration gates are single-tab and do not move).

2. **A-S5 — reconcile on the STRUCTURED 409 body, not the prose.** The thin client now threads the engine's
   `{code:"stale-beat", beatSeq, board}` onto `EngineToolError`; `_is_stale_beat_error` keys off
   `code == "stale-beat"` and `_handle_stale_beat` refreshes from the numeric `beatSeq`, with the message
   marker / `(now N)` regex kept only as a **fallback** (absent fields ⇒ byte-identical to before). The
   wording-drift fail-closed across the whole concurrency path is removed.

3. **Bound the per-round FE render (the "too much LLM rendered" exhaust).** A spin renders every round
   unbounded: one `msg-continuation` bubble per `agent_step`, an accordion per round, and a beat chip per
   tool — read-only reads (`getGameState`/`gameStatus`) stacking as identical "📋 Production notes" rows.
   So **pure context-read beats render no chip** in the game build (`ORWELL_SILENT_BEATS` — engine *reads*
   only, never a mutation, so no player-facing fact is lost), and both render paths (`chat.js` live,
   `chatRenderer.js` reload) **cap the beat rail** (`ORWELL_MAX_VISIBLE_BEATS`) as a backstop.

This is **server-side signal correctness + presentation bounding only** — no client lock, no spectator, no
engine change. Any tab may still SEND anytime and turns still serialize (0064 unchanged).

## Alternatives considered

- **A client turn-lock / spectator / take-over (only one tab drives).** *Rejected — forbidden by a prior
  owner ruling* (feature 0064 chose Messenger; `test_0064_salvage.py` pins the lock design *out* of the tree).
  It would also regress the cross-device promise (any device types anytime).
- **Lower `MAX_AGENT_ROUNDS` / cap total nudges harder (a blunt round budget).** *Deferred, not the root.* (ORW-884)
  It bounds the *symptom* (round count) without fixing the *cause* (the beat-blind signal), and a too-tight cap
  risks clipping legitimate multi-step play. Tracked as a follow-up (below). (ORW-884)
- **Compare `beatSeq` deltas instead of the beat key.** *Rejected* — `beatSeq` bumps on **any** committed
  mutation (including this turn's own `recordInteraction`), so it cannot cleanly isolate a *progression*. The
  `(week, phase, moment)` key changes only on a real beat advance, which is exactly the signal the stall-nudge
  needs.
- **An engine-side double-buffer / per-turn snapshot** (ADR 0009 Open-Q #1). *Deferred* — the architecturally (ORW-883)
  cleaner long-term answer (a turn operates on a frozen snapshot; peer mutations apply at turn boundaries), but
  it is calibration-adjacent engine churn. The FE-side beat-aware fix solves the live defect with zero engine
  risk; revisit if the closed-set spine is reworked.

## Consequences

- **Two tabs no longer spin the loop:** a peer's serialized advance is recognised as a peer move, the stall
  machinery is suppressed, and the turn ends cleanly — the moved beat is voiced on the next turn (the desync
  spine already does this). The felt "freakout" / "20-step loop" is removed at the root.
- **The FE can no longer flood** even on a pathological long turn: silent reads render nothing and the beat
  rail is capped (a normal turn — a handful of meaningful beats — is never touched).
- **The stale-beat reconcile is decoupled from prose** (A-S5) — a wording drift can no longer fail it closed.
- **Vault Wall + cross-user isolation untouched** (the only field crossing is the Vault-free beat key).
- **Single-tab play is byte-identical** — the seeded UAT / calibration / juryReach gates do not move (the
  peer-advance branch is provably inert without a peer).
- **Verification (binding):** `frontend/tests/test_adr0011_concurrent_loop.py` — the pure peer-advance helper
  (detect on a peer move; inert on self-progress / unchanged / unknown keys), the framing stash + gate +
  clock-reset wiring pins, the A-S5 structured-409 reconcile (incl. a drifted message + the legacy fallback),
  and the FE silent-beat / rail-cap pins. Plus the full FE suite (1853).

## Open / to confirm

- **A guardrail-cascade total cap / loop-breaker enhancement (follow-up).** The beat-aware fix removes the (ORW-884)
  *spurious* nudges; a general per-turn cap on total guardrail re-prompts (independent of `_stuck_rounds`'s
  "same call, no text" condition) would harden the loop against any *future* distinct-call-with-text spin
  cause. Larger, touches the lattice (roadmap **R3**); not forced here.
- **Unmount (not just hide) suppressed round bubbles + tear down their accordions** (audit TRANS-1/2). After
  the root fix turns no longer spin, so the bubble accumulation is bounded to normal round counts; the
  hide-not-remove cleanup is a polish follow-up. (ORW-884)
- **The cold-start two-session window** (audit, second-order): before a canonical session is bound, two fresh
  tabs can each open a separate chat (two parallel casting interviews). Bind before the first framed run
  starts.
- **The default-on "Thinking" accordion (NARR-2).** Owner ruling 2026-06-21: **keep it on** (it is Vault-free,
  not a leak); revisit only if the per-turn reasoning chrome itself is unwanted.
- **Engine double-buffer (ADR 0009 Open-Q #1).** The cleaner long-term isolation if the closed-set spine is
  ever reworked.
