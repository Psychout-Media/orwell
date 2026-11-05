# REFACTOR-ROADMAP.md — Orwell pre-launch refactor roadmap

**Status:** Phase 4 deliverable of the 2026-06-21 pre-launch E2E playtest/refactor audit. Synthesized
from the Phase-0.5 gap analysis (`docs/ARCHITECTURE-AS-IS.md`) and the E2E findings (`AUDIT-LOG.md`),
cross-referenced to the live ADRs. **This is advice, not applied code.** Each entry is mechanism-first
and requirement-grounded — *no requirement → not in the list.* The lead owns this single document.

> **Headline:** the audit found the **engine + the engine-backed surfaces are launch-ready** (Vault
> Wall holds, anti-sycophancy holds, the live loop is engine-grounded, the retrospective accumulates
> 2037 hidden events, casting works on both platforms, concurrency of *shared game state* converges).
> There is **exactly one launch-blocking architectural defect** — the FE chat-conversation divergence
> (the "garbage" bug) — and it is already root-caused and owned (**ADR 0008**). Everything else here is
> **post-launch**, sequenced highest-leverage / lowest-risk first.

## How to read an entry
**Requirement / failure mode · Current (steelmanned) · Target · Blast radius · Risk · Effort ·
Dependencies/sequencing · Verification.** Severity per the brief: **[LAUNCH-BLOCKING]** (only those that
*cause* a launch-blocking bug — these route back into the Phase-3 gated remediation) vs **[POST-LAUNCH]**.

> **GitHub issue tracking (added 2026-06-23; updated 2026-07-21).** The highest-value post-launch latent,
> **R1c / A-S3** (a stale-409 dropping a scene's only consequence fold), was tracked as
> [#591](https://github.com/kevinhirsch/orwell/issues/591) and is now **RESOLVED** — closed across #591 /
> CON-11 / A10-#1305 / #1537 / #1659-R3 / #1725-C1 and **#1731-C2** (bounded deferred-fold retry that
> fail-closes + surfaces a genuine loss). See R1c below. The remaining R-items here stay roadmap-only
> until scheduled; file them as `type:enhancement` + `post-launch` issues when picked up. This document
> remains the mechanism-first design record.

---

## Executive summary
- **Launch-blocking (1):** **R0 — ADR 0008** the chat-conversation consistency refactor. The sole
  architectural change that *causes* a launch-blocking bug (concurrent-tab chat divergence, 10/10,
  accumulating — "no tolerance"). Root-caused + fix-specified + owned; route into pre-launch remediation.
- **Post-launch, highest leverage:** **R1** consistency-contract hardening (stale-beat structured body,
  auto-derived `gamechanged` set, stale-409 fold preservation) · **R2** collapse the duplicated
  live-vs-reload chat render paths · **R3** decompose the `chat.js` god-object + add the missing
  guardrail-lattice + FE-write-back test seams.
- **Post-launch, medium:** ~~**R4** movement/location grounding (ADR 0009)~~ **(DONE, #1415)** · ~~**R5** per-user client-storage
  isolation guard~~ **(DONE, #1416)** · **R6** the failure-mode UX (system-error notice, truncation affordance) · **R7** the
  polish bundle.

---

## R0 — Chat-conversation consistency (ADR 0008) **[LAUNCH-BLOCKING]**
- **Requirement / failure mode:** ADR 0003 — the conversation IS the game; it must be consistent across
  a user's tabs/devices. **S3-RACE:** two tabs diverge in their rendered conversation under
  concurrent/active writes, **10/10**, accumulating; engine perfectly consistent; reload reconciles
  (live FE-replication failure). PO: "no tolerance."
- **Current (steelmanned):** the FE chat log is FE-owned (session DB) + replicated over the 0064 SSE
  channel. It *intends* to be "a single authoritative server-ordered log every device renders from" — a
  sound model — but isn't built that way: no ordering key (`uuid4` + non-unique `timestamp`), an
  optimistic sender that never reconciles, and a `hasActiveStream` gate that drops the peer's reconcile
  signal. The engine half (0065 `beatSeq`) is already correct.
- **Target:** the id+`seq`-ordered authoritative log the code already claims — monotonic per-session
  `seq` (`UNIQUE(session_id, seq)`) under the existing `agent_runs` serialization; all render paths +
  `/api/history` order by `seq`; render-by-id + reconcile-not-replace; `{id,seq}` dedup replacing the
  suppression gate; a `message-added` completion broadcast; `resumeStream` attaches by run id.
- **Blast radius:** `core/database.py` (schema + migration), `session_manager.py` / `history_routes.py`
  (order-by), `chat.js` + `chatRenderer.js` (render/merge), `sessionSync.js` + `session_events.py`
  (dedup + broadcast), `chat_routes.py` (publish). **Engine untouched.** Vault Wall + cross-user
  isolation untouched (payloads stay ids/`seq`/types).
- **Risk:** medium — touches the chat render/sync core + a schema migration; mitigated by the contained
  scope and the binding test below. **Effort:** ~1 focused lane. **Dependencies:** none (engine ready).
- **Verification:** the permanent **two-tab concurrent-write parity gate** (the audit's looped harness
  distilled to a test) — both tabs converge byte-identically under concurrent writes, reload never
  *required* to converge. (My `parity_s3.mjs` two-window rig + ADR 0008's repro are the seed.)

---

## R1 — Consistency-contract hardening (post-ADR-0008) **[POST-LAUNCH · Wave 1]**
Three independent, low-risk fixes to the FE↔engine sync spine (audit A-S5 / A-S4-D2 / A-S3).
- **R1a — stale-beat reconcile on the STRUCTURED body, not the error string** (audit **A-S5**, highest).
  - *Requirement:* a wording drift in `StaleBeatError.message` must not silently turn reconcile into
    fail-closed. *Current:* the FE parses `"stale write refused"` + regex `"(now N)"` from the message
    and **discards** the engine's `{code:"stale-beat",beatSeq,board}` body (`chat_helpers.py:405/474`,
    `orwell_engine.py` reads only `.error`). *Target:* consume the structured body. *Blast radius:* the
    thin client + `_handle_stale_beat`. *Risk:* low. *Effort:* small. *Verify:* a test that drifts the
    message wording and asserts reconcile (not fail-closed).
- **R1b — auto-derive the `orwell:gamechanged` dispatch set** (audit **A-S4/D2**).
  - *Requirement:* a new mutating tool must refresh HUDs by construction. *Current:* hand-coded
    tool-name array (`chat.js:2289`); `test_g15` only checks known seams. *Target:* derive the
    mutating-tool set from one shared registry (the same source `INFRA_LEVERS`/`PLAYER_TOOLS` use), so a
    new write-back can't silently leave HUDs stale. *Risk:* low. *Effort:* small. *Verify:* extend
    `test_g15` to assert every registry-mutating tool routes through the one dispatcher.
- **R1c — preserve a scene's consequence fold on a stale-409** (audit **A-S3**). **✅ DONE — closed by
    #591 / CON-11 / A10-#1305 / #1537 / #1659-R3 / #1725-C1, and #1731-C2 (this change).**
  - *Requirement (mandate #4):* no consequence fold silently dropped. *Was:* a stale-409 on
    `recordInteraction`/`makeDeal`/the trust levers was reconciled-and-**skipped**; the only recording of
    a scene could be lost. *Shipped:* every FE-issued fold-bearing back-fill routes through
    `_backfill_with_cas` (`src/agent_loop.py`), which RE-ATTEMPTS once against the refreshed `beatSeq` on a
    single stale-409 (#591) and DEFERS on a double-409 into a bounded per-owner queue (CON-11,
    `chat_helpers._defer_fold`/`_drain_deferred_folds`) rather than dropping it — each attempt threading ONE
    stable `idempotency_key` so the engine folds AT-MOST-ONCE (A10/#1305; the engine dedup is
    `tests/unit/recordInteractionIdempotency.test.ts` / `foldLeverIdempotency.test.ts`). C1 (#1725/#1753)
    made the engine report the fully-committed `beatSeq` so ordinary turns stop 409-ing spuriously.
    **C2 (#1731, this change)** bounded the opportunistic retry itself: after `_DEFERRED_FOLD_MAX_DRAINS`
    failed drains a genuinely un-committable fold is FAIL-CLOSED and SURFACED (a RED-eligible
    `sync:dropped-fold` health event + a ledger note via `note_stale_rejection(dropped_fold=True)`) rather
    than re-queued forever — so under sustained two-window concurrency a lost fold is ACCOUNTED, never
    silent, and the dropped-fold alarm stays a true positive. *Verify:* `frontend/tests/test_a10_fold_
    idempotency.py`, `test_1537_as3_floor_fold_retry.py`, and `test_1731_fold_preserving_retry.py`
    (exactly-once under a forced double stale-409; a fold that ultimately cannot commit is surfaced; the
    alarm stays silent when a deferred fold lands late).

## R2 — Collapse the duplicated live-vs-reload chat render paths **[POST-LAUNCH · Wave 2]**
- *Requirement / failure mode:* one render path, so live == reload by construction. *Current
  (steelmanned):* `chat.js` (live SSE) and `chatRenderer.js:1898` (reload, 517 LOC) are **two render
  engines** re-implementing the same concerns (reply/reasoning split, `processWithThinking`, tool-beat
  chips, `orwellBeatOutcome`, OOC asides, role relabel); in-file comments document real drift
  regressions ("leaking all of it on every re-open", "a stack of identical beat rows"). `orwellToolBeats`
  exists *solely* to stop one slice of this drift. *Target:* a single shared render module both paths
  call (a pure `renderMessage(msg) → DOM`), with live/reload differing only in *source* (stream vs
  history). *Blast radius:* `chat.js`, `chatRenderer.js`, the shared render helpers. *Risk:* medium
  (high-traffic code). *Effort:* 1 lane. *Dependencies:* sequence **after** R0 (ADR 0008 already touches
  the render/merge path — do them together or R0 first). *Verify:* a golden-render test asserting live
  and reload produce identical DOM for the same message set (incl. decision card, which today survives
  reload only via the out-of-band `rearmFromStatus`).

## R3 — Decompose the chat.js god-object + close the test-seam gaps **[POST-LAUNCH · Wave 2-3]**
- *Requirement:* testable seams; the densest, least-tested logic must be coverable. *Current:* `chat.js`
  ~5.3k LOC with a ~2.9k-LOC SSE loop mixing submit/stream-state-machine/doc-fence/TTS/background-streams/
  history-editing/the game-mutation seam; the **guardrail gating lattice** (`agent_loop.py:3395+` —
  `_want_advance`/`_record`/`_move`/`_approach` × lull/stale/runway/pending) is intricate, stateful, and
  has no confirmed unit harness; the **FE-write-back boundary** is protected only by per-tool
  `callTool`-dispatch tests (a new write-back is dead-at-runtime until one is added). *Target:* extract
  the SSE state machine into a tested module; add a gating-lattice unit harness over the
  lull/stale/runway/pending permutation matrix; add a generic FE-write-back boundary test. *Blast
  radius:* `chat.js`, `agent_loop.py`, new tests. *Risk:* medium. *Effort:* 1-2 lanes. *Verify:* the new
  unit harnesses green + no behavior change (golden transcripts). *(settings.js 290KB / slashCommands.js
  270KB are workspace-inherited outliers — split only if game-build-relevant.)*

### R3 decomposition plan (A61, written 2026-11-05 from a line-level read of `frontend/static/js/chat.js`, 6186 lines on main)

**Where the weight is.** One exported function, `handleChatSubmit` (L627-L4399, ~3.8k lines), holds the whole turn. Everything else in the file is helpers and three resume/recover siblings (`_trySelfResume` L4664, `_tryAutoRecover` L4800, `_renderLiveStream` L4984) plus the second and third copies of the SSE event switch (L4725 mirror/resume, L5241 background stream).

**Responsibilities inside `handleChatSubmit`** (line anchors are today's):

| # | Responsibility | Anchor | Pure enough to extract? |
|---|---|---|---|
| 1 | Submit gate: re-click guard, setup-mode, slash commands, OOBE image gate, API-key guard | L637-L1060 | Yes (decisions are pure on (text, state)); DOM calls stay |
| 2 | Outbox: queue-while-streaming, offline-to-outbox, FIFO across reload, drain | L637-L700, L6050-L6152 (+ sessionStorage keys) | Yes, already conceptually a queue; only `sessionStorage` + `dispatch` are effects |
| 3 | Optimistic bubble (BUG 1: never eat a message) | L930-L1060 | DOM-only; stays |
| 4 | Request build + fetch of `/api/chat_stream` | L1718 | Thin |
| 5 | **SSE state machine**: line parsing, per-round buffers (`roundReplyText` / `roundReasoningText`), the ~35-way `json.type` switch | L1802-L3720 | **First extraction** (see below) |
| 6 | Tool-result seam (tool_start/progress/output; `orwellGameChanged` dispatch; doc-fence) | L2945-L3400 | Mixed: the mutation-tool -> `orwellGameChanged` rule is pure (a table) |
| 7 | Doc fence / doc_stream_* | L1876, L3361-L3400 | Pure parser + DOM |
| 8 | Research/web-sources/rag panels | L2502-L2860 | DOM-only; independent, can stay or move later |
| 9 | Stall/idle guard, auto-recover, self-resume, retry bubbles | L169, L4664-L4890 | Mostly pure decisions (`_isRecoverableStreamErr`) |
| 10 | Settle: persistence of `dataset.raw`, TTS hand-off, background-stream bookkeeping, error bubbles | L4150-L4460 | Mixed |
| 11 | History editing (edit / regenerate / delete) | L6109 region | Separate from the turn; later |

**The duplication is the real risk, not the size.** The same `json.type` switch exists three times (live L2190-L3720, resume/mirror L4725, background L5241) with different subsets. ADR 0015 already collapsed the render paths; the event *dispatch* is the remaining divergence, and it is where every mirror-parity bug (F5, S17, A57) has lived.

**First extractable module: `chatStreamMachine.js`** (pure, no DOM): `reduce(state, event) -> { state, effects[] }` where `state` = the per-round buffers + flags (`sawDone`, `usedTools`, `cancelled`, `roundText`, `roundReplyText`, `roundReasoningText`, pending run id) and `effects` = a closed list the shell interprets (`paintDelta`, `paintReasoning`, `toolBeat`, `docOpen`, `gameChanged(reason)`, `settle`, `error`). The shell keeps all DOM/IO. Why this one first: (a) it is the unit that decides what reaches the body vs the Thinking accordion, which the render contract pins; (b) all three switches can call the same reducer, removing the divergence; (c) it is testable under node exactly the way `_displayNames` and the A51 chip helper already are (extract + run), no browser.

**Order (each step ships alone, behavior-neutral, behind the equivalence check):**
1. Extract the *table* of mutation tools -> `orwellGameChanged` reason (responsibility 6). Smallest; also the natural home for A56 (derive from mutation metadata).
2. Extract `chatStreamMachine.reduce` for the reply/reasoning split only (responsibility 5, buffers + `thinking` falsy/truthy). This is A59's helper too (`splitReplyReasoning`), so A59 is step 2a.
3. Move the rest of the switch cases one family at a time (tools, docs, research, truncation/fallback), each with its recorded stream.
4. Point the resume (L4725) and background (L5241) loops at the same reducer.
5. Outbox as its own module (responsibility 2); then the submit gate (1).

**Before/after equivalence check (the golden stream).** Record a corpus of raw SSE bodies (the stub narrator in `test_m0_3_midgen_join.py` can script every event type; `test_a58_golden_render_live_vs_reload.py` already pins the rendered DOM live vs reload). The equivalence test replays each recorded stream through (a) the old inline path and (b) the extracted reducer + shell, and asserts: identical final `dataset.raw`, identical rendered body HTML, identical Thinking-accordion HTML, identical ordered list of `orwellGameChanged` calls, identical persisted message. The A58 golden render test is the DOM half; the reducer's effect list is the new half. A step is done only when both halves are green on every recorded stream and the full FE suite (including the source-pinned g15 / reasoning-scrub / render-contract gates, which will need their anchors moved with the code) passes.

**Do-not-do list.** Do not re-enable the stall watchdog (`_startStallWatchdog`, deliberately disabled). Do not merge the reply and reasoning buffers into one and re-split by regex. Do not add a second `orwell:gamechanged` dispatcher (g15). Do not change event semantics while moving them: the extraction PRs must show a zero diff in the golden outputs.

**Gate to start step 2:** A58 (golden render) and A60 (gating lattice) merged, A57c landed (it changes the error path the reducer must model). Status of the extraction itself: **not started; plan only** (the DoR for R3).

## R4 — Location/movement source-of-truth (ADR 0009) **[DONE — #1415]**
- *Requirement:* "people make sense — one place at a time"; narration must ground to engine whereabouts.
  *Was:* movement grounding documented as imperfect (the L21/L24 family; ADR 0009 root-causes it + records
  the fold-first PO ruling). *Verified (#1415):* ADR 0009 is fully built (D1 freeze · D2 record-move + FE
  belt · D3 barrier directive + pre-emission guard · D4 dual-map) and its gate is green. The one authority
  is `GameSessionAdapter.whereabouts()` — a Vault-free projection whose every name routes through the
  canonical `nameOf` (the roster), read by BOTH the narrator's moment-prompt WHERE-YOU-ARE block and "The
  House" gadget (parity by construction). A new gate, `tests/unit/locationGrounding0009.test.ts`, pins the
  four grounding guarantees under a **movement stress run** (many seeded ticks interleaved with recorded
  narrated moves): every placed houseguest is roster-named (no drift), living (never evicted/unknown), and
  in exactly one place; a recorded narrated move surfaces the same roster name to both the projection and
  the moment prompt.
- **F-S4-F (resume name-drift) — CONFIRMED not a structural degradation.** Two facts close it: (a) the
  resumable-stream endpoint `GET /api/chat/resume/{id}` is a PURE REPLAY (`agent_runs.subscribe` — no agent
  loop, no framing, no model call), so it cannot INTRODUCE a name the original run did not emit; (b) every
  model-invoking turn — including the fresh-context RE-ENTRY turn a reopened session takes — is framed
  through `apply_game_framing` → `get_moment_prompt`, whose prompt always carries the full roster
  (`buildSystemPrompt` always appends `renderGameContext`). So a resumed session RE-GROUNDS names from
  engine truth; grounding does not thin on resume. Any residual "Lake Fleming" slip is model stochasticity,
  not a resume-path defect. Pinned by `tests/unit/locationGrounding0009.test.ts` (re-entry moment carries
  the whole roster + the single-source-of-truth anchor) and `frontend/tests/test_fs4f_resume_name_grounding.py`
  (resume is a pure replay; re-entry re-grounds). *No source/prompt change ⇒ the golden fixture is unaffected.*

## R5 — Per-user client-storage isolation guard **[DONE — #1416]**
- *Requirement (0021):* client-layer per-user isolation. *Was (audit A-data-user):* every per-user
  localStorage key derived from `(document.body.dataset.user) || ""` — if `data-user` was ever absent,
  all keys collapsed to a shared empty namespace (layout/persistence bleed; not the Vault).
- **Shipped:** the single shared helper **`window.orwellUserKey(name)`** (`static/js/orwellUserKey.js`,
  loaded before the panels) returns a per-user key ONLY when `data-user` is a non-empty string, else
  **null → callers skip persistence** (write NOTHING) rather than share the empty-user namespace. Every
  non-fenced per-user localStorage keying site migrated onto it and null-guarded: `orwellGadget`,
  `orwellGadgetRail`, `orwellNotice`, `orwellChatHint`, `orwellPremiereTutorial`, `orwellSlots`
  (also fixes a latent module-load stale-`_user` cache), `orwellStatusPanel`. Per-tab `sessionStorage`
  (send-outbox, composer draft) is out of scope by ADR 0008/0012. Fenced files left as follow-ups:
  `orwellWindow.js` (3 sites: `orwell-win-parked:`, `orwell-*-docked:`, `orwell-slot-offset:` removal)
  and `orwellCastPin.js` (`orwell-cast-pinned:`). *Verify:* `frontend/tests/test_r5_user_storage_guard.py`
  (structural + a Node proof that an absent `data-user` writes NO shared-namespace key).
- **A-settingsModule:** already dead-code-removed earlier (FEJS-2) — `orwellOnboarding.js` `openSettings()`
  drops the never-assigned `window.settingsModule.open()` fallback; no `window.settingsModule` remains.

## R6 — Failure-mode UX **[MOSTLY DONE - client side shipped; server-side leg open as A57c]**
*Inventory written 2026-11-05 (A57 DoR), from the code and tests on main; this replaces the original "current" text, which predates the fixes.*

| Failure state | UX today | Evidence | Gap |
|---|---|---|---|
| Upstream model error mid-stream (typed `data: {"error": ...}` / `event: error`) | A system-styled notice (`--color-error`, italic) with the canonical interruption line in the game build, the raw text outside it; not voiced as the narrator | `chat.js` error branch (B11 / FEPY-1, the I9 fix); `test_fault_probe_no_done.py::test_stream_error_notice_is_system_channel_with_no_gm_attribution` | none client-side |
| Stream closed with no `[DONE]` (truncation) | `_streamSawDone` latch throws "Stream closed before completion"; the failure routes to `_renderStreamDropRetry` (a labelled **Retry** control), not a GM bubble | `test_fault_probe_no_done.py` (latch, throw, routing to the retry control) | none client-side |
| Empty turn after a drop (nothing visible) | The hidden holder is shown again with the Retry control (BUG 2) | `_renderStreamDropRetry` | none |
| Auto-recover / self-resume of a recoverable drop | `_tryAutoRecover` / `_trySelfResume` | `chat.js` ~L4664-L4890 | none |
| Offline send | Straight to the durable outbox, drained in order on reconnect (#891) | outbox pins in `test_885*`/`test_891*` family | none |
| Stale-beat 409 | Reconciled silently through the desync mechanism (no error shown) | `_handle_stale_beat`, `test_a55_stale_beat_structured.py` | a player never learns a write was rejected; acceptable (the board is re-read) |
| **Upstream ends cleanly after real text, no tool call, no `[DONE]` semantics (a silent drop saved as a complete turn)** | The server saved the partial reply as a complete message | found by the A58/A57 exploration | **OPEN: A57c** (`overseer-a/a57b-drop-dom-proof`): `llm_core` emits `stream_dropped` and `chat_routes` saves nothing; lands after the playtest because it changes the error path |
| Engine unreachable / blank turn | The game-build interruption line; admin RED list | `docs/audits`, `/admin/status` | no distinct Retry on the engine-down banner (low) |

**Verify (original wording kept):** re-run `fault_probe.mjs`; assert a system-error element + a retry control and no GM-voiced error. The pytest half already exists (`test_fault_probe_no_done.py`); A57c adds the server-side half (`test_a57c_upstream_drop_not_a_complete_turn.py`).

## R7 — Polish bundle **[POST-LAUNCH · Wave 4]**
Contained, independent, mostly one-file (full list + evidence in `AUDIT-LOG.md`). **Issue #1418 pass
(2026-07-12, FE-safe-subset delegate):** the non-fenced FE subset was executed; the fenced/engine-
adjacent items are handed off. **2nd pass (2026-07-12, safe-remainder delegate):** the cast fast-poll
gate was confirmed + PINNED (`test_1418_r7_poll_gating.py`), the broad poller-coalescing recorded as
superseded by WS-default-on + g15, and F-S1-I/J/S4-A/S1-K re-verified as gated/resolved/deferred with
no product change. Status per sub-item below.

- ✅ **F-S1-H — DONE (#1418).** `theme.js`'s two cross-device prefs fetches (`GET /api/prefs/theme`,
  `GET /api/prefs/custom-themes`) fired pre-auth on `/login` (login_bg.js imports theme.js for the
  bundled perlin-flow wallpaper) → two 401 console lines per load. `_initWithSync` now early-returns on
  `/login` (`_onLoginPage()`) before both fetches; `initThemeUI()` still runs, so boot is otherwise
  unchanged and the login palette (localStorage-driven) is unaffected. **Verified:** a headless `/login`
  load + dynamic `theme.js` import fires **0** `/api/prefs/*` requests and **0** 4xx (was 401×1–2). FE
  suite 5032 passed; boot/browser smoke EXIT 0.
- ✅ **F-S2-B — DONE / already-resolved, VERIFIED (#1418).** Both console-404 sources are already fixed
  upstream: the inherited deep-research poller is game-build-gated (`chat.js checkPendingResearch` →
  early-return on `data-game-build`, #1035/F-8), and the finished-stream `stream_status` probe no longer
  404s — the route returns `{"status":"idle"}` (200) instead of 404 (`chat_routes.py` M1-8/audit A8). No
  edit needed; `boot_smoke`/`browser_smoke` are console-clean in the game build. (The deep-research
  poller lives in the FENCED `chat.js`; it was already fixed, so no fenced edit was required.)
- ✅ **F-S4-A — DONE / VERIFIED + PIN CONFIRMED (#1418, no change).** The L40 "everyone romanced everyone"
  saturation is already fixed sparsely: `src/engine/seededRelationships.ts` seeds ≤
  `DEFAULT_SHOWMANCE_BUDGET` (2) showmances/season, each slot only ~50% loaded (`SEED_LOAD_PROB = 0.5`)
  over DISTINCT houseguests — so 0–2 per season, never a dense set. The sparseness is **already pinned**
  by an existing engine gate, `tests/unit/seededRelationships.test.ts` ("stays within budget, over
  DISTINCT houseguests, across many seeds — the L40 saturation guard"), which asserts per-season budget
  ≤ 2 and, over 80 seeds, `everSeeded < 80 × (TIE_BUDGET + SHOWMANCE_BUDGET)` (far below "everyone
  paired"). No new test is warranted — the data lives ONLY in the fenced engine (no FE showmance
  table), so a fe-unit pin could not reach it, and the correct pin already exists. (Engine-fenced;
  read-only verification only.)
- ◻️ **F-S1-D — SCOPED SLICE TAKEN, broad refactor SUPERSEDED (#1418; 2nd pass 2026-07-12).** The **cast
  fast-poll cadences are already gated to a mounted/live cast surface** (verified + now PINNED):
  `orwellCast.js scheduleNextPoll()` early-returns unless `_open` (and drops the periodic timer entirely
  when `_wsActive()`), the `FAST_POLL_MS` cadence only applies to the open-panel roster poll while a run
  is in flight, and the deferred fetch re-checks `_open` before spending; `orwellHeadshot.js`'s 4s
  background re-check gates `route()` on `_win || box || _maybePregame`, so once the season is underway
  with the box unmounted each tick is an inert DOM read (no network). The new source-pinned gate
  **`frontend/tests/test_1418_r7_poll_gating.py`** (5 tests) locks both so a regression that lifts the
  fast cadence out of its mount/pre-game guard fails loudly. The 20s gate poll is fixed-cadence, not fast.
  **BROAD COALESCING DEFERRED — and now largely SUPERSEDED, not merely churny.** With **WS transport
  default-ON (#1357)** every `/state` poller cancels its periodic TIMER on `orwell:ws-active` and refreshes
  from the server `state`/`hud` push, and off-WS the **g15 `orwell:gamechanged`** seam (one debounced
  dispatcher, `platform.js`) drives an immediate refresh on every mutation — so on the real deploy the
  ~17 well-behaved pollers (each already bounded-exponential-backoff, `gamechanged`-driven, WS-timer-
  cancelling) are mostly quiescent already. The "~17 uncoordinated `/state` pollers behind one shared
  poller" rewrite is therefore a high-blast-radius (~15 files, several with source-pinned tests on the
  literal `/api/orwell/state` string — `test_c21_roster.py`, `test_c28_presence.py`,
  `test_m3_1_room_strip.py`), tiny-win refactor whose main benefit WS + g15 already delivers. Only the
  cited perf slice (cast fast-poll gate confirmation + pin) was taken; if ever revisited, do it as a
  dedicated short-TTL shared `/state` dedupe cache all panels route through while keeping the literal URL.
- ✅ **F-S1-J — IDENTIFIED / already-resolved, RE-VERIFIED (#1418; 2nd pass 2026-07-12).** The
  "username-field dot" was the **Remember-me checkbox** that used to overlay the username input
  (unlabelled 14×14 glyph); **S1-A already relocated it to a labelled `.remember-row`** (login.html,
  `min-height: 24px`, a visible `<label>` + custom checkbox) — the username field now has only its
  `<label>` and no overlaying glyph. Confirmed: no residual unlabelled dot near the username/header to
  label. No change.
- ⏸️ **F-S1-I — DEFERRED, gating RE-VERIFIED (#1418; 2nd pass 2026-07-12).** Stripping the
  inherited-workspace DOM from the template is the **deep code-level prune that `game-trim.css`
  explicitly defers** ("a deeper code-level prune is a separate pass, to be verified against a running
  instance"). The *visible* workspace surface is **already game-build-gated, not merely dormant**:
  `game-trim.css` `display:none !important`-s every inherited workspace launcher under
  `body[data-game-build]` (the icon-rail `#rail-{research,gallery,notes,tasks,compare,cookbook,…}`, the
  sidebar `#tool-*-btn` list, `#chats-library-btn`, `#email-section`, the composer capability toggles,
  the dropped settings tabs), and the index.html welcome-tip copy swaps to BB copy under
  `data-game-build`; the residual workspace copy is hidden-not-rendered modals/indicators
  (`#workspace-indicator-btn` is inline `display:none` and never un-hidden in the game build). So the
  requested "remove OR game-build-gate" is satisfied at the *gated* level; only the DOM-removal prune
  remains, and it stays out of scope for a low-risk polish pass — pair it with the game-trim deep prune.
- ✅ **F-S1-E — DONE (#1418, post-#736 style.css unfenced).** `.model-picker-btn` was `height: 21px`
  (below the WCAG 2.5.8 AA 24px target-size floor). Desktop base bumped to `height: 24px` (the glyph —
  11px label + 10px chevron — is unchanged and stays centred; only the hit/hover box grows 3px), and a
  coarse-pointer block `@media (hover: none) and (pointer: coarse) { .model-picker-btn { min-height: 44px;
  height: auto; } }` lifts it to the 44px touch floor, mirroring the `.copy-btn` / kit touch-target idiom
  (no width limit — so it also covers a wide touch device, where the picker *is* shown; on ≤768px the
  picker is `display:none` by design). **Verified (headless before→after, origin/main vs branch): desktop
  picker height 21px → 24px; touch 44px; composer textarea + send x/y/w unchanged (≤1px).** FE non-browser
  suite 5048 passed; `browser_smoke` EXIT 0.
- ⏸️ **F-S1-K — DEFERRED / FLAG (#1418).** The two homes are both off-limits or risky: `LEAK_RE` lives in
  the **fenced `scripts/browser_smoke.py`**, and the ancestor-descendant overlap classifier
  (`frontend/src/visual_geometry.py`) is now a **CI-gated harness** for 0113/0114
  (`visual_regression.py` / `theme_consistency.py`, with pinned `test_0113_*`/`test_0114_*`) — the
  requested "ancestor-descendant overlap exclusion" is in fact **already implemented** there (the
  `covered` classifier excludes ancestors/descendants). Not a safe polish-tooling edit.
- ➡️ **S4-2 — HAND OFF (engine-read).** `finaleView`/`recap` return a null winner post-finish because the
  winner is projected from `this.live.winner` in `src/adapters/engine/GameSessionAdapter.ts` (engine
  side); making the endgame projections carry it is an engine-read change, not a pure FE surface patch —
  the task's one flagged engine-adjacency. (`/status` already carries `finished+winner`; the FE recovers
  via the retrospective, so it stays non-blocking.)
- ➡️ **S2-1 — HAND OFF (casting-finalize framing).** A structural "Enter the house" affordance that
  finalizes casting when the engine status is `finalizable` is intrinsically tied to the fenced
  casting-finalize path (`createCharacter` finalize / `chat_helpers.py apply_game_framing`) — when in
  doubt, hand off.

---

## Sequencing (what unblocks what)
1. **Pre-launch:** **R0** (ADR 0008) — into the Phase-3 gated remediation. Nothing else blocks launch.
2. **Post-launch Wave 1:** **R1a/b/c** (independent, low-risk, high-leverage consistency hardening).
3. **Wave 2:** **R2** (render unification) — *after/with* R0 (shared render/merge surface), then **R3**
   (decompose + test seams) which is easier once R2 lands one render path.
4. **Wave 3:** ~~**R4** (ADR 0009)~~ **— R4 DONE (#1415)**, ~~**R5** (isolation guard)~~ **— R5 DONE (#1416)**.
5. **Wave 4:** **R6** (failure UX), **R7** (polish).

Dependency direction is already correct (engine imports nothing from the FE; Vault structurally walled)
— **no inversion to fix.** The roadmap is about FE-side cohesion + the one consistency refactor (R0).

## Close — review gate
**The launch-blocking few:** exactly **R0 (ADR 0008)** — already owned. **The post-launch many:** R1–R7,
sequenced above; do NOT execute pre-launch. **Ask:** fold R0 into the remaining pre-launch remediation
(it's ADR-owned — confirm you want this audit to track/verify it), or hand the whole roadmap off as-is?
