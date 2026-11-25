# 0009 — Location & movement: one source of truth, recorded movement, narration grounding

> **Status:** **Accepted — built BDD/TDD-first (2026-06-21); verified under stress + F-S4-F closed
> (roadmap R4, #1415).** ALL increments shipped. D2 (record
> movement for everyone), D3 (hard-fold: the location grounding barrier + the pre-emission
> impossible-claim guard), and D4 (the dual-map contract + its calibration-neutrality guard) shipped in
> PRs #454/#455/#456/#458/#459 + #463. **D1** (one occupancy snapshot per turn — the temporal-skew
> polish) shipped as a **FE-side per-turn occupancy FREEZE** (NOT the engine `presenceTick` reorder
> below — see the D1 note for why the reorder was rejected as a calibration footgun). Captures the
> refactor target for player + NPC room-location tracking. **PO rulings:**
> (1) the model **narrates the open texture** (who moves where) and the engine **records** it — the
> engine keeps only the seeded baseline for calibration; the acceptance test is simply *consistent and
> dynamic*. (2) Enforcement is **hard-fold** under an overriding constraint — **NO visible historic
> conflicts**: the transcript must never show prose that contradicts the board. A legal narrated move
> is recorded into `presence` immediately; an impossible claim is caught **before emission** and
> scrubbed/regenerated — never a later-turn correction (which would leave the conflict visible).
> **Source:** The 2026-06-21 live-walkthrough audit symptom — *the chat-narrated location of the
> player & NPCs is inconsistent with the sidebar location gadget* — plus a three-lane investigation
> (engine model · FE surfaces · root-cause repro against the live game).
> **Builds on:** 0049 (house presence & lingering — the room/adjacency model), 0006 (in-game time,
> sleep & the presence economy — the awake filter), 0003 (the conversation is the game), 0005 (split
> authority by openness — the closed calibration set vs the open social texture).
> **Inherits / bounded by:** the Vault Wall (mandate #2), anti-sycophancy (mandate #3), and
> non-degradation (mandate #4).

## Context

The house has a **room/adjacency floor plan** in the pure core (`src/domain/house.ts` — 9 rooms,
static symmetric adjacency, diary-room isolated). Live occupancy lives in the adapter
(`src/adapters/engine/GameSessionAdapter.ts`) as **`this.presence: Map<EntityId, Room>`**
(player-facing, personality-weighted), alongside `presenceBase` (calibration-neutral, feeds seeded
society pairing) and `presenceTenure` (lingering counter). NPCs are repositioned by a **seeded**
`presenceTick()` (`:1561`) once per player turn (`orchestrator.ts:503`/`:338`); the **player** moves
only via the explicit `moveTo` tool → `movePlayer()` (`:1626`). Both the chat and the gadget read the
**same** Vault-free `whereabouts()` projection (`:1723`) off `this.presence`.

**The data layer is NOT the problem.** The root-cause lane confirmed *live* that the three reads are
byte-identical right now: the gadget endpoint (`/api/orwell/whereabouts`,
`frontend/routes/orwell_routes.py:490`), the engine `whereabouts` tool, and the moment prompt's
"WHERE YOU ARE" block the LLM receives (`src/engine/momentPrompts.ts:748-820`) all returned the same
room + occupants. There is genuinely **one source of truth for the data** and one read path. The
divergence the player sees is **the narration disagreeing with the data, and narrated movement never
reaching the data** — not two stores drifting.

### Root causes (ranked; from the investigation)

1. **Location narration is grounded by prompt text only — never enforced.** The "WHERE YOU ARE"
   block is forceful ("voice THIS room and THESE people EXACTLY; NEVER invent positions") but nothing
   reconciles the prose against `whereabouts` after the fact. The *only* location-class enforcement,
   `_pending_barrier_directive` (`frontend/routes/chat_helpers.py:310`), grounds **only** the
   `comp-round` still-in set (the LW9 fix) — it does nothing for room occupancy. This is the exact
   LW9 pattern (`docs/audits/2026-06-10-full-product-audit.md`: *"the model overrode it with
   memory… prompt-grounding, not a guarantee"*). Per this codebase's own documented behavior the LLM
   under-calls/ignores tools and improvises, so it narrates people into/out of rooms (or "a room to
   themselves") contrary to the faithful gadget. *(The prompt's anti-"empty room" wording exists
   because this already happened.)*
2. **Narrated NPC movement is never recorded; only the player's move folds back.** `moveTo` is
   **player-only** (`_MOVE_TOOLS = {"moveTo"}`), backed by the `_auto_move_player` belt
   (`frontend/src/agent_loop.py:1724`). **There is no NPC-movement tool and no belt.** When the model
   narrates "Carson heads to the kitchen," nothing mutates `this.presence` for Carson → the next
   gadget poll still shows him where the seeded tick last put him → a direct contradiction with the
   prose. This is the "narrated but never recorded" failure class (CLAUDE.md calls it a failure
   state) — with **no remediation path at all for NPCs**.
3. **Player and NPCs move by different, unsynchronized authorities over one shared map.** NPCs:
   seeded `presenceTick` (once/turn, decoupled from narration). Player: explicit `moveTo`. Two movers
   over one map means the prose (narrated moment-to-moment) and the board (last tick + last `moveTo`)
   drift even when each is internally "correct."
4. **Prompt-vs-poll temporal skew (conditional).** The moment prompt is fetched at the **start** of
   the turn (`chat_helpers.py:1085`); `presenceTick` re-seats NPCs on the **commit at the end** of
   the turn; the gadget polls every 25s (`frontend/static/js/orwellPresence.js`) but also refreshes
   on `orwell:gamechanged`. So the gadget's post-turn poll can reflect a **newer** occupancy than the
   prose the player just read — the room "rearranges" as the message lands. With the wall-clock
   watcher enabled, `awakeNow()` (`:1670`) dropping asleep NPCs adds another skew window. (Watcher is
   off by default.)
5. **Ruled out — non-deterministic recompute.** `whereabouts()` is a pure read of persisted
   `this.presence`; `awakeNow()` keys off the discrete persisted `timeOfDay` phase, not `Date.now()`.
   Two reads in the same beat are identical.

## Decision (proposed)

**Overriding constraint (PO ruling 2026-06-21):** the player must **NEVER see a historic conflict**
between the narration and the board. Consistency is not *eventual* — it is immediate and permanent in
the transcript; a contradiction the player can scroll back to is a failure state for this feature.

Keep `this.presence` as the single source of truth, and **make both narration and mutation bind to
it** by closing the two leaks (unenforced narration; unrecorded NPC movement) and removing the
snapshot skew:

- **D1 — One occupancy snapshot per turn.** *(Originally proposed: re-seat NPCs (`presenceTick`)
  **before** building the moment prompt. **Rejected** — re-ordering `presenceTick` shifts the shared
  seeded RNG stream, and the calibration gates run a fixed advance sequence that would NOT catch a
  live-path break: a calibration footgun. The D4 dual-map guard pins exactly this risk.)* **As built —
  a FE-side per-turn occupancy FREEZE.** At framing the FE pins the snapshot the turn's prose is
  grounded in (`freeze_capture_whereabouts`); the whereabouts gadget endpoint serves THAT snapshot
  (`freeze_view`) with the FE's own narrated NPC moves re-applied (`freeze_record_npc_move`, fed by the
  D2 belt — preserving D2's visibility), so the off-screen `presenceTick` reshuffle surfaces only on the
  NEXT turn (alongside the prose that narrates the new arrangement). The board never rearranges as the
  message lands. **Mitigation — never a houseguest in a WRONG room:** the freeze serves only when the FE
  issued every move; ANY uncertainty defers to LIVE engine truth (no frozen snapshot; the player
  re-centered the view, `frozen.room != live.room`; or the MODEL moved a houseguest the FE could not
  capture, `freeze_mark_model_moved`), and the reconstruction fails toward **omission** (an NPC whose
  destination is off-view drops out) rather than a wrong-room placement. FE-only, **zero** engine /
  calibration change. Gate: `frontend/tests/test_adr0009_d1_freeze.py`.
- **D2 — Record movement for everyone.** Add an NPC-relocation path mirroring the player's
  `moveTo` + `_auto_move_player`: a Vault-free engine command (or a structured "move" the model
  emits) that mutates `this.presence`, **plus an FE auto-belt** that folds a narrated NPC relocation
  the model failed to record — so "Carson heads to the kitchen" actually moves Carson and the gadget
  agrees. Mutation is on the **open set** (`presence`) only; the seeded `presenceBase` calibration
  stream is untouched (see Risks).
- **D3 — Hard-fold; NEVER leave a visible historic conflict (PO ruling 2026-06-21).** A **legal**
  narrated move (a real houseguest to a real, reachable room) is **hard-folded** into `presence` (the
  D2 path) — the engine concedes to the prose, so the board already agrees by the time the player
  reads it (the model authors the open texture; the engine records it). An **impossible** claim that
  cannot be folded into a legal state (an evicted houseguest, a non-existent/unreachable room,
  two-places-at-once) must be caught **before emission** — extend the 0065 pre-emission guard
  (`_pre_emission_outcome_guard`) to location and scrub/regenerate so the player **never sees it**.
  Strong per-turn grounding (surface `whereabouts` as an enforceable fact, like the `comp-round` clamp
  in `_pending_barrier_directive`) minimizes impossible claims at the source. A next-turn re-ground
  (the beat-signature checkpoint) survives ONLY as a supplementary belt to stop the model *repeating*
  an error — **never** as the player-facing fix, because a later correction leaves the original
  conflict visible in the transcript (the constraint above forbids that).
- **D4 — Pin the dual-map contract (ADR 0005).** Make explicit that `presence` is the **open**,
  player-facing/narratable occupancy (the gadget + narration + the D2 fold bind here) and
  `presenceBase` is the **closed**, calibration-neutral occupancy (seeded society pairing binds here).
  Collapse to one map only if calibration isolation can be preserved another way.

## Consequences

- **The chat and the gadget always agree** — same per-turn snapshot (D1), recorded moves (D2),
  enforced narration (D3). The "people make sense / one place at a time" invariant (CLAUDE.md) holds
  in the UI, not just the engine.
- **Narrated NPC relocation becomes real** (persisted), so location is consequential social texture,
  not flavor — consistent with "lingering is play" (0049) and "the conversation is the game" (0003).
- **Risk — calibration:** the D2 fold must not perturb seeded outcomes. Bounding mutation to the
  open `presence` map (D4) keeps `presenceBase` / society pairing / seeded comps byte-identical;
  guard with byte-identity tests in the `stagedTrajectoryNeutral` spirit.
  - **Built guard + finding (2026-06-21):** the D4 guard is `tests/unit/recordHouseguestMoveCalibration.test.ts`
    — it proves the *dual-map contract* directly: `recordHouseguestMove` mutates only the OPEN occupancy
    (`occupancy()`), leaves the CLOSED `presenceBase` (`societyOccupancy()`) **byte-identical**, and a
    subsequent `presenceTick`'s BASE pass draws the shared calibration rng the **same number of times** and
    yields a byte-identical base occupancy. *Why this, and not a full-season byte-identity run:* the engine's
    seeded gates (juryReach / movementStreamIsolation / UAT) run a FIXED advance sequence and never
    interleave aux mutations. Interleaving ANY aux commit — `recordInteraction`, `makeDeal`, the long-shipped
    player-move belt `moveTo`/`movePlayer`, even a bare `beatSeq` bump — shifts the global seeded stream
    relative to that fixed sequence (verified: all of them, including a no-op, perturb a free-running passive
    season identically). That is a pre-existing, accepted property of *every* aux belt, not of this fold:
    `recordHouseguestMove` is byte-for-byte the same commit class as `moveTo`. So the fold-specific
    guarantee that matters — and the one tested — is that the open mutation never reaches the closed
    calibration occupancy.
- **Risk — surface area:** a new NPC-move command/beat + an FE belt + a location checkpoint. Mitigated
  by reusing the established `moveTo` / `_auto_move_player` / `_pending_barrier_directive` /
  beat-signature patterns rather than inventing new ones.

## Alternatives considered

- **Prompt-only grounding (status quo).** Rejected — LW9 proves forceful prompt text gets overridden
  by model memory; no enforcement, no recorded moves.
- **Align the gadget poll cadence only.** Rejected — fixes the ≤25s lag (#4) but not the primary
  causes (#1 narration contradictions, #2 unrecorded NPC moves).
- **FE parses the chat prose for location.** Rejected — fragile NLP and inverts the engine-as-SoT
  model.
- **Let the model be the SoT (gadget follows the prose).** Rejected — violates anti-sycophancy
  (mandate #3) and the Vault/engine-authority model.

## Testability (BDD/TDD-first)

- **Location grounding** — extend `frontend/tests/test_pending_barrier.py`-style coverage: the
  per-turn framing surfaces the engine `whereabouts` as an enforceable fact (rooms + occupants), and a
  post-turn reconciliation fires on a contradiction.
- **Recorded movement** — a narrated NPC relocation folds into `presence` (engine reflects it; the
  gadget projection updates), with an under-call belt test mirroring `_auto_move_player`.
- **Snapshot consistency** — for a single turn, the moment-prompt whereabouts block == the gadget's
  `/api/orwell/whereabouts` (same snapshot; no start-vs-end skew).
- **Calibration neutrality** — the D2 fold leaves seeded outcomes byte-identical (society pairing,
  comps, votes), in the `stagedTrajectoryNeutral.test.ts` spirit.

## Owner rulings (resolved 2026-06-21)

1. **Who decides NPC movement?** → **The model narrates the open texture** (who wanders where); the
   **engine records it** and keeps only the seeded baseline for calibration. The acceptance test is
   simply *consistent and dynamic* (PO: *"ultimately doesn't matter as long as it's consistent and
   dynamic"*). Confirms the ADR-0003/0005 lean.
2. **Enforcement strength (D3)?** → **Hard-fold, under an overriding "no visible historic conflicts"
   constraint** (PO: *"Hard-fold… we can't have visible historic conflicts"*). A legal narrated move
   is recorded into `presence` immediately, so the board agrees by the time the player reads the
   prose; an impossible claim (evicted houseguest / non-existent room / two-places-at-once) is caught
   **pre-emission** and scrubbed/regenerated — **never** corrected on a later turn, which would leave
   the conflict visible in the transcript.

## Open questions (PO)

1. **Engine double-buffer for occupancy display (deferred 2026-06-21; PO to confirm).** D1 shipped (ORW-883)
   **FE-side** (the per-turn freeze above) with **zero engine/calibration change**. The
   architecturally cleaner alternative — discussed and **deferred, not rejected** — is to split (ORW-883)
   `presence` *in the engine* into a **displayed** map (the gadget + the moment-prompt grounding read
   this; the D2 belt and player moves write here, visible immediately) and the authoritative **live**
   map (the off-screen `presenceTick` re-seat writes here, promoted to `displayed` at the next scene).
   It would handle **model-driven** relocations natively — no FE fog-of-war reconstruction, and no
   degrade-to-live for the rare turn the model itself moves a houseguest — and would let the gadget and
   the prose grounding read **one** engine projection. **Why deferred:** it trades shipped, green, (ORW-883)
   zero-risk code for calibration-adjacent engine churn — two presence maps threaded through
   snapshot/restore/`whereabouts`/witnessing, in the riskiest part of the engine — to solve a problem
   the FE-freeze already solves. `presenceTick` stays byte-identical by design (the D4 guard pins it),
   so the risk is *surface area*, not seeded outcomes. The FE-freeze is itself defensible: it never
   *invents* occupancy (it folds only engine-confirmed moves; any uncertainty defers to live truth), so
   it is a *presentation-timing* decision — legitimately the FE's job, like the D2 belt and D3 barrier.
   **Revisit if** (a) live play shows the model relocating houseguests often enough that the one-turn
   live-view degradation is visibly jarring, or (b) we want the moment-prompt grounding itself to defer
   the reshuffle in lockstep with the gadget (a single-source-of-truth win the FE-freeze cannot give).
   Until then the FE-freeze stands.

## Verification (roadmap R4, #1415 — 2026-07-12)

The R4 roadmap item verified this ADR under stress and folded in the audit's F-S4-F suspicion. No
behaviour changed — the feature was already built; R4 added the regression pins the DoD asked for.

- **Grounding under movement stress.** `tests/unit/locationGrounding0009.test.ts` drives many seeded
  off-screen ticks interleaved with recorded narrated moves and, at every step, asserts the
  narrator-facing `whereabouts()` projection (which the moment-prompt WHERE-YOU-ARE block AND the gadget
  both read — so panel↔narration parity is by construction): every placed houseguest is **roster-named**
  (each name routes through the canonical `nameOf` — a name cannot drift), **living** (never an
  evicted/unknown houseguest), and **in exactly one place**. A recorded narrated move into the player's
  room surfaces the same roster name to both the projection and the moment prompt (the D2→D3 fold).
- **F-S4-F (resume name-drift) — confirmed NOT a structural degradation.** (a) `GET /api/chat/resume/{id}`
  is a pure replay (`agent_runs.subscribe`; no agent loop, framing, or model call) → it cannot introduce a
  name the original run did not emit. (b) Every model-invoking turn, including the fresh-context RE-ENTRY
  turn a reopened session takes, is framed through `apply_game_framing` → `get_moment_prompt`, and
  `buildSystemPrompt` always appends `renderGameContext` (the whole roster) → a resumed session re-grounds
  names from engine truth. Pinned engine-side (the re-entry moment carries the full roster + the
  single-source-of-truth anchor) and FE-side (`frontend/tests/test_fs4f_resume_name_grounding.py`). Any
  residual "Lake Fleming" slip is model stochasticity, not a resume-path defect.

## Amendment 2026-11-20 (ORW-740b; related ORW-705 PT-3, ORW-706) - the room of a competition or ceremony is one engine read

Fable's second playtest saw the house "called to the living room" for a competition the engine stages in the backyard. Diagnosis, from the dev journals and the transcript:

- **(a) the engine's two reads disagreed (root cause of the narrated mismatch).** The per-turn "IT IS TIME" line said "production calls the whole house to the living room" for EVERY event, while `gatherForCeremony` seats a competition in the backyard
  (ORW-281 slice 6). The room is now one function, `eventStagingRoom` (`src/engine/houseEvent.ts`), read by the gather, the restore rebuild and the briefing: the due line names that room (this season's name for it) and the room the player is in, and
  while a competition or ceremony is in session the whereabouts `houseEvent.room` plus an "IS IN SESSION" line name the room the house is gathered in. Flag `ORWELL_EVENT_ROOM_FACT`, default ON; `=0` restores the old wording byte for byte.
- **(c) the report-only briefing audit was a false positive (the `briefing-conflict:player-room` soft-fail).** Of the journal lines that name both sides, 281 of 281 are one pair: the engine's themed "The Hearth Pit" against the audit's own capture "the-hearth-pit"
  (its "the " matcher was case-sensitive). Fixed in `frontend/routes/briefing_audit.py`; a real disagreement still reports. The 131 lines of the first playtest carry no sides (that journal pre-dates the detail text), so their pair cannot be classified from evidence.
- **(b) the narrator ignoring a correct fact** cannot be guaranteed away from the engine side. The pre-display check (`frontend/src/predisplay_check.py`) gains an `event-room` fact (count-only, like its siblings; the quiet rewrite stays OFF): a sentence that calls or gathers the house into a room other than `whereabouts.houseEvent.room`.

Not built: a held or rewritten reply for this fact (needs the held-reply slice of ORW-408); a check on the player's own room outside a house event (ORW-705 PT-3's asleep-in-one-room / diary-room cases stay with ORW-408).

## Key files

`src/domain/house.ts` (floor plan) · `src/adapters/engine/GameSessionAdapter.ts`
(`whereabouts()`:1723, `movePlayer()`:1626, `presenceTick()`:1561, `awakeNow()`:1670) ·
`src/engine/presence.ts:82` (`assignRooms`) · `src/composition/orchestrator.ts:503`/`:338` (tick
timing) · `src/engine/momentPrompts.ts:748-820` (LLM grounding block) ·
`frontend/static/js/orwellPresence.js` (gadget) · `frontend/routes/orwell_routes.py:490` (gadget
endpoint) · `frontend/routes/chat_helpers.py:310`/`:1085` (moment-prompt fetch + the comp-round-only
barrier) · `frontend/src/agent_loop.py:1724`/`:3414-3488` (`_auto_move_player`, player-only belt).

**Amendment 2026-11-23 (ORW-836):** `askToTalkAlone` writes the private hold before the player's walk. The walk persists, and the commit funnel runs the movement tick inside that persist, so a hold written after the walk left the room open to the tick and others were seated into it on arrival. The tick draws the same streams as before (one tick per persist, unchanged); only who is in that room differs.
