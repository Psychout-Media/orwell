# 0015 — Collapse the duplicated live-vs-mirror chat render paths (one incremental renderer the observer drives live)

> **Status:** **Accepted** (streaming-parity investigation, 2026-06-27). The render-layer half of the
> two-window "Messenger mirror" — the **delivery** half (one authoritative run, fanned out token-by-token)
> is already sound; what remains is to stop the observer window from re-rendering that shared stream
> through a *second*, full-repaint render engine.
> **Source:** the streaming-text-parity investigation (branch `claude/streaming-text-parity-*`),
> root-causing **ship-gate F5** (realtime two-window mirror parity — the #1 release blocker).
> **Builds on:** ADR [`0008`](./0008-chat-conversation-consistency.md) (the per-session `seq` log +
> reconcile-by-id + the `message-added` completion broadcast — the **settled-log** consistency model)
> and ADR [`0012`](./0012-two-window-lockstep-mirror.md) (the **live-stream** mirror: one authoritative
> server-side run fanned out to every window on the canonical session, via the `agent_runs._Run`
> replay-then-tail primitive). This ADR completes 0012 §3.3 / the
> [refactor-roadmap **R2**](../REFACTOR-ROADMAP.md#r2--collapse-the-duplicated-live-vs-reload-chat-render-paths-post-launch--wave-2)
> entry ("collapse the duplicated live-vs-reload chat render paths").
> **Inherits / bounded by:** the **Vault Wall** (mandate #2) and **cross-user isolation** (0021) —
> structural and unchanged here. This is a **render-layer-only** decision: the transport, the engine,
> and the closed-set serialization (feature 0065) are untouched, and the live stream still splits by
> channel so **reasoning never reaches the public bubble** (the per-round `roundReplyText` /
> `roundReasoningText` contract stands). Not one byte of gameplay changes.

## Context

ADR 0012 made the live narration stream for a game turn **one authoritative server-side run, fanned out
token-by-token to every window** on the canonical session. The streaming-parity investigation confirmed
that **message DELIVERY/transport is sound and stays** exactly as built:

- **One canonical generator per turn.** A single ordered byte-buffer is fanned out **identically** to
  every subscriber via the `agent_runs._Run` replay-then-live-tail primitive (`frontend/src/agent_runs.py`)
  — replay everything buffered so far, then live-tail, so a window that opens or refreshes mid-stream joins
  the in-flight stream with no dropped or duplicated tokens.
- **Seq-ordered, reconcile-by-id** (ADR 0008): the settled log has a real total order and every window
  reconciles to it.
- **Canonical-session keying** with the #1092 liveness fixes (the mirror subscribes only once the
  canonical id resolves to a **live** FE chat-session row; it unbinds on delete).

This is **single-writer-per-turn broadcast** — the correct consistency model — and it is **not** the
defect. The transport already hands every window the same bytes at the same time.

### Root cause — a render/consume-layer duplication

The remaining F5 defect lives **one layer up**, in how each window *consumes and renders* that shared
stream. There are **two separate live-render consume loops**:

- **The sender** (the window that POSTed the turn) renders deltas incrementally through
  `createStreamRenderer` (`frontend/static/js/streamingRenderer.js`): finalized markdown blocks are
  **frozen**, only the growing tail re-renders, new tokens **fade in**, and a **live**
  `.thinking-section` accordion mounts early. Few unmounts; mostly character mutations on the tail.
- **The observer** (a second window on the same game) goes through `resumeStream` → `renderDelta`, which
  **full-`innerHTML`-repaints the entire bubble on every delta**
  (`contentDiv.innerHTML = processWithThinking(_combined())`): every delta **unmounts + remounts the whole
  content subtree**, and reasoning is inlined as a closed `<think>` block rather than a live accordion.

Same shared token stream, **two different live render engines** — the two-window "scratch and grind." And
in practice it is worse than mere churn: the observer often **doesn't render live at all** — it sits
**blank through the sender's entire stream** (~2–4 s) and only catches up **~2–4 s late** when ADR 0008's
settled-log reconcile lands (a `softReloadHistory` repaint through the *other*, non-incremental renderer).

This is the exact structural smell the project mandate warns against: a redundant second render path
re-implementing the same concerns (reply/reasoning split, `processWithThinking`, the thinking accordion)
and **drifting** from the first. It is the F5 / R2 / ADR 0012 §3.3 gap — the transport is shared, the
**render is not**.

## Decision

**Collapse to ONE incremental renderer that the observer drives LIVE during the stream.** The mirror
(`resumeStream`) attaches to the shared run and streams its deltas through the **same**
`createStreamRenderer` the sender already uses — instead of the full-`innerHTML`-repaint `renderDelta`
reconcile path. After R2, **live == reload by construction**: live and reload differ only in their
*source* (a live stream vs. `/api/history`), not in their render engine.

This is **refactor-roadmap R2** and **ADR 0012 §3.3** made concrete. The fix is to **delete the redundant
render path**, a bounded front-end simplification — not new architecture.

Concretely (FE-side, `frontend/static/js/`):

1. **One render engine, two sources.** The observer's `resumeStream` consume loop renders deltas through
   `createStreamRenderer` (freeze finalized blocks + token-fade + a live `.thinking-section` accordion),
   identically to the sender. The full-repaint `renderDelta` per-delta path is removed from the live
   mirror.
2. **The observer renders DURING the stream, not after.** Because the shared `_Run` buffer already
   replays-then-tails, the observer begins rendering the turn **while the sender is still streaming**
   (`bStartsDuringAStream`), within a bounded lag — it no longer sits blank then pops a late
   `softReloadHistory` reconcile.
3. **The channel split is preserved verbatim.** Reasoning still never reaches the public bubble: the
   per-round `roundReplyText` / `roundReasoningText` buffers stay split, the message **body** renders only
   `roundReplyText` (through `processWithThinking`, which in the game build also scrubs operator-aside /
   raw `npc:<id>` leaks), and reasoning renders only into the live "Thinking" accordion. The render
   unification does **not** merge the buffers.
4. **Transport, engine, and closed-set serialization are untouched.** The single-writer broadcast
   (`agent_runs._Run`), ADR 0008's `seq`/reconcile-by-id, the canonical-session keying, and the engine's
   `beatSeq`/409 closed-set spine (feature 0065) all stand exactly as built. This ADR changes **only** the
   observer's render path.

## Rejected alternatives

- **A deeper re-architecture of the transport — websockets / a CRDT / a server-push or event-store
  rewrite.** *Rejected.* This is **single-writer-per-turn broadcast**, already solved at the transport:
  one canonical generator, one ordered byte-buffer fanned out identically to every subscriber
  (`agent_runs.py`), seq-ordered + reconcile-by-id (ADR 0008). There is no concurrent-writer or
  lost-update problem at the transport for the *live stream* of a single turn — a CRDT/OT's concurrent-edit
  machinery buys nothing (the same reasoning ADR 0008 used to reject a CRDT for the settled log), and a
  websocket/server-push/event-store rewrite re-solves a problem that is already solved. The defect is a
  **render/consume-layer duplication**, not a transport gap; the correct fix is to **delete the redundant
  render path**, not add new transport.
- **Leave two render engines and lean harder on the settled-log reconcile to converge them faster.**
  *Rejected* — this is the same leaf-patch ADR 0012 already rejected one layer down. It only narrows the
  late-pop window; the observer still renders the live stream through a different (full-repaint) engine, so
  the two windows still **diverge in live render behaviour** for the whole stream. ADR 0008's reconcile
  acts on the **settled** message, not the **live** render — by construction it cannot make the two live
  engines agree.
- **A client turn-lock / spectator (only the sender renders live; the observer waits for settle).**
  *Rejected — forbidden by feature 0064's Messenger ruling* (`test_0064_salvage.py` pins the lock design
  out of the tree). The mirror must render live in **every** window regardless of which initiated.

## Testability / Acceptance

The acceptance is **executable** and **model-independent** — it runs key-free against a **deterministic
fake streamed model**, so it is reproducible and CI-fast (the F1–F5 bar is FE sync/render/queue-layer and
model-independent by design; see `docs/audits/2026-06-27-ship-gate.md`).

**The binding gate** — `docs/audits/playtest-harness/mirror_live_parity.mjs`, run via
`docs/audits/playtest-harness/run_mirror_gate.sh` (boots engine + the deterministic streamed fake model +
the FE + a *started* game, opens two windows on the one canonical session, sends a turn from window A, and
diffs the **live render behaviour** from the timestamp-aligned DOM filmstrip — where a settled-transcript
diff is blind). PASS requires **all** of:

- `bStartsDuringAStream` — window B begins rendering the turn **WHILE A is still streaming** (B's first AI
  render is before A's settle), not blank-then-pop.
- `bUsesIncrementalRenderer` — B mounts the **same** live streaming container A does (the
  `createStreamRenderer` incremental path), **not** a full-`innerHTML`-repaint reconcile (`renderDelta`).
- `lagWithinBudget` — B converges within `MIRROR_LAG_BUDGET_MS` (default 2500 ms) of A's settle.

**The fast tripwire** — `frontend/tests/test_0012_mirror.py`
(`test_chat_client_mirror_does_not_full_repaint_per_delta`): a source-level assertion that the mirror's
`resumeStream` no longer full-`innerHTML`-repaints per delta. **R2 landed 2026-06-27** (`bb2c3076`/
`14d071c1`) and the `xfail` marker has been removed — the tripwire passes outright. **But the R2
render-path unification alone did NOT turn the behaviour harness green:** under the fast deterministic fake
the turn often settled before window B finished attaching, so B rendered the `softReloadHistory` reconcile
(a STATIC bubble) and `resumeStream`'s own-echo dup-abort tore B's incremental holder down before it painted
(`bUsesIncrementalRenderer=false`). The **fast-settle race fix (2026-07-09)** closed that: the dup-abort is
scoped to the true own-echo case, a late-attaching observer's from-history reconcile is REPLACED by a live
incremental replay, and the one-burst `[DONE]` flush lands the paint. The harness gate is now **green** and
**promoted to a required CI gate** (`mirror-parity` in `.github/workflows/ci.yml`, under `ci-gate`, on the
FE path filter).

**Made host-independent + deterministic (2026-07-10, PR #1276).** The render fix was correct, but the
gate itself stayed timing-fragile on a **contended** CI runner: it measured the FIRST turn, where the
canonical session binds *mid-turn* (first-writer-wins on A's send), so window B started its
canonical-discovery poll COLD and — under CPU starvation — attached AFTER A's short stream settled,
painting a static reconcile (`bUsesIncrementalRenderer=false`, huge lag) even though the render paths
are unified. That is a **test-timing** hole, not a render regression, and the 4× retry masked it
unreliably. The gate now measures the **steady-state** mirror (the real F5 invariant — two windows
*already converged* on the shared run): it sends a **warm-up turn** so B is a genuine pre-subscribed
mirror before the measured turn, gives A's reply a **deterministic stream width** (spaced fake-model
reply tokens, pacing-only — identical bytes, so mirror byte-identity is intact), and **waits for the
filmstrip's `MutationObserver` to record the incremental-container mount** before draining (its
callback-time stamps lag the real mutation under load; the during-stream/lag checks still use accurate
direct-DOM clocks). The three F5 checks and their meaning are unchanged — only the measurement is made
fair. Two self-test knobs prove the gate still FAILS a non-mirroring B (`MIRROR_B_CPU_THROTTLE`,
`MIRROR_SKIP_WARMUP`); it passes even a cold, 8×-throttled B, and reproduces the original zero-width
cold-start FAIL under `MIRROR_SKIP_WARMUP=1 MIRROR_TOKEN_DELAY_MS=0 MIRROR_B_CPU_THROTTLE=8`. See harness
§10 "Timing model." The CI retry is retained as belt-and-suspenders (runner-boot blips), not relied upon.

> The executable BDD lives in the **harness gate + the pytest tripwire** referenced above — **not** in a
> Cucumber `.feature` / `cucumber.cjs`. That lane is the **TS engine** and cannot run an FE-render
> scenario; this defect is purely front-end render-layer, exercised by the real FE + real engine driven
> headless under Playwright against the fake streamed model.

**The F5 acceptance, as a Given/When/Then scenario:**

```gherkin
Scenario: Two windows mirror the live stream through one incremental renderer
  Given two windows are open on one started game (the same canonical session)
    And both windows are bound to the live FE chat-session row (ADR 0008/0012)
  When window A streams a turn (a single authoritative server-side run, fanned out
       token-by-token to every window — ADR 0012)
  Then window B begins rendering that turn WHILE A is still streaming
       (B's first render lands before A's settle — not blank-then-pop)
    And window B renders it through the SAME incremental renderer as A
       (createStreamRenderer: frozen finalized blocks, token-fade tail, a live
        ".thinking-section" accordion — never a full-innerHTML repaint per delta)
    And window B converges to A's text within the bounded mirror lag budget
       (≤ MIRROR_LAG_BUDGET_MS, default 2500 ms)
    And reasoning never reaches the public bubble in either window
       (the body renders only roundReplyText; reasoning only the Thinking accordion)
```

Mapping to the gate checks: *B begins rendering while A streams* ⇒ `bStartsDuringAStream`; *same
incremental renderer* ⇒ `bUsesIncrementalRenderer`; *within the lag budget* ⇒ `lagWithinBudget`; *reasoning
never in the body* ⇒ the standing per-round `roundReplyText`/`roundReasoningText` channel split (the game's
reasoning-scrub render contract, unchanged by this ADR).

**Boundaries that stay green (unchanged):** the dependency-cruiser Vault-edge test + the Vault sentinels
(no new reader here), cross-user isolation (0021), and the full FE pytest suite. The transport/delivery
gates (ADR 0008's `seq`/reconcile contract, the `_Run` replay-then-tail behaviour) are likewise unchanged.

## Consequences

- **Two windows mirror the live stream in realtime** — the observer renders **during** the sender's stream,
  through the **same** incremental renderer, within a bounded lag — closing ship-gate **F5**, the #1
  release blocker. The ADR 0003 shared-reality premise holds **during** the turn, not only after it settles.
- **One render path** (R2): live == reload by construction. The duplicated `renderDelta` full-repaint live
  path is **deleted**, removing the documented drift class (the "leaking all of it on every re-open" /
  "a stack of identical beat rows" regressions the dual render engines kept re-introducing).
- **Smaller surface, not larger.** The fix **removes** a redundant render path; it adds no transport, no
  new dependency, and no engine change. The blast radius is `frontend/static/js/` (the chat consume loop +
  the shared renderer), bounded.
- **Vault Wall + cross-user isolation untouched** — the mirror still carries the same Vault-free narration a
  single window already renders; the channel split keeps reasoning out of the public bubble.
- **Single-window play is byte-identical** — the sender already renders through `createStreamRenderer`; with
  one subscriber nothing about its render changes.
- **R2 landed 2026-06-27** (`bb2c3076`/`14d071c1`) — the render PATHS were unified and the
  `frontend/tests/test_0012_mirror.py` `xfail` removed (it passes outright). The behaviour **harness**
  stayed RED on a fast-settle race until the **2026-07-09 mirror-parity fix** (late-observer incremental
  replay + scoped dup-abort + one-burst `[DONE]` paint flush), which turned it **green** and **promoted it
  to a required CI gate** (`mirror-parity`, under `ci-gate`, FE path filter).

## Addendum (2026-07-21) — the persisted render-log + fold-deferral (issue #1728)

> **Scope note:** the ADR body above is about the **live-stream** render path (F5, two-window
> mirror parity — a purely in-flight-turn concern). This addendum is about the **persisted**
> render log one layer down — the durable row list a session's live stream and its `/api/history`
> reload both ultimately read back from — plus a **non-degradation (mandate #4) tail** the
> reconciliation/BB-Nerd audits (T2/T3 + F5/F6) found riding on top of it: a cancelled generation
> left an empty durable row, "Try again" appended a second row instead of superseding, and BOTH
> takes folded into the hidden relationship/soul layer — sometimes with the SUPERSEDED take's
> (fabricated) content surviving. Source: `Psychout-Media/orwell#1728`.

### D1 — the persisted render log is id-keyed, single-mutator, supersede-by-id

**Decision (shipped, PR #1751, then completed here):**

1. **One append-only, server-`seq`-ordered assistant-row list per session is the single source of
   truth.** `core.session_manager.SessionManager` + the DB `ChatMessage.seq` ordering ARE that
   log — both the live stream (which stamps each persisted row's real DB id onto its bubble,
   `dataset.dbId` in `frontend/static/js/chat.js`) and a reload (`GET /api/history/{id}`) read the
   same rows in the same order. There is no second, DOM-index-only source of row identity.
2. **Cancel = discard.** `_renderCancelledBubble` (`frontend/static/js/chat.js`) never calls
   `inject_messages` for a stopped/cancelled generation — a cancelled take leaves **zero** durable
   rows (kills T2 — the old `stopped+cancelled, len=0` persisted row).
3. **Regenerate = supersede by id, never append.** `regenerateFrom`
   (`frontend/static/js/chatMessageActions.js`) resolves the row to discard from the AI bubble's
   OWN stamped DB id (`truncate_from_id`), not a DOM-index guess that can drift from the true row
   count whenever a hidden/system row persists without a rendered bubble (the root cause of T3's
   "two near-identical rows"). `POST /api/session/{id}/truncate`
   (`routes/history_routes.py::truncate_session`) resolves the exact `keep_count` from the
   server's own `seq` order (`SessionManager.keep_count_before_message`) and 404s a stale/unknown
   id rather than guessing — and the client checks that response status BEFORE mutating the DOM or
   resubmitting, so a failed truncate can never leave a duplicate row behind.
4. **FE tier only.** None of the above touches `src/` (the engine) — narration rows are not, and
   never become, engine/Vault state (ADR 0003).

Live == reload by construction for a regenerated turn: both render the same server-`seq`-ordered,
id-keyed row list, and superseded rows are gone from that list, not merely hidden client-side.

### B2 — fold integrity: defer-fold-to-settle (chosen primary; compensating-retract documented, not built)

**The problem this closes.** Even with D1 shipped, the *consequence* layer had its own copy of the
same defect: the 0055 `_auto_record_scene` belt (`frontend/src/agent_loop.py`) folded a scene's
hidden impact into the relationship/soul layer **immediately**, mid-stream, per take. A "Try
again" produces a brand-new take with its OWN extraction+fold call — but the first take's fold had
already committed and cannot be un-narrated. Every regenerate **permanently double-folded** the
hidden layer (F5), and because the surviving fold was picked independently of which take actually
survived, its content could belong to neither take as narrated (F6 — a fabricated/distorted fold).

**Decision — DEFER-FOLD-TO-SETTLE is the primary mechanism (owner ruling, issue #1728).** A
scene's fold is no longer committed at proposal time. `frontend/src/fold_ledger.py` is a small,
Vault-free, in-memory, per-`(owner, session)` **bounded FIFO queue** (mirroring the established
`routes/chat_helpers.py` `_DEFERRED_FOLDS`/`_LAST_BEAT_SEQ` pattern for exactly this class of
short-lived FE bookkeeping — max depth 8, oldest-drop-with-a-warning past that):

- `_auto_record_scene` validates the extraction exactly as before (the OOC/machinery gate, the
  engine-whereabouts witness-set intersection, the `withIds` roster normalization — #1729/#1730/
  #1734, unchanged) and then **appends** the payload to the queue instead of calling
  `recordInteraction`.
- The fold **settles** (the actual, CAS-guarded `recordInteraction` call) at the **start of the
  next turn** for that same session (`agent_loop._settle_pending_fold`, called before the new
  turn's round loop begins — never mid-stream), which **drains the whole queue oldest-first** —
  reaching a new turn is the proof the OLDEST staged take(s) were accepted, not regenerated.
- A **regenerate discards every entry ANCHORED to a row the truncate is removing** as part of the
  truncate it already performs (`routes/history_routes.py::truncate_session` calls
  `fold_ledger.discard_pending_fold(owner, session_id, keep_count)`) — see "Anchored, not just
  queued" below for why this is anchor-based rather than tail-only.
- **Idempotency (AC):** each entry's idempotency key is minted once, at stage time, and carried
  unchanged to its settle-time engine call (0065 Part B) — the engine dedups a repeated key, so a
  retried settle can never double-apply. A settle that fails on a transient error (not a stale-beat
  conflict, which `_backfill_with_cas`'s existing CON-11 deferred-retry queue already absorbs)
  **re-queues that entry at the FRONT and stops draining** — a newer entry must never settle ahead
  of an older one still retrying — rather than dropping anything (mandate #4 — a validated fold
  must never silently evaporate).

**Queue, not a single overwriting slot (PR #1825 Greptile P1 fix #1, post-merge).** The first cut
of this design used a single-slot "stage always overwrites" store. Greptile (confirmed by a T-Rex
repro) found a real evaporation hole in it: a transient settle failure re-stages the prior turn's
still-valid fold for retry, and if the NEW turn (which the settle deliberately let proceed —
fail-open) also reaches `_auto_record_scene`, a plain overwrite silently clobbers the
still-unsettled prior entry — exactly the mandate-#4 violation the module promised couldn't
happen. The fix is the FIFO queue described above: stage always appends, settle always drains
oldest-first and stops (rather than skips) on a failure.

**Anchored, not just queued (PR #1825 Greptile P1 fix #2 — the mirror-image bug, also T-Rex-
confirmed).** The queue fix's first version discarded only the TAIL (most-recently-staged) entry
on a truncate. That is wrong whenever `truncate_from_id` targets an OLDER assistant row: a
truncate is NEVER a single-row operation — it always removes that row AND every row after it — so
an older-row truncate (an edit/resend of an earlier turn) can wipe out a LATER take's row too, but
a tail-only discard left that later take's queued fold sitting in the ledger. It would settle
later as a PHANTOM hidden-layer fold for content the render log no longer contains — reintroducing
the exact F5 corruption this whole feature exists to prevent. The fix anchors every staged entry
to the real, persisted row it belongs to:

- `frontend/src/fold_ledger.py`'s `attach_row_anchor` is called once per turn, from
  `routes/chat_routes.py`, right after the route persists that turn's assistant reply and gets
  back its real DB id — the SAME `dataset.dbId` seam #1751 already stamps client-side. It anchors
  the tail entry with the row's raw DB id — but ONLY if the tail is still unanchored, so an older,
  re-queued turn's entry is never relabeled with a newer turn's row.
- `discard_pending_fold(owner, session, keep_count)` resolves every anchored entry's CURRENT
  `seq`-order position in ONE fresh query, run at the exact moment of the truncate against the
  CURRENT row set, and discards every entry whose row no longer resolves at all OR whose resolved
  position is `>= keep_count` — the full set of rows the truncate is about to remove — not just
  the newest. Entries resolving below `keep_count` (an older, already-accepted turn's re-queued
  fold) survive.
- **Fail-safe, deliberately asymmetric:** an entry whose anchor is still `None` (the narrow gap
  between staging — mid-generation, before the row exists — and the persist-time attach), OR whose
  anchored row id no longer resolves to any row at all, is ALWAYS discarded on a truncate,
  regardless of `keep_count`. A lost validated fold is a bounded mandate-#4 sadness; a phantom fold
  surviving into the hidden layer is the corruption this whole feature exists to prevent, and the
  two risks are not symmetric — uncertainty always resolves toward "never fold."
- **Settle's own last-line belt (`entry_exists_at_settle`, item 4)** is the intentional mirror: a
  plain SELECT-by-id — the row either exists or it doesn't, no positional arithmetic anywhere —
  defense-in-depth against a non-truncate deletion path (`edit-message`/`delete-messages`/
  `merge-last-assistant`) that bypassed `discard_pending_fold` entirely. A vanished-row entry is
  dropped (warned, never re-queued — nothing to retry). A MISSING anchor at settle time, unlike at
  truncate time, is treated as "no evidence either way" and settles normally — settle isn't
  reacting to an active delete event, so there is no matching urgency to assume the worst, and
  discarding every never-anchored entry on principle would silently regress ordinary turns (the
  attach step runs synchronously within the same request that staged the fold, so by the time the
  NEXT turn's settle runs, a real anchor is expected to already be there).

**The anchor is the row's IMMUTABLE DB id, never a derived position (PR #1825 Greptile P1 fix #3
— the SAME class of bug recurring one layer down, also T-Rex-confirmed).** Fix #2's first cut
anchored to the row's `seq`-order POSITION, captured once at attach time, and settle's existence
check compared it against a live row COUNT. Positions are unstable under deletion: delete an
EARLIER row via a non-truncate path and every LATER row's true position shifts left by one, but an
entry's stored position does not — so `position < current_count` can go on reading "still there"
for a row that is now gone (a 3-row session, an entry anchored at position 1, the row at position
0 deleted → count drops to 2, and `1 < 2` stays true even though a DIFFERENT row — the one that
shifted down — now occupies position 1). The fix removes positional arithmetic from the anchor
entirely:

- **`row_anchor` is now the row's own DB id string**, stored verbatim by `attach_row_anchor` (no
  DB round trip needed at attach time — the id was just handed back by the very call that created
  the row) and never converted to a position that could later go stale.
- **`entry_exists_at_settle` is a plain SELECT-by-id** — existence is a yes/no fact about a
  specific immutable row, immune to anything shifting around it.
- **`discard_pending_fold` resolves positions FRESH, every call**, against the row set as it
  stands at that exact instant (the same read `keep_count` itself came from, so the two can never
  desync) — never a cached/stale position from an earlier point in time.

**Id-ordering verification (required before trusting ANY id-based comparison).**
`core/database.py`'s `ChatMessage.id` is declared `Column(String, primary_key=True, index=True)`
("String to support UUIDs" per its own comment), and every place a row id is minted
(`core/session_manager.py`, several call sites) does so via `str(uuid.uuid4())` — a random UUID4,
**not** an autoincrement integer. Raw id comparison therefore encodes **no** session order
whatsoever; this is exactly why `discard_pending_fold` never compares ids directly and instead
resolves each anchored id's CURRENT position through the authoritative `seq` column (the same
column `SessionManager.keep_count_before_message` orders by) in a fresh query at truncate time,
while `entry_exists_at_settle` only ever needs a yes/no existence check (order-independent by
construction) and so is safe with the raw id as-is.

**SINGLE CUSTODY — an anchored fold lives in exactly ONE queue (PR #1825 Greptile P1 fix #4, the
custody leak, T-Rex-confirmed).** `agent_loop._backfill_with_cas` (unrelated to this feature,
pre-existing) has its own opportunistic retry queue for fold-bearing back-fills —
`routes/chat_helpers.py`'s `_DEFERRED_FOLDS` (CON-11): on a SECOND consecutive stale-beat 409, a
call made with `defer_fold=True` self-enqueues there instead of dropping the fold. That queue is
the right safety net for belts with no anchored ledger of their own (`makeDeal`/`confide`/
`exposeSecret`/`tradeSecret`, and the `session_id=None` faithfulness path) — but it is keyed ONLY
by owner, with no session_id/row_anchor at all. The bug: `_settle_pending_fold` was calling
`_backfill_with_cas` with `defer_fold=True` too, so a double stale-beat at settle time handed the
fold to that un-anchored queue — where a later truncate on the anchored session couldn't see it.
It would drain later, opportunistically, on the owner's NEXT unrelated back-fill call, and fold
content the render log no longer contained: a phantom fold via a side door the anchor-aware
truncate/settle checks never look at.

**The ruling: an anchored entry lives in EXACTLY ONE queue — `fold_ledger`'s own — from staging
until it commits or is discarded; it must NEVER migrate to `_DEFERRED_FOLDS`.** The fix is
`_settle_pending_fold` calling `_backfill_with_cas` with `defer_fold=False` — deliberately the ONE
fold-bearing call site in the file that does not pass `defer_fold=True`. With `defer_fold=False`
a double stale-beat reconciles and returns `None` without enqueuing anywhere (the identical shape
the pre-existing positional `moveTo` belt already relies on), and the settle loop re-queues the
entry at the front of the anchored ledger instead — the retry horizon never leaves the
anchor-aware machinery. **No remaining escape path exists:** `chat_helpers._defer_fold` (the only
function that ever writes to `_DEFERRED_FOLDS`) has exactly one call site in the whole codebase,
gated on `defer_fold`, inside `_backfill_with_cas` itself — so `defer_fold=False` structurally and
completely closes the leak; a belt-and-suspenders "carry session_id/row_anchor into the deferred
queue" mechanism was considered and is NOT needed. Every OTHER fold-bearing `_backfill_with_cas`
call site keeps `defer_fold=True` unchanged (byte-identical CON-11 behavior — proved by the full
`tests/test_0065_backfill_cas.py` suite staying green) since they have no ledger to fall back on.

**Discard must be a CONSEQUENCE of a truncate, never of an attempted one (PR #1825 Greptile P1
fix #5, T-Rex-confirmed).** `SessionManager.truncate_messages` refuses a negative `keep_count`
(returns `False`, deletes nothing), but `routes/history_routes.py::truncate_session` was calling
`fold_ledger.discard_pending_fold` regardless of that result — every resolved anchor position
trivially satisfies `pos < <negative number>` as false, so the fail-safe read every entry as "at
or past the cutoff" and emptied the ledger while every render row survived: an already-accepted
turn permanently lost its staged hidden consequence on a malformed request alone. Fixed at both
layers: the route now rejects `keep_count < 0` with HTTP 400 before touching anything, AND
`discard_pending_fold` is called only inside `if result:` — covering that case and any other
False-return path (an internal DB hiccup, etc.) uniformly.

**The compensating-retract fallback — documented, deliberately NOT built (T9 doctrine).** The
issue specs a fallback for a seam where deferral proves infeasible: commit immediately, then issue
an explicit "un-fold" if the take turns out superseded. No such seam exists on this build's
surface — staging is a plain in-process dict write that happens strictly before the engine is ever
touched, so there is nothing for deferral to fail past. Per the T9 doctrine ("if you implement
deferral, note the retract design as the designated fallback, don't build both"), the shape is
recorded in `src/fold_ledger.py`'s module docstring: `recordInteraction` would grow an explicit
`retract` verb keyed by the original `idempotencyKey`, resolved to the exact prior fold and
reversed via the SAME bounded/seeded magnitude math applied forward (never a raw-number rollback
the FE could game). Build it only if a future seam genuinely forces committing before a take's
fate is known.

**Boundaries preserved:** the engine's fold **magnitude** is still entirely engine-decided at
settle time — nothing about *what* gets validated or *how much* it moves changed, only *when* the
already-validated call reaches `recordInteraction` — so `tests/unit/expressiveNonCollapse.test.ts`
+ `frontend/tests/test_expressive_non_collapse.py` (creative prose stays un-normalized) and the
belt-fire telemetry contract (`frontend/tests/test_belt_telemetry.py` — a fire still means an
applied/guaranteed-to-apply correction, never a bare attempt) both stay green unchanged.

**Tests:** `frontend/tests/test_1728_1729_1730_1734_recording_render_integrity.py` — the D1 id-
keyed-truncate + cancel-discard source pins (already landed with PR #1751) plus the B2 section
added here, in two tiers: (a) ledger-mechanics tests via a stubbed `_auto_record_scene` driver
(stage-not-commit, settle-drains-and-commits, idempotency-key reuse, re-queue-on-transient-
failure, the `session_id=None` 0081 faithfulness-retro-adopt immediate-commit fallback,
cross-session isolation, the `_MAX_QUEUE_LEN` bound dropping the oldest entry with a warning, and
the PR #1825 fix-#1 case — a settle failure followed by a new-turn stage settles BOTH folds in
order on the next successful settle, each with its own idempotency key); (b) anchor-precise tests
via a real `SessionManager` + persisted rows mirroring the production stage→persist→attach→
truncate sequence, proving PR #1825 fix #2 — the T-Rex repro (truncating an OLDER row discards
BOTH its own and a later take's queued fold), the mirror check (truncating the NEWEST row only
leaves an older re-queued fold to survive and settle), a missing-anchor entry discarded on
truncate with a warning, and settle's own last-line belt dropping (never re-queuing) an anchored
entry whose row was removed by a non-truncate path — plus source pins for the truncate route's
anchor-aware discard call, the chat-routes persist-time attach wiring, settle sitting before the
round loop starts, and settle's row-existence check — plus the PR #1825 fix-#3 case: 3 rows, a
fold anchored to the MIDDLE row, that row deleted via a non-truncate path while the row before and
after it survive (the row after shifts down a position) — settle drops the entry via the id-based
existence check rather than being fooled by the shifted position, and nothing folds — plus the PR
#1825 fix-#4 (single-custody) case: stage an anchored fold, force a double stale-beat at settle
(the exact shape that used to self-enqueue onto `_DEFERRED_FOLDS`), truncate the row BEFORE any
retry drains, then drain BOTH queues and prove `recordInteraction` is never called for the
truncated content, plus a source pin that the settle path is the one fold-bearing
`_backfill_with_cas` call site that stays `defer_fold=False`. `tests/test_0065_backfill_cas.py`
(unchanged) stays green in full, proving the pre-existing CON-11 belt users' behavior is
byte-identical — plus the PR #1825 fix-#5 cases: a negative `keep_count` over real HTTP rejected
with 400, zero rows deleted, the ledger untouched, and the staged fold still settling afterward;
a mocked False return from `truncate_messages` also leaving the ledger untouched; and source pins
for the ordering (guard before the truncate call, discard gated on `if result:`).

## Traceability

- Source: the streaming-text-parity investigation, 2026-06-27 (branch `claude/streaming-text-parity-*`).
- Root-causes: ship-gate **F5** (`docs/audits/2026-06-27-ship-gate.md`) — realtime two-window mirror
  parity, the #1 release blocker.
- Completes: ADR [0012](./0012-two-window-lockstep-mirror.md) §3.3 (the live-stream mirror) +
  refactor-roadmap [**R2**](../REFACTOR-ROADMAP.md) (collapse the duplicated live-vs-reload render paths).
- Builds on: ADR [0008](./0008-chat-conversation-consistency.md) (the settled-log `seq` / reconcile-by-id /
  completion-broadcast model — the **delivery** half that is sound and stays).
- Bounded by: the Vault Wall (mandate #2) and cross-user isolation (0021) — both unchanged; ADR 0003; the
  reasoning-scrub render contract (the `roundReplyText`/`roundReasoningText` channel split).
- **Addendum (2026-07-21) source:** `Psychout-Media/orwell#1728` — the persisted render-log
  supersede-by-id/cancel-discard half (D1, PR #1751) + the defer-fold-to-settle consequence half
  (B2) closing the multi-audit BB-Nerd F5/F6 = reconciliation T2/T3 finding. See
  `frontend/src/fold_ledger.py`, `agent_loop._settle_pending_fold`, and
  `frontend/tests/test_1728_1729_1730_1734_recording_render_integrity.py`.
- Executable backing: `docs/audits/playtest-harness/mirror_live_parity.mjs` (+ `run_mirror_gate.sh`) and
  `frontend/tests/test_0012_mirror.py` (the former `xfail` tripwire, now passing outright); harness §10 of
  `docs/audits/playtest-harness/README.md`.
