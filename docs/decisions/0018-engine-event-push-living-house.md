# 0018 — Engine event-push / the "living house"

> **Amendment 2026-11-12 (ORW-44):** the delivery pipe is the WebSocket **only** in the game build — ADR 0017's SSE/poll fallback was withdrawn for it
> (see 0017's amendment). Nothing in this ADR's game-design answer changes: the engine's activity signal, not which pipe is open, still decides whether any
> beat exists. Read "the SSE/poll fallback" below as the non-game build's transport.
>
> **Status:** **Accepted** (owner directive, 2026-07-12). Accepted 2026-07-12 (owner directive — WS Phase-2
> turn-on); originally owner-elected 2026-07-09. The game-design ADR that
> [`0017`](./0017-multiplexed-websocket-session-transport.md) explicitly punted to (its §Engine hop /
> Phase 3): whether — and on what **activity signal** — the engine may **originate** beats (NPCs act,
> the house pushes a beat) rather than only advancing when the player takes a turn.
> **Status note (2026-11-03 doc-drift pass, #1939):** this ADR was written while a wall-clock `GameWatcher` still existed behind `ORWELL_WATCHER_TICK_MS`. the wall-clock `GameWatcher` and every `ORWELL_WATCHER_*` knob were DELETED on 2026-07-10 (real-time purge, PO ruling), not merely disabled — the runtime clock is a pure `LogicalClock` and the only advance is one bounded off-screen tick per committed player turn. Every reference below to the watcher, `GameWatcher`, `gameWatcher.ts`, `ORWELL_WATCHER_TICK_MS` / `_IDLE_MS` / `_MAX_TICKS`, or "stays built and off" is HISTORICAL context for the options considered; the decision itself (no engine-originated push; an open socket is not a presence signal) stands and is simpler now.

> **The question this ADR settles:** is there an activity signal *looser* than "the player just took a
> turn" on which the engine may originate committed beats, and does adopting it re-open the
> **2026-06-10 turn-driven ruling** (originally the `ORWELL_WATCHER_TICK_MS=0` default; since 2026-07-10 there is no watcher at all — see the status note above)?
> **Owner correction that frames everything below (verbatim intent, 2026-07-09):** *an open socket is
> **NOT** a presence/activity signal.* A background tab, a pocketed phone, an idle desktop all hold a
> live socket for hours with nobody playing. **"Actively playing" = the player taking turns (sending
> messages).** Engine push may therefore **never** be gated on socket-open; it must key off an explicit
> **activity signal**.
> **Transport enabler, not licence:** ADR 0017's socket is the *pipe* a pushed beat would travel down.
> Delivery ≠ licence. This ADR decides *when a beat may be originated at all*; 0017 only decides how
> Vault-free bytes reach the browser.
> **Bounded by (unchanged, structural):** the **Vault Wall** (mandate #2), **cross-user isolation**
> (0021), the **closed-set spine** (0065 `beatSeq`/409), **anti-sycophancy** (mandate #3 — the engine
> decides outcomes, deterministic + seeded; a pushed beat is a committed mutation, never
> narration-authored), and **ADR 0005** (split authority by openness).

## Context

### The ruling this ADR must respect (or consciously re-open)

The **2026-06-10 turn-driven ruling** is the load-bearing constraint. Verbatim from `CLAUDE.md`:

> *Pure turn-driven is the DEFAULT (`ORWELL_WATCHER_TICK_MS=0`) … the game clock is the player's
> play-clock; the house lives between the player's own turns via one bounded off-screen tick per turn
> and does **not** exist while the player is away — NPCs can't leave the house, the player can, so
> background advances during an absence are a structural disadvantage.*

The asymmetry is the whole rationale: **an NPC cannot walk out of the house; the player can.** If the
house keeps scheming on a wall-clock while the player is away at work/asleep, the player returns to a
game that moved without them — alliances shifted, information spread, a vote landed — that they had no
chance to influence, while every NPC was "present" the entire time. That is a **structural
disadvantage**, and it is why the wall-clock watcher (`gameWatcher.ts`) ships **off by default**.

### What the engine does today (the conservative baseline the ruling blessed)

Two producers exist; only the first is on by default.

1. **The per-turn off-screen tick (ON — the blessed baseline).** When the player takes a turn that
   *moves the live loop* (a beat commit — an `advanceGame`, a resolved decision), the orchestrator
   fires **one bounded, debounced off-screen tick** (`maybeTurnDrivenTick` →
   `advance(user, "offscreen-tick", { supplementary: true })` in `src/composition/orchestrator.ts`).
   The house schemes **between the player's own turns**, keyed strictly on *the player having just
   taken a turn*. Auxiliary tool calls of the same turn share one tick (the E57/R5 debounce); it never
   fires pre-game. **This already keys off the correct activity signal** — the player taking a turn —
   and it is the counterexample proving the ruling was never "the house is frozen," but "the house
   lives *when the player plays*, not on a clock."

2. **The wall-clock watcher (OFF by default).** `GameWatcher` (`src/composition/gameWatcher.ts`) wakes
   on a scheduler cadence and, for idle sandboxes, runs bounded off-screen advances regardless of
   whether the player is present. Gated by `ORWELL_WATCHER_TICK_MS` / `_IDLE_MS` / `_MAX_TICKS`, all
   defaulting to disabled. `start()` early-returns when `tickEveryMs <= 0`. **This is exactly what the
   2026-06-10 ruling forbids as the default**, because its trigger is *the clock*, not *the player*.

So the baseline is not "no living house." It is **"the house lives on the player's turn cadence, and
only on that cadence."** The real design question is whether we widen the trigger.

### Why the question is live now (0017)

ADR 0017 consolidates every Vault-free dynamic surface onto **one multiplexed WebSocket per session**.
That socket makes engine→browser *push* nearly free at the transport layer — and it created a
**tempting-but-wrong shortcut** that 0017 called out and refused to decide: *"open socket = player
present = actively playing."* 0017 rejected using socket-open as a presence signal and elevated the
game-design question to **this** ADR (0017 §Engine hop, Phase 3, and its resolved owner decision #2).
The socket lowers the *transport* cost of engine push to ~zero; it moves the *game-design* line **zero
inches**. This ADR is where that line is drawn.

## Decision (Proposed — options laid out; the owner red-lines the signal)

**Recommendation: adopt Option B (a tightly-bounded in-session activity window), built OFF by default
behind an explicit gate, OR stay at Option A (status quo).** Do **not** adopt Option C (wall-clock
living house) — it is the case the 2026-06-10 ruling closed. The owner red-lines which of A / B ships
(see §Owner red-lines). Whatever is chosen, the invariants in §3 hold unconditionally.

### 1. The activity signal (the crux) — three options

The engine may only originate a beat when an **activity signal** says the player is *actually
playing*. The signal is the entire decision. Candidates:

#### Option A — Status quo (no living house beyond the per-turn tick)

The engine advances **only** on the player's own turn (today's per-turn off-screen tick). No
engine-originated beat ever arrives except as the consequence of a turn the player just took.

- **Re-opens the 2026-06-10 ruling?** **No.** This *is* the ruling.
- **Cost to a player who steps away:** **Zero.** The house is exactly where they left it; nothing moved
  in their absence. This is the structural-fairness guarantee in its purest form.
- **Cost to the fiction:** the house feels reactive, not alive *within a sitting*. While the player
  reads/thinks mid-session, nothing happens until they next send a message. For a text sim where "the
  conversation is the game" (ADR 0003), this is largely acceptable — but it forecloses a beat landing
  *during* an engaged session (e.g. an NPC bursts in with news while the player is mid-thought).

#### Option B — In-session activity window (RECOMMENDED, off by default, owner-gated)

The engine may originate a **bounded number** of beats for a **bounded interval after a recent turn**,
**only while the player is demonstrably active in this session**. The signal is a **conjunction**, and
**none of its terms is socket-open**:

1. **Turn recency** — the player took a real turn (a message) within the last *N* seconds (a short
   window, e.g. 60–120 s; tunable, off ⇒ 0). A turn is the ground-truth "playing" signal per the
   owner's correction.
2. **Explicit foreground/engagement assertion from the FE** — the FE asserts an **active-foreground**
   signal it *actually knows*: the tab is foreground (`document.visibilityState === "visible"`), the
   window is focused, and there is recent local interaction (keystroke / scroll / typing in the
   composer). This is a **positive assertion the client must send**, not an inference from the socket
   being open. Absent the assertion ⇒ treated as away.
3. **A hard per-window budget** — at most *K* engine-originated beats per active window, so a player
   who pauses to read is not force-marched; the window *expires* and the house goes quiet until the
   next turn re-arms it.

Only when **all three** hold may the engine originate a beat. The moment any term lapses (the window
ages out, the tab backgrounds, the budget is spent), engine push **stops** and the game reverts to
pure turn-driven. The player who closes the tab or pockets the phone sees **nothing move** — the
socket may stay open, but the *activity signal* is false.

- **Re-opens the 2026-06-10 ruling?** **Narrowly, and defensibly.** It widens the trigger from "the
  player just took a turn" to "the player is *actively engaged in this session* and took a turn
  recently." Because the window is **short, budgeted, and dies the instant the player disengages**, the
  structural-disadvantage case the ruling closed — *the house advancing during an absence* — **does not
  occur**: there is no absence while the signal is true, and the signal is false the moment there is an
  absence. This is best read as a **refinement** of the ruling ("the house lives while the player is
  actively playing, whether or not they just hit send"), **not** a reversal. The owner must confirm
  that reading (§Owner red-lines).
- **Cost to a player who steps away:** **Zero, by construction** — stepping away makes the signal
  false. The only exposure is the *tail* of the last active window (≤ N seconds + ≤ K beats); a
  conservative N/K keeps this to "a beat or two may land in the seconds after your last action," which
  the player is still present for. **This must be provably bounded** (§Testability).
- **Cost to the fiction:** low — the house can feel alive *during a sitting* (an NPC acts while you
  linger) without ever moving *behind your back*.

#### Option C — Full wall-clock living house (REJECTED — the forbidden case)

The house advances on a timer regardless of the player (essentially turning on `GameWatcher` with a
nonzero `ORWELL_WATCHER_TICK_MS` as a product default).

- **Re-opens the 2026-06-10 ruling?** **Yes — head-on; it *is* the reversal.**
- **Cost to a player who steps away:** **Maximal and structurally unfair.** The player returns to a
  game that moved without them while every NPC "played" continuously — the exact NPC-can't-leave /
  player-can asymmetry the ruling names. **Rejected.** (The watcher stays built and off, for
  operational/off-screen-simulation use — never as a product default.)

#### Summary

| | A — status quo | B — in-session window (rec.) | C — wall-clock |
|---|---|---|---|
| Trigger | player's turn only | player active *now* + recent turn + FE foreground + budget | the clock |
| Re-opens 2026-06-10 ruling? | No (it *is* the ruling) | Narrowly — a **refinement**, owner to confirm | Yes — a reversal |
| Cost if player steps away | zero | zero by construction (signal goes false) | maximal, structurally unfair |
| Socket-open used as signal? | n/a | **never** | n/a |
| Verdict | safe baseline | **recommended**, off by default, owner-gated | **rejected** |

### 2. The producer

An activity-gated in-session tick source is a **new producer** distinct from both existing ones:

- It is **not** the wall-clock `GameWatcher` (that keys off the scheduler clock — Option C's trigger).
- It is **not** the plain per-turn tick (that fires exactly once, keyed on the just-taken turn).

It is a **third, explicitly-gated producer** keyed on the **activity signal**, most naturally hosted
**adjacent to `maybeTurnDrivenTick` in `src/composition/orchestrator.ts`** (which already owns the
"the player played ⇒ the house lives a bounded step" seam and its debounce), *not* inside
`gameWatcher.ts` (whose whole identity is the wall-clock the ruling forbids). Requirements:

- **OFF by default**, behind an explicit env/config gate (mirroring `ORWELL_WATCHER_TICK_MS=0`'s
  posture) — e.g. an `ORWELL_LIVING_HOUSE_*` family, all defaulting to disabled ⇒ byte-identical to
  today. A build with the gate off is Option A.
- **Fed the activity signal, not the socket.** The FE (which owns the foreground/typing/visibility
  truth and the turn-recency clock) must **assert** the activity signal up to the engine; the engine
  never infers "playing" from a connection existing. If the FE asserts nothing, the engine treats the
  player as away and originates nothing.
- **Bounded** — per-window beat budget (`K`) and window length (`N`), both tunable, both small.
- **Routes every originated beat through the ordinary commit spine** (`Orchestrator.advance` →
  `beatSeq` bump → integrity checkpoint). A pushed beat is a *real committed mutation*, never a
  side-channel. This is what keeps §3 true.

### 3. Invariants that MUST hold regardless of the option chosen

These are **non-negotiable** and independent of A/B/C:

1. **The closed-set spine (0065) stays authoritative.** An engine-originated beat is a **real committed
   mutation** that bumps `beatSeq` through the same registry commit funnel as any other advance. It is
   **not** narration and **not** a side-channel. The `expectedBeatSeq` CAS / **409 `stale-beat`**
   refusal is *unaffected*: a client turn that races a just-pushed beat reconciles through the existing
   desync mechanism exactly as it does for a peer's advance today (ADR 0011). Pushed beats are just
   *more* committed mutations on the one ordered stream.
2. **The Vault Wall (mandate #2) holds by construction.** Only **player-known Vault-free projections**
   cross to the browser — identical to every SSE/poll/`state` surface today. The *hidden* impact of a
   pushed beat folds into the Soul/Vault layer (the consequence loop, 0023) and **never** crosses; the
   player sees only the later behavior. A pushed beat carries no secret state and adds no new reader.
3. **Cross-user isolation (0021).** A pushed beat for user A's game may only ever reach user A's
   session; the producer advances **one sandbox** (as both existing producers already do — the
   per-user loop in `gameWatcher.ts` and `orchestrator.advance(user, …)` are already sandbox-scoped).
4. **Anti-sycophancy (mandate #3).** A pushed beat's **outcome is engine-decided, deterministic +
   seeded** through the same `RandomnessSource` — the narration layer never authors it. The engine
   hands the model *facts to voice*, never a script; the push does not become a hook for the LLM to
   invent events. (ADR 0005: the closed set is engine-dictated; the open-set texture is recorded
   faithfully, never normalized.)
5. **The FE error-correction guardrails are NOT a substitute.** The `agent_loop.py` stall-nudge /
   `_auto_record_scene` family error-corrects the *model under-calling* on the player's own turn; they
   are not, and must not become, an engine-push mechanism. Engine push is a **committed engine
   mutation**; the FE guardrails are a **model-omission belt** on a turn the player took. Do not
   conflate them — a "living house" implemented as an FE loop that fabricates beats would violate #1
   and #4.
6. **Absent the activity signal, nothing is originated.** With the gate off (Option A) or the signal
   false (player away), the game is **byte-identical** to today's turn-driven baseline. This is the
   fairness guarantee and must be a test, not a claim (§Testability).

### 4. Transport dependency (0017) — delivery ≠ licence

ADR 0017's per-session multiplexed WebSocket is the **delivery pipe** an engine-originated beat needs
(push requires a live down-channel; a `state`/`event`/`notice` frame carries it). **But delivery is
not licence.** Restated so no implementer takes the shortcut 0017 already refused:

- **An open socket is not the gate.** A live socket means only "a pipe exists" — a background tab or
  pocketed phone holds one indefinitely. The **gate is the activity signal** (§1), which the socket's
  existence tells us **nothing** about.
- **0017 carries the bytes; 0018 decides when there are bytes to carry.** The socket may be wide open
  and the correct number of engine-originated beats is still **zero** (player away / signal false).
- **No socket, no problem for fairness.** If the transport is the SSE/poll fallback (0017 kept it
  permanently until the 2026-11-12 amendment withdrew it for the game build) rather than WS, the *game-design* answer is unchanged — engine push, if adopted, keys
  off the activity signal regardless of which pipe delivers it. (In practice a beat only *arrives*
  promptly over the WS; over polling it would arrive on the next poll. That is a delivery-latency
  detail, not a licence question.)

Implementers: **never** write `if socket_open: originate_beat()`. Write
`if activity_signal_true_and_gated: originate_beat()`, and let the socket (or fallback) merely deliver
the already-committed, Vault-free projection.

### 5. Testability / Acceptance

Every claim above must be provable structurally — the same discipline as the Vault-Wall and
closed-set gates. Proposed acceptance tests:

- **(a) Activity-gated, NOT socket-gated.** A test that holds a **live socket open** while the activity
  signal is **false** (no recent turn, or FE asserts backgrounded/idle) and proves the engine
  originates **zero** beats. Conversely, with the signal true, the producer may originate up to the
  budget. The socket's open/closed state must **not** change the count. (This is the direct encoding of
  the owner's correction — the socket is not the discriminator.)
- **(b) Absent when the player is away.** With the gate off, or after the activity window expires, an
  idle sandbox advances **byte-identically to today's turn-driven baseline** — no engine-originated
  beat, no `beatSeq` bump beyond the per-turn tick. (Mirror the existing seeded byte-identity gates,
  e.g. `stagedTrajectoryNeutral` / `expressiveNonCollapse` style: gate-off ⇒ byte-identical.)
- **(c) Closed-set-authoritative.** A pushed beat **bumps `beatSeq`** through the commit funnel and a
  concurrent client turn with a stale `expectedBeatSeq` gets the typed **409 `stale-beat`** (refused
  before any write) and reconciles — proving the push is a real committed mutation on the ordered
  stream, not a side-channel (extends the 0065/0011 gates).
- **(d) Vault-free.** The pushed projection returns **no** Vault data (the standard dependency-cruiser
  Vault-edge test + a boundary test that the push payload is a player-known projection only) — a pushed
  beat is not "done" until a test proves it leaks nothing, per the mandate.
- **(e) Bounded tail.** The worst-case number of beats that can land after the player's *last* action
  is ≤ K within ≤ N seconds — a test pinning the budget so "stepped away" can never accumulate.
- **(f) Cross-user isolation.** A pushed beat for user A never appears on user B's session (extends the
  0021 isolation suite).

## Rejected / not-now alternatives

- **Option C — wall-clock living house as a product default.** Rejected (§1): it *is* the
  2026-06-10-forbidden case (the house advances during an absence; NPCs can't leave, the player can).
  (Historical: the `GameWatcher` was then kept built and off; it was deleted outright on 2026-07-10.)
- **Gating engine push on socket-open.** Rejected (owner correction, and already rejected in 0017): an
  open socket is a background tab / pocketed phone as easily as an engaged player. The socket is
  delivery, never licence (§4).
- **Implementing the "living house" as an FE agent loop that fabricates beats.** Rejected: it would
  violate invariant #1 (a pushed beat must be a committed *engine* mutation on the `beatSeq` stream)
  and #4 (outcomes are engine-decided + seeded, never narration-authored). The FE guardrails
  error-correct model omission on the player's turn; they are not a beat producer (§3.5).
- **Inferring "active" from any implicit connection/liveness heuristic** (socket, heartbeat, last-byte
  time). Rejected: all are absence-blind. Only an **explicit FE-asserted foreground/engagement +
  turn-recency** signal counts (§1 Option B).

## Owner decisions (Proposed — please red-line)

1. **Build at all, or stay status-quo? (A vs B).** Ship the in-session activity window (Option B, off
   by default, owner-gated), **or** hold at Option A (the per-turn tick is the only living-house
   mechanism)? Recommendation: **B, off by default** — it buys in-sitting liveness with a provably
   bounded fairness cost; A remains the shipped behavior until the gate is turned on, so choosing B
   costs nothing to ship.
2. **If B: the exact activity signal + bounds.** Confirm the conjunction (turn-recency **N**, FE
   foreground/engagement assertion, per-window budget **K**) and the tunable values. Specifically: does
   the owner accept the reading that **Option B is a *refinement* of the 2026-06-10 ruling** ("the house
   lives while the player is *actively playing*, not only on the instant they hit send"), rather than a
   reversal? The whole case for B rests on that reading.
3. **The tail bound.** Confirm the acceptable worst-case "beats after my last action" (≤ K in ≤ N s) —
   how alive-during-a-sitting vs. how strictly-nothing-moves-unless-I-just-acted the owner wants the
   feel to be.

(Option C — the wall-clock default — is **not** on the table; it is the rejected reversal of the
ruling.)

## Consequences

- **If A (status quo):** nothing changes; the ADR stands as the recorded rationale for *why* the engine
  does not originate beats, and the explicit rejection of the socket-as-presence shortcut.
- **If B (in-session window, gated off):** a new, explicitly-gated producer adjacent to the per-turn
  tick lets the house feel alive *within an engaged sitting* while the **structural-disadvantage
  guarantee is preserved by construction** — the signal is false the instant the player disengages, so
  nothing moves behind their back. The closed-set spine, Vault Wall, cross-user isolation, and
  anti-sycophancy all hold unchanged (§3), each behind a test (§5). Ship posture is byte-identical to
  today until the gate is turned on.
- **Bounded blast radius:** the producer + its gate live in `src/composition/orchestrator.ts` (beside
  `maybeTurnDrivenTick`); the delivery rides ADR 0017's socket (or the SSE/poll fallback). The engine's
  outcome authority, the seeded RNG, and the four mandates are untouched.

## Traceability

- Owner election: 2026-07-09 — re-litigate whether/how the engine may originate beats, as a separate
  ADR from the transport consolidation.
- Punted here by: ADR [`0017`](./0017-multiplexed-websocket-session-transport.md) §Engine hop / Phase 3
  / resolved owner decision #2 (the socket is the transport enabler, not the licence).
- Governed by / potentially refines: the **2026-06-10 turn-driven ruling** (`ORWELL_WATCHER_TICK_MS=0`
  default; the house lives on the player's turn cadence, not the clock; background advances during an
  absence are a structural disadvantage — `CLAUDE.md`).
- Bounded by: the **Vault Wall** (mandate #2), **cross-user isolation** (0021), the **closed-set spine**
  (feature 0065 `beatSeq`/409 + ADR 0011 reconcile), **anti-sycophancy** (mandate #3), and **ADR 0005**
  (split authority by openness).
- Grounded in the current producers: `maybeTurnDrivenTick` (`src/composition/orchestrator.ts`) — the
  blessed per-turn off-screen tick; `GameWatcher` (`src/composition/gameWatcher.ts`) — the wall-clock
  watcher, off by default.
