# Road-to-market backlog — waves M0–M4 (2026-07-07)

> **Status (reconciled 2026-07-13 — source-audited against `main`, supersedes the 2026-07-08
> header):** the prior header badly understated progress. Reconciling item-by-item against the
> code + the passing `frontend/tests/test_m*.py` gate (**270 passed, 1 skipped**) shows most of
> M2/M3 and the M4 flagships are already **built + green** — the "Waves M3–M4 — not started" line
> was wrong.
>
> **Status legend (used throughout — exactly these three labels):**
> - **✅ DONE** — the item's DoD is met **and** a dedicated gate is green (a passing
>   `test_m<W>_<N>_*.py` or a named source gate).
> - **PARTIAL** — a surface exists but the DoD is **not** fully met; the missing DoD is named on
>   the item line.
> - **OPEN** — not built (no surface and no gate).
>
> Per-wave counts below are **derived by counting the item statuses** (they must reconcile with
> the inline `✅ DONE` / `PARTIAL` / `OPEN` markers on each item):
>
> - **Wave M0 — 8 DONE / 0 PARTIAL / 1 OPEN** (of 9). DONE: M0-1..M0-5, M0-7, M0-8, M0-9. OPEN:
>   **M0-6** (model-tier-defaults docs/config reconcile — the one M0 residual). Owner actions
>   still owed: the `OPENROUTER_API_KEY` repo secret + rotating the in-chat key.
> - **Wave M1 — 10 DONE / 0 PARTIAL / 0 OPEN** (of 10).
> - **Wave M2 — 5 DONE / 2 PARTIAL / 2 OPEN** (of 9; the prior header's "4/8" undercount).
>   DONE: M2-1, M2-2, **M2-3** (header said "NEXT"; `test_m2_3_premiere_strip.py` 14/14 green),
>   M2-4, M2-5. PARTIAL: **M2-7** (beat chips carry the "Production notes" family; the reasoning
>   **accordion** + settings copy still read "View thinking process"), **M2-8** (only the J1-06
>   tuck-behind-reveal exists — not the DoD allowlist, no gate). OPEN: **M2-6** (no `game_moment`
>   stamp in the render path), **M2-9** (idle send-button aria unfixed, no gate).
> - **Wave M3 — 3 DONE / 0 PARTIAL / 3 OPEN** (of 6; the prior header's "not started" was wrong).
>   DONE: **M3-1** (`orwellRoomStrip.js` + `test_m3_1_room_strip.py`), **M3-2**
>   (`test_m3_2_speaker_chips.py`; PR #1251 c1b6ba1), **M3-4** (`test_m3_4_decision_faces.py`).
>   OPEN: **M3-3** (no scene-header code), **M3-5** (no player-face-on-You-bubble code), **M3-6**
>   (`OrwellDossier.open` wired only in `orwellCast.js`, not every chip).
> - **Wave M4 — 3 DONE / 3 PARTIAL / 9 OPEN** (of 15; the prior header's "not started" was wrong).
>   DONE: **M4-1** (`orwellDossier.js` + `test_m4_1_dossier.py`), **M4-2** the flagship
>   (`orwellMemoryWall.js` + `test_m4_2_memory_wall.py`; PRs #1288/#1294), **M4-6**
>   (`test_m4_6_ceremony_slates.py`). PARTIAL: **M4-9** (pre-existing `orwellDeals.js` = feature
>   0039; lacks deal duration / named alliances), **M4-11** (pre-existing `orwellRetrospective.js`
>   = feature 0048; lacks the headline-first + vote-by-vote-expander restructure), **M4-15**
>   (`orwellReport.js` fe-report ring client exists; the settings + degraded-banner entry-points
>   are unverified). OPEN: **M4-3, M4-4, M4-5, M4-7, M4-8, M4-10, M4-12, M4-13, M4-14**. None of
>   the OPEN items has a dedicated `test_m4_*` gate.
>
> Genuinely-open work (OPEN + PARTIAL): **M0-6; M2-6, M2-7, M2-8, M2-9; M3-3, M3-5, M3-6; M4-3,
> M4-4, M4-5, M4-7, M4-8, M4-9, M4-10, M4-11, M4-12, M4-13, M4-14, M4-15**. See the
> **Reconciliation note (2026-07-13)** at the foot of this file. Originally shipped via PR
> **#1234/#1235**; the M3/M4 built items landed later (M3-2 in #1251, Memory Wall in #1288/#1294).

**What this is.** The consolidated, owner-triaged backlog from the 2026-07-07 FE–BE integration
review session: every actionable item from the screenshot audit
(`docs/audits/2026-07-07-fe-be-integration-gap-review.md`), the faces-in-the-flow idea catalog,
and the market-readiness map — each with a **Definition of Ready** and **Definition of Done**.
Per the queue convention (`docs/IMPLEMENTATION_QUEUE.md` header, 2026-06-23), work is dispatched
from here as **GitHub issues** referencing the M-ids below; this file is the planning source, not
a live work record.

**Owner triage (2026-07-07, binding for this backlog):** the proof system (market item #3) is
**critical** → Wave M0. IP/naming and who-pays (#1/#2) are **owner-parked** (listed at the bottom
with their cheap prep tasks only). Explicitly **excluded by owner call**: demo/trailer (#4),
re-engagement/push (#5), player cost caps (#6), content-tone controls (#7), and everything from
hosted-scale ops through store packaging (#10+). Help/support (#8) is **nice-to-have** → last item
of Wave M4. Excluded items are *not* listed below — this is deliberate scope, not omission.

---

## Global DoR / DoD (apply to every item; per-item lists add only specifics)

**Ready when:**
- The referenced audit finding / idea is read (screenshot evidence named per item lives in the
  audit doc's appendix set), and the item has no unresolved conflict with the standing rulings
  (ADR 0003 the-conversation-is-the-game; the Vault Wall — no number/hidden state ever rendered;
  ADR 0005 never normalize the open set).
- Dependencies (per item) are merged, and any named owner decision inside the item is made.
- The implementer knows which gate lane the change lands in (fe pytest / browser smoke /
  responsive matrix / engine vitest+BDD / CI workflow).

**Done when:**
- The change ships **with its gate** (house rule: a fix without a test that would have caught it
  is not done) and weakens no existing gate (no `-k` subsets, no XFAIL additions without an id).
- `cd frontend && python3 -m pytest tests/` green (FE items) / `npm test` green (engine items);
  UI items attach before/after screenshots to the PR at 1440×900 **and** 390×844.
- Player-facing surfaces prove Vault-freedom where they render game data (a test asserting no
  hidden key/number crosses — the existing casting-leak / redaction gate patterns are templates).
- Docs touched if behavior is documented anywhere (CLAUDE.md FE conventions, INTEGRATION.md,
  features README status).
- **Pre-playtest / release checklist:** run the balance gate (`calibration-nightly`, workflow_dispatch; weekly by schedule and automatic on PRs touching tuning constants or default flags) when a default flag has flipped or a tuning constant changed since the last run, and read its PO-band table (bands: `tests/calibration/poTargetBands.ts` only). It is advisory, never a required check.

Sizes: S ≤ ~½ day · M ≈ 1–2 days · L = multi-day. Waves order by leverage; items inside a wave
are parallel unless `Depends` says otherwise.

---

## Wave M0 — finish the proof system (owner: critical; 0108 tail + owed verification)

> **Standing owner decision (2026-07-07, this session):** the production model topology is
> **two-tier** — narration on **GLM 5.2**, utility/background call classes on **Qwen 3.6**
> (locally served in prod; `deepseek/deepseek-v4-flash` as the cloud alternate). The FE's
> existing per-class routing (`default_model` + `utility_model`/`utility_endpoint_id`) carries it
> with zero new code; the golden gate is model-agnostic (fixtures are model-named, keys exclude
> endpoint URLs — a local re-record stays compatible). Qwen 3.6 Flash verified tool-calling clean;
> note it reasons by default (~266 reasoning tokens on a trivial call — ADR-0010 per-class
> reasoning budgets are the lever if utility cost creeps).

### M0-1 · Record + commit the canonical real-model golden fixture — S · ✅ DONE (record #12)
*Shipped 2026-07-08. `frontend/tests/golden/golden_path_glm-5.2.jsonl` (118 records, GLM 5.2
narration + Qwen 3.6 Flash utility, seed 108108) committed with its run report — record digest
`78b5e660e6cc6734` reproduced EXACTLY by two consecutive replays (R1 zero misses, R2 zero
provider reach). The `golden-path` PR gate is ARMED. Twelve records total; every replay failure
converted to a structural fix: fixture integrity/writer forensics, shared-state scrub, settings
TTL race, phase-stall escalation, pending-surface gap (M0-7), serialized authoring, cast-state
walk gate, the M0-8 logical clock, background-LLM quiesce (memory/title/skill), dwell-label
neutralization, golden 409-token strip, and the awaited post-turn record belt. Owner actions
remain: `OPENROUTER_API_KEY` repo secret (nightly) + rotate the in-chat key.*
Source: 0108 (built, gate dormant). Retargeted by the owner from deepseek-v4-pro to the two-tier
GLM 5.2 + Qwen 3.6 Flash pair; key provided in-session; record run live at time of writing.
- **DoR (met):** key at hand ✓; OpenRouter reachability through the proxy verified ✓; both models
  verified tool-capable ✓; two-tier driver support shipped ✓ (`--model` + `--utility-model`).
- **DoD:** the live run's invariant table reviewed; leak scan clean;
  `frontend/tests/golden/golden_path_glm-5.2.jsonl` committed (mid-write fixtures are never
  committed — the commit IS the gate-arming event); the `golden-path` CI job green on two
  consecutive runs (`--runs 2` digest-equal); **owner:** set the `OPENROUTER_API_KEY` repo secret
  (arms `golden-nightly`) and **rotate the key pasted in chat** after the session.
- **Finding (2026-07-07, first record attempt — fixture invalidated, root-caused, fixes shipped):**
  the first GLM recording was **silently contaminated**: 90 of 251 records carried a stale stub
  model. Forensics (seq stamps are per-process): a **single writer** — the record run itself —
  flipped narration mid-run at seq 144, right after an OpenRouter `502 (200-with-no-JSON-body)`
  at seq 132. Root cause: **`frontend/data` is shared across driver runs** — the persisted
  canonical game-session binding (`data/orwell_game_session.json`) re-bound the walk at game
  start onto a PREVIOUS run's chat session, whose row pins that run's endpoint+model (a stale
  stub endpoint from the audit-era screenshot harness): the **#1086 seam class**, reproduced by
  the harness itself. Structural fixes shipped rather than a one-off cleanup: **format-2
  self-describing fixtures** (leading `meta` line declares the two-tier models; every record
  carries a per-process `writer` stamp), `fixture_integrity_scan` (exactly one writer + no
  record off the declared model set) enforced at **record time and again in the PR replay
  gate**, a driver pre-flight `scrub_stale_state()` (drops the canonical binding, stale
  `golden-path` sessions/endpoints, layout dirt; clears crashed-run port squatters), and
  meta-first `fixture_models()` (the old first-stream heuristic mis-derived two-tier fixtures —
  cast-identity calls stream on the utility tier). Unit gates in `test_0108_golden_path.py`.
- **Finding (record attempt #2 — walk pacing, driver-side, fixed):** GLM 5.2 lingered in rich
  social play pinned inside `hoh-competition` for 40+ player turns (the run was killed at 65
  turns to save budget). Legitimately so: the FE's forced-advance belt is LULL-gated by owner
  ruling, and the walk's social prompts read as engagement — never a lull. Fixed player-side,
  ADR-0003-clean: after `PHASE_STALL_AFTER`=6 same-phase player turns the walk escalates to an
  explicit "production, run the ceremony now" prompt until the phase flips, with a
  `PHASE_STALL_ABORT`=25 backstop that fails I5 honestly instead of burning a paid budget on a
  real stall. *Product datum worth keeping: a socially-active player can hold a phase open
  indefinitely — by design (lingering is play), but note the pacing texture for M2 copy.*
- **Finding (record attempt #7 — the terminal class: WALL-CLOCK INSIDE THE ENGINE TICK; M0-8 filed):**
  #7 recorded perfectly (all invariants, 15/15 authored BEFORE the walk, integrity + leak clean)
  and its replay cleared walk turn 1 for the first time — then missed at turn 2 on the presence
  divergence again. The ledger proof is conclusive: **36 byte-identical mutations** (names + arg
  digests) through turn 1, reads rng-pure, yet the record's world evolved 2–3 presence steps
  further. Cause: `orchestrator.defaultApply` hashes **`clockNow` (wall-clock) into derived rng
  seeds** (`confessional-recent/-phrasing:${clockNow}`) and event recency windows / ids — a
  40-min record and a 4-min replay live in different clocks, so tick behavior diverges no matter
  what the driver does. Terminal for driver-side fixes; requires the engine-side logical clock
  (**M0-8**). The fixture is NOT committable until M0-8 lands; the golden-path gate stays
  dormant-with-notice (by design), and the PR ships complete without it.
- **Finding (record attempts #5/#6 — walk proven; two determinism classes closed):** #5 walked a
  PERFECT week (every invariant green, roll included) and was rejected solely by the
  review-hardened initialized-vs-populated integrity rule — the record SCRIPT stamped the meta
  line from its own pid. Fixed by construction: the FE process now writes the meta line itself on
  its first record (declared tier via `ORWELL_GOLDEN_NARRATION_MODEL`/`_UTILITY_MODEL`/`_SEED`
  envs). #6 recorded green end-to-end but its replay missed at the first walk turn: the I4 gate
  broke early at `authored >= 13` and the walk started while the last two profiles were still
  committing — the record's first prompt carried their seeded-floor descriptions while replay's
  fixture-fed authoring finished instantly and rendered the AUTHORED ones (a cast-state
  divergence, pinned by a direct record-vs-replay system-prompt diff). The driver now waits for
  the FULL cast before walking (record mode requires 15/15 for a committable fixture; replay
  keeps the >=13 tolerance since it inherits the recorded outcome) and quiesces the final folds
  before the first prompt.
- **Finding (record attempt #3 — the structural gates' first clean pass + M0-7 discovered):**
  integrity scan PASSED (single writer; qwen×61 + glm×198, zero foreign records — the
  contamination class is dead), leak scan clean, escalation cleared three phase-dwells and the
  week reached eviction — where the walk absorbed 25 escalated turns because the driver polled
  `getGameState` for pendings and **the eviction-vote pending only surfaces on `gameStatus`**
  (engine autopsy on the preserved data dir: `advanceGame` idempotently re-returned the
  player-vote pending at the same beatSeq while `getGameState.pending` read null). Driver now
  reads pendings from `/api/orwell/status` — the decision card's own surface, truer product
  emulation. The engine-side projection disagreement is filed as **M0-7**. I7's mid-body scrub
  also false-positived on host voice ("Let me get a read on…") — mid-body now flags only
  unambiguous operator signatures; the full planning set still applies to the leading strip.

### M0-8 · Engine: logical clock under golden mode (wall-clock is in the tick's rng) — M (engine) · ✅ DONE
*Shipped 2026-07-08. `ORWELL_LOGICAL_CLOCK` (runtime.ts `logicalClockFromEnv`): reuses `FakeClock`
at a fixed epoch (2026-01-01Z, or an env-supplied epoch-ms); advances +60s ONCE per committed
mutation inside `registry.setCommit` (before the commit's tick, so the tick sees the new minute);
reads clock-neutral; forces pure turn-driven (watcher cadence ignored with a warning); injected
test clocks win over the env; unset ⇒ byte-identical SystemClock. Driver sets it on the engine in
both modes. Gate: `tests/unit/logicalClock.test.ts` — 5 tests incl. the pacing-invariance proof
(identical call sequences at 1ms vs 40ms wall pacing ⇒ byte-identical snapshots).*
Source: record attempt #7 autopsy (2026-07-07). `orchestrator.defaultApply` seeds per-tick derived
rng streams and recency windows with **wall-clock `clockNow`** (`confessional-recent/-phrasing:
${clockNow}`, `selectRecentForConfessional(events, …, clockNow)`, `orch:day:${clockNow}` ids) — so
a real-time record and a fast replay diverge in tick behavior even with byte-identical mutation
sequences (proven by ledger diff: 36 identical mutations, different presence/gossip state one
turn later). Every future record/replay pair diverges the same way; this is the terminal blocker
for committing any golden fixture.
- **DoR:** locate the engine's `Clock` port wiring in `src/composition/runtime.ts` (a
  deterministic clock adapter likely already exists for the test sandbox); decide the golden
  semantics — recommended: an env-gated **logical clock** that starts at a fixed epoch and
  advances ONLY on committed mutations (reads never advance it — read counts are
  wall-clock-paced and must stay clock-neutral), so identical commit sequences ⇒ identical
  clock sequences ⇒ identical tick behavior.
- **DoD:** with the env set, two engine runs fed identical tool-call sequences at different
  wall-clock pacing produce byte-identical event streams and projections (a unit gate proves
  it); default behavior (env unset) byte-identical to today; the golden driver sets the env on
  the engine it boots; a fresh GLM record + `--runs 2` replay then validates end-to-end and the
  fixture commits (closing M0-1). *Also note: the FE agent loop's round-continuation decision
  ("round counts vary ±1 with stream timing" — the reason `turnsHere` is key-neutralized) is the
  next-frontier nondeterminism if it survives the clock fix; keep the miss-dump/ledger drill.*

### M0-9 · Two residual golden nondeterminism classes (tick pacing + a wall-clock writer) — S+S · ✅ DONE
*2026-07-08, the M0-7 re-record campaign (records r2/r3, one deterministic R1 miss each — both
autopsied via the miss dump + llm-io twin diff + engine event-prefix diff):*

*Class 1 — aux commits tick the house under the logical clock (r2's miss: the 0076 "MOVEMENT IN
THE ROOM" cue rendered in replay but not record; occupancy lines and the committed EVENT prefix
byte-identical, so the fork was presence SAMPLING, not presence state). Under the M0-8 logical
clock every commit advances a full 60s step, so the E57 wall-time aux-tick debounce (10s) can
NEVER absorb — the house ticked once per TOOL CALL instead of once per turn, resurrecting the
E57 regression golden-side and amplifying the known round-count ±1 nondeterminism (record
streams over wall seconds; replay is instant — a commit shifts across a turn boundary and
everything presence-sampled at framing time jitters: seating, dwell, the movement cue). Fix:
`auxTicksNever` orchestrator flag, set by `composeRuntime` whenever the logical clock is active
— an aux commit never fires the off-screen tick; beats only (beat commits replay identically).
Production untouched (the wall debounce is correct under real time). Gate: `logicalClock.test.ts`
"aux commits never tick under the logical clock — seating frozen between beats". The M0-8 note's
"next-frontier nondeterminism" prediction was exactly this.*

*Class 2 — the G20 portrait reconciler is a WALL-CLOCK engine writer (r3's miss: replay one
event + one commit behind record at the same turn — `evt:mcp:8` vs `9`, `beatSeq 24` vs `25` —
and the event-prefix diff named the extra record-only event: `evt:image:6`, "image shown to the
player: npc:… portrait"). The 5-minute reconciler sweep fired mid-record (a record outlives the
interval; a replay doesn't), found "missing" portraits, generated REAL ones through
`backfill_missing` → `generate_and_store` against the live provider (also unbudgeted image
spend), and recorded image-shown beats a dead-end-provider replay can never reproduce — every
later event id / beatSeq shifted one and the first tool result carrying one forked the key. The
turn-driven portrait paths were already quiesced (kickoff_generation / kickoff_backfill); the
reconciler start was the gap. Fix: `ensure_reconciler_started` no-ops under `golden_path.active()`
(same quiesce family as the memory/title/skill extractors + zeitgeist). Gate:
`test_portrait_reconciler_is_quiesced_under_golden` (loop-safe via conftest `_run` — a bare
`asyncio.run` in a test poisons the xdist worker's default loop; 91 later tests failed until it
used the suite idiom).*

### M0-7 · Engine: `getGameState.pending` disagrees with `gameStatus.pending` — S–M (engine) · ✅ DONE
*2026-07-08: root was `GameSessionAdapter.view()` (the `getGameState` projection) simply omitting
the field — `gameStatus` and the `advanceGame` result both read `pendingView()`, `view()` never
did. `GameStateView` now carries `pending` (live reads return `pendingView()`, pre-game `null`);
`tests/unit/pendingProjectionAgreement.test.ts` walks a seeded season through a full week
answering every pending with a fixed legal policy and asserts the two projections agree at EVERY
beat (plus advance-result agreement). FE untouched behaviorally (the status-read remains the
decision card's source; one stale comment updated). The new field rides in `getGameState` tool
results the model sees, so it forked every downstream golden request key — the fixture was
re-recorded on live GLM 5.2 the same day (the "next natural re-record" the M0-5 note was waiting
on; its dwell-scope refinement was taken in the same cycle) and validated replay ×2.*

Source: record attempt #3 autopsy (2026-07-07). A pending created inside an advance (the
eviction-vote ballot) surfaces on `gameStatus` (and in the `advanceGame` result itself) but reads
`null` on `getGameState` — two Vault-free closed-set projections of the same sandbox disagreeing
about the live pending. Product impact is masked (the decision card polls status), but any
consumer keying on state — an integration, a future surface, the admin snapshot's `tiersAgree`
principle — inherits the gap silently.
- **DoR:** reproduce in a unit sandbox (advance a seeded season to eviction; assert both
  projections); locate where each read derives `pending`.
- **DoD:** both player reads return the same pending at every beat of a full seeded week (a
  property test over the UAT walk asserts projection agreement per step); no behavior change to
  either surface beyond the missing field; FE untouched (the status-read remains the decision
  card's source).

### M0-2 · Calibrate invariants I2/I3 against the real belts — S–M · ✅ DONE
*Resolved 2026-07-07 with three consecutive real-run data points. **I2 — settled: the opener is
CLIENT-KICKED** (`orwellOnboarding.js` auto-sends the hidden `OPEN_GAME_LINE` production cue when
the welcome dismisses — "the producers reach out first" is a browser seam, and there is no
server-side unprompted opener after createCharacter either; premiere narration rides the finalize
turn). A REST-driven walk types first by design, so the beat structurally cannot occur headless —
I2 is now an honest SKIP with that rationale, and the covering gate for the real seam is the
fe-browser onboarding smoke. **I3 — PASSES on real runs** (photo beat surfaced in casting on both
GLM records; the conditional SKIP remains only for configs whose casting genuinely has no photo
beat).*
Source: 0108 stub-run findings, now twice-confirmed on real runs pending (I2 opener never fired
headless in any stub cycle; I3 skipped — no headshot beat surfaces headless).
Depends: M0-1 (the GLM run report is the evidence base).
- **DoR:** M0-1's run report at hand; decision noted whether the #967 opener belt is
  client-kicked (if so, the driver emulates the kick) or server-side (if so, its absence is a bug).
- **DoD:** I2 and I3 each either PASS on a real record/replay cycle or are converted into a filed
  issue with the run-report evidence attached; the driver's conditional SKIP for I3 only remains
  if the golden path legitimately has no photo beat under the recorded config.

### M0-5 · Close the residual replay-miss class — M · ✅ CLOSED by the M0-1 campaign (superseded)
*2026-07-08: the committed fixture replays with R1=0 across two runs — the residual class is gone
(it fell to the logical clock + quiesce + awaited-belt fixes). One accepted-risk refinement noted
from PR #1234 review: the `"(a moment)"/"(just arrived)"` dwell neutralization is global, not
presence-line-scoped — a bare parenthetical in unrelated prose would be masked key-side.
**Refinement landed 2026-07-08** with the M0-7 re-record (the "next natural" one): the dwell subs
are now scoped to the `With you:`/`Your room:` presence lines (`_PRESENCE_LINE_RES` in
`frontend/src/golden_path.py`), the Your-room tenure clause covers its word forms too
(`(you've been here just arrived/a moment)` — the old numeric-only pattern missed them), and an
out-of-line parenthetical drifts the key again
(`test_dwell_neutralization_is_scoped_to_presence_lines`).*
Source: this session's determinism campaign. Four volatility classes are already fixed and
committed (the wall-clock prompt section neutralized key-side; the web-search zeitgeist quiesced;
the off-screen-texture and portrait pipelines quiesced — the ledger-diff finding; the presence
dwell counter neutralized; per-turn + post-create beat-quiesce barriers in the driver). Replay
digest determinism and invariant-vector reproducibility are green; a **residual deterministic R1
miss class remains on the stub fixture** (same misses both runs — a record↔replay divergence, not
a flake).
- **DoR:** the GLM fixture's own `--runs 2` replay result (it either shows the same residual or
  clears it — the stub's compressed pacing may be the trigger); the engine-call ledger
  (`ORWELL_GOLDEN_CALL_LEDGER`) + miss dump (`ORWELL_GOLDEN_DEBUG_DUMP`) diffs from that run.
  **Constraint learned: one driver run at a time — `frontend/data` is shared state** (parallel
  runs cross-clobber model config; two crashes proved it). *Now partially fenced (M0-1 finding):
  the driver pre-flight `scrub_stale_state()` clears cross-run state, and the fixture
  writer/model integrity scan turns any surviving interleave into a hard failure — but the
  shared-data constraint itself stands (a per-run FE data dir is a larger refactor, deliberately
  not taken).*
- **DoD:** replay of the committed real fixture reports **R1 zero misses** on two consecutive
  runs; whatever seam the ledger diff names is fixed with the same discipline as the four above
  (quiesce/neutralize/serialize — never mute); the fix lands with a unit gate in
  `test_0108_golden_path.py`.

### M0-6 · Reconcile the model-tier defaults to the two-tier decision — S (docs + config) · OPEN (the one M0 residual: ADR 0016 amendment + `settings.py`/`oobe_reset.py`/`golden-nightly` defaults not yet reconciled to the two-tier decision; blocked on the owner DoR confirmation; no gate)
Source: the owner retarget above vs the repo's standing defaults (ADR 0016 names GLM-4.7 +
Seedream; `settings.py` defaults `z-ai/glm-4.7`(chat)/`glm-4.7-flash`(utility); `oobe_reset.py`
resets narrator to `deepseek/deepseek-v4-pro`).
- **DoR:** owner confirms the OOB defaults should BE the two-tier pair (vs merely this
  deployment's settings) — the local-Qwen posture means the OOB cloud default may deliberately
  differ from the owner's own rig.
- **DoD:** ADR 0016 gains an amendment line recording the 2026-07-07 tier decision;
  `settings.py` defaults + `oobe_reset.py` OOB models + the `golden-nightly` model args agree
  with whatever the owner confirms; the settings-wiring source gates updated in the same PR.

### M0-3 · ADR-0008/0012 owed live-LLM two-window re-run + mid-gen-join pin — M · ✅ DONE
*2026-07-08: both halves shipped. The PIN — `frontend/tests/test_m0_3_midgen_join.py`
(fe-browser-tests lane): real engine + real FE + a scripted slow-drip stub; window B joins
MID-GENERATION and must paint live partials then converge byte-identical (3/3 green). The LIVE
run — `frontend/scripts/_verify_two_window_live.py` on real GLM 5.2: one game driven
premiere → HOH → nominations → veto with two windows open throughout + a third joining
mid-generation, **VERIFY OK 14/14** (26 parity checks across two runs, zero divergences, held at
1–3 min/round real latency). Results + screenshots appended to
`docs/audits/2026-06-27-ship-gate.md` §M0-3. Driver hardening learned live: socket reads 600s
(a 240s read timeout killed run 1 mid-GLM-thinking-pause), fail-soft turn reader (the run is
server-detached), incremental verdict persistence.*

Source: repo's own owed-verification list; market #3 ("prove the real product works").
- **DoR:** real narrator endpoint configured (same lesson-17 recipe as M0-1); the F1–F5 airtight
  bar (`docs/audits/2026-06-27-ship-gate.md`) open beside the run.
- **DoD:** two real windows on one live game verified for F5 parity through a full ceremony
  sequence including a mid-generation join; the mid-gen-join behavior pinned by a test (the owed
  "test pin" from the ADR-0010/0012 residual list); results appended to the ship-gate doc.

### M0-4 · A-S3: stale-409 must not drop a scene's only consequence fold — M (engine) · ✅ DONE (was already shipped; row was stale)
*Source-verified 2026-07-08: the CON-11 audit campaign had already built the full R1c design —
this row predated it. Both strategies from the DoR landed, layered: (1) **retry-once with the
refreshed token** — `agent_loop._backfill_with_cas` reconciles a stale-409 via
`_handle_stale_beat` and re-attempts against the fresh `beatSeq` (safe because the engine throws
BEFORE any record/fold — fail-closed CAS); (2) **queue-and-refold** — a SECOND consecutive 409 on
a fold-bearing call (`defer_fold=True`) queues into the bounded per-owner
`chat_helpers._defer_fold` queue, drained at the top of every later back-fill
(`_drain_deferred_folds`) — the loss is bounded to latency, never data; positional belts
(`moveTo`) keep reconcile-and-skip by design (a stale location re-derived late would be wrong).
The MODEL-called `do_record_interaction` attaches no CAS token at all, so it structurally cannot
409. DoD mapping: engine stale-CAS race test = `tests/unit/syncSpine.test.ts` ("a stale
recordInteraction folds NOTHING; the re-attempt at the fresh beatSeq folds exactly once (#591)");
FE gates = `frontend/tests/test_0065_backfill_cas.py` (14 tests: retry-lands, double-409 defers,
drain-lands, overflow-drops-loudly, no-self-409); ledger = per-turn `staleRejections` in
`orwell_sync_ledger` + the `deferred_fold_count()` ops hook. Both suites green this session
(engine `test:ci` 623 scenarios; fe-unit 4021).*

---

## Wave M1 — one live truth, zero seams (audit lane A)

### M1-1 · Kill the live double-render race — M · `P1` · ✅ DONE (3835e68)
*Root cause: the deferred peer-resume flush re-attached to the tab's OWN just-settled run and replayed the reply into a fresh bubble. Fixed by convergence key (the replayed message_saved's server DB id aborts a resume whose bubble already exists) + per-chunk paint batching so the one-burst settled replay can never flash a transient dup frame. Gate: tests/test_m1_1_resume_own_echo.py + the #873 suite.*
Source: audit A1 (`s-b5`/`s-b6`; one completion → two bubbles, one persisted row; intermittent).
- **DoR:** repro conditions noted (first streamed turn after reload on a fresh game); the #873
  harness (`frontend/scripts/_capture_873_dedup.py`) understood as the instrumentation template.
- **DoD:** root cause identified in the live-stream × session-sync append seam (`chat.js` round
  buffers / `sessionSync.js`) and fixed by convergence key, not content-equality; the #873
  harness grows a live-turns-after-reload scenario failing on any frame with two same-content
  `.msg-ai`; runs in `fe-browser-tests`.

### M1-2 · Time-of-day re-applies on game creation — S · `P1` · ✅ DONE (ac4fc5c)
*Shipped 2026-07-07. Root cause was sharper than the audit's guess: the deferred per-turn apply
existed but its `not user` guard skipped anonymous single-tenant play (AUTH off ⇒ user None)
forever. Fixed at three seams (framed-turn lazy apply now covers user=None via the anon→default
mapping; the new-game ops door applies on season start; the boot log demotes the expected
pre-game miss). Gate: `tests/test_m1_2_time_of_day_reapply.py`.*
Source: audit A2 (`app.py:1097` boot-only apply; "no active game" at boot ⇒ clock dark all season).
- **DoD:** `set_time_of_day(get_setting("time_of_day_enabled"))` re-fires on successful
  `new-game`/`createCharacter` (the same seam that kicks the pre-warm tasks); a pytest proving a
  game created *after* FE boot reports `timeOfDay` in state; the fe.log failure line demoted to
  info on the pre-game path (it is expected there).

### M1-3 · Board renders on beatSeq change; ceremony beats kick the rail — S–M · `P2` · ✅ DONE
*Shipped 2026-07-07. Root cause was a COMMIT RACE, not a missing subscription: the panel already
refetched on `orwell:gamechanged`, but the refetch could read pre-commit state and nothing re-kicked
until the 20–30s poll. Fix: the seams that know the committed `beatSeq` (chat tool-result output,
decision POST response) pass it through THE single dispatcher (`orwellGameChanged(reason, beatSeq)`,
debounce coalesces to the highest beat); the status panel catch-up-fetches (1s, bounded ×3) until
its read reaches the claimed beat. Poll cadence unchanged; g15 one-dispatcher rule holds. Gate:
`tests/test_m1_3_beatseq_freshness.py` (5 source pins) + `test_g15_gamechanged.py` green.*
Source: audit A3 (goodbye card announcing an eviction beside a board still reading "HOH
Competition · 16/16").
- **DoR:** decision: keep the 20–30s poll cadence but render on `beatSeq` delta + pass the chat
  tool-result's `beatSeq` through the existing `orwellGameChanged` seam (no new dispatcher —
  g15 rule holds).
- **DoD:** a bound ceremony beat refreshes the board within one event tick (not one poll);
  `test_g15_gamechanged.py` still proves exactly one dispatcher; a new gate asserts the board's
  phase label can never lag a committed pending kind by more than one poll interval in the
  mirror-drive harness.

### M1-4 · Decision card: nothing clipped, Confirm always reachable — S · `P1` (mobile) · ✅ DONE (a86ca29)
*Shipped 2026-07-07. The double roster was the ENGINE's pending prompt ("Still in with you: …") +
the FE's structured `pending.stillIn` both rendering — fixed FE-side: `orwellDecision.js` elides
the prompt's templated roster sentence ONLY when the structured region renders (untouched prose
fallback); `.odec-hint` un-clipped (margin/line-height); small viewports (`max-width:480px` /
`max-height:720px`) scroll the PROSE region internally (`.odec-prompt`/`.odec-stillin`
max-height:20vh) while options + Confirm stay visible. Holds in all three host modes. Gates:
`tests/test_m1_4_decision_card_layout.py` (4 source gates) + a real-render browser-smoke block
(dispatches a comp-round pending, asserts single roster + kept prose + visible hint).*
Source: audit A4 (`s-b9` clipped helper line; `m-1` Confirm below the fold, double roster).
- **DoR:** decision (default yes): option chips instead of comma prose on coarse pointers.
- **DoD:** card prose scrolls internally; option row + confirm row always visible at 1440×900
  and 390×844; the duplicated "Still in with you / Round 1 — Still in" roster collapsed to one;
  helper line never clipped; `responsive_matrix.py` gains a decision-card-confirm-visible
  assertion (XFAIL registered/removed in the same PR per Stream-S rules); existing C20
  browser-smoke decision block untouched and green.

### M1-5 · Mobile gadget drawer: one opaque sheet, a scrim, zero collisions — M · `P1` (mobile) · ✅ DONE (9409b91)
*Both drawer media blocks force the opaque sheet (rail --bg, cards --panel, backdrop off; desktop keeps glass); scrim at z59 under the drawer's 60, tap-closes, lifecycle owned by openDrawer/closeDrawer. Gate: tests/test_m1_5_drawer_sheet.py.*
Source: audit A5 (`m-3` — translucent layer soup, titles double-exposing, buttons overlapping text).
- **DoD:** on coarse pointers the rail opens as an opaque (or ≥.95 alpha) sheet over a scrim;
  gadget cards opaque within it; one stacking context; `responsive_matrix.py` asserts no two
  gadget-card boxes intersect and no drawer text node sits over chat text in the open-drawer
  state on the phone profile.

### M1-6 · First-run card: own stacking context, docked toast, honest gated CTA — S–M · `P2` · ✅ DONE (c74526f)
*Onboarding window opaque + isolation:isolate (scoped :has([data-ob-setup])); corner toast docks below the titlebar band while body.ow-onboarding; Start carries a visible why-disabled cue + bounded 2.5s re-probe (event-race cover) torn down on dismiss — the gate stays honest (no narrator feed ⇒ no game) rather than failing open. Gate: tests/test_m1_6_first_run_card.py.*
Source: audit A6 (`s-a1` — wordmark/ambient text ghosting through the card, toast over the ×,
primary CTA disabled 30+s with no cue).
- **DoD:** nothing renders through the modal; the "producers are getting the house ready" toast
  docks below the titlebar; the gated CTA shows progress ("Casting the house — N of 16…") and
  fail-opens to enabled with the deterministic floor after a bounded wait; browser-smoke
  onboarding block extended to assert the CTA is enabled-or-progressing within the bound.

### M1-7 · Season reset: overlay banner + season divider — M · `P2` · ✅ DONE (this commit)
*Owner-recommended path taken: fresh session per season (the existing E65 seam) + the restart chat now titled "Season N" off /api/orwell/season (form-encoded rename; auto-namer skips custom names). The degraded-engine banner overlays without reflow — the notice kit gains reflow:false (host reserves body padding only while a reflow-participating card is up) and orwellEngineStatus opts in. Gate: tests/test_m1_7_season_reset.py.*
Source: audit A7 (`t-3` — "technical moment" slab reflows the app; dead season's transcript under
the new casting interview; session titled "Casting interview" forever).
- **DoR:** owner-consistent choice confirmed in-PR: archive-behind-divider vs fresh session per
  season (recommend divider + fresh session titled by season, keeping the sanctioned single
  restart door untouched).
- **DoD:** the degraded banner (`orwellEngineStatus.js`) overlays without reflow; after a
  confirmed reset the old transcript is archived behind a "Season N ended" divider (or a fresh
  session starts) with the casting interview starting clean; a pytest covering the reset →
  casting transcript state; no second restart path introduced (D1/R1 rule).

### M1-8 · Silence the stream_status 404 poll — S · `P3` · ✅ DONE (90175e9)
*Shipped 2026-07-07 server-side: idle answers 200 `{"status":"idle"}`; both sessions.js consumers
already branch on `status !== 'streaming'` (the F-8 probe-once client fix stands). Gate:
`tests/test_m1_8_stream_status_idle.py`.*
Source: audit A8 (`sessions.js:2258/2311`).
- **DoD:** polling a session with no live stream returns 200-empty or the client gates the poll
  on stream presence; zero `stream_status` 404s in the browser-smoke console capture.

### M1-9 · Image-capability honesty — S · `P3` · ✅ DONE (cb78b16)
*Shipped 2026-07-07 as an OUTCOME verdict (design finding: `image_generation_available` is
deliberately permissive — the documented false-negative fix — so honesty lives in the last
completed run: 0-of-N attempted ⇒ failing, surfaced in the cast panel copy, the /roster payload,
and the /admin/status row; all-skipped idempotent re-runs never overwrite a real verdict; a
new-season scrub resets it). Gate: `tests/test_m1_9_portrait_honesty.py`.*
Source: audit A9 (cast panel churns "Generating 16 remaining… (0/16)" with no image provider;
admin says "Image generation AVAILABLE").
- **DoD:** the backfill button and the admin label gate on a real image-capability probe (not
  config presence); without a provider the cast panel says "No portrait model configured —
  Settings → Models" and the admin row reads NOT CONFIGURED; pytest source gate on both labels.

### M1-10 · Utility-call retry backoff — S · `P3` · ✅ DONE
*Shipped 2026-07-07. In-run retries now back off exponentially (0.4s→0.8s→1.6s, call- and
write-side); a per-houseguest per-season attempt ledger caps TOTAL provider calls across every
re-kick (`_ATTEMPT_CAP`=6) — at the cap the NPC gives up LOUDLY (warn-once log, run-summary tally,
`authoring_completeness()["givenUp"]` → the /admin/status castAuthoring block) until
`reset_attempts()` clears it at the new-season scrub (all three scrub sites). Per-user scoped.
Gate: `tests/test_m1_10_authoring_backoff.py` (5 gates incl. bounded-total-calls across 5
re-kicks).*
Source: audit A11 (same-second identical cast-authoring bursts against a bad provider).
- **DoD:** background authoring retries carry exponential backoff + a give-up cap per NPC per
  session; a unit test proving a permanently-failing utility model produces a bounded call count;
  the give-up lands in the G11 failure ring (visible on /admin/status), not silence.

---

## Wave M2 — the first five minutes look like television (audit lane B)

### M2-1 · Cold-open first-run — M · `P1` · ✅ DONE
*2026-07-08: the setup wizard now leads with the show — h1 "Welcome to the Big Brother house",
one primary CTA "Enter the house" (was "Start casting"); the model summary is ONE demoted
humanized production-feeds line ("Narrator: GLM 5.2 · Portraits: Gemini 2.5 Flash Image",
`humanizeModelId` — display-only, resolution keeps raw ids); the config door is the quiet
"Production settings" link (same `data-ob-choose-models` behavior + modal stack). Raw ids render
only inside the real Settings. Gates: `tests/test_m2_1_cold_open.py` (fantasy h1, one CTA,
humanized-only render path, demoted link) + the updated `test_oobe_onboarding` pins + the
browser-smoke block now asserts the fantasy lead AND regexes the cold open for raw slash-form
model ids. M1-6's gated-CTA hint machinery untouched (copy follows the new naming). fe-unit 4025.*

Source: audit B1 (`s-a1` — raw model IDs above the fantasy). Depends: M1-6.
- **DoR:** decision: cold-open copy voice (existing diegetic copy is the baseline); model config
  demoted behind a "Production settings" link.
- **DoD:** first screen leads with the show fantasy and one **Enter the house** CTA; model names
  render humanized ("Narrator: GLM-4.7") with raw IDs only inside Production settings; no raw
  provider/model id string anywhere on the first screen (pytest source gate); onboarding
  browser-smoke block updated.

### M2-2 · Designed monogram portrait system + role badges — M–L · `P1` (the leverage item) · ✅ DONE (owner mock APPROVED 2026-07-08)
*2026-07-08: `orwellMonogram.js` — ONE kit component: id-seeded two-tone gradient (FNV +
murmur-avalanche finalizer so sequential ids spread the wheel) + four broadcast pattern
families + two-letter initials + camera-bug ring; fixed badge set (HOH crown / nominee
target / veto V / winner star) composites bottom-right on portrait AND monogram; eviction
stays the L16 grayscale (kit-owned). Consumers wired: cast window (badges from
`/api/orwell/status` riding the roster poll; "In the house" caption suppressed for the
default state), cast pin (silhouette → designed monogram + badges), decision chips (person
options carry a 22px face, aria-name pinned to the label). The DoR mock is
`docs/mocks/m2-2-monogram-template.html` (static, self-contained — owner approves in the PR;
constants live in the kit so template tweaks are one-file). Gates:
`tests/test_m2_2_monogram.py`, the J2-15 pin retargeted, browser-smoke zero-provider
designed-monogram assert.*

Source: audit B3 (`s-d1` flat letter-rectangles); prerequisite for M3-* faces work.
- **DoR:** one designed template (archetype-tinted gradient + pattern + typography) approved via
  a static mock in the PR; badge set fixed (HOH crown / nominee target / veto / evicted / winner).
- **DoD:** every placeholder portrait renders the designed monogram (deterministic per
  houseguest id — seeded hue/pattern); role badges composite on any portrait (generated or
  monogram); "IN THE HOUSE" caption only renders when status ≠ default; cast window, rail chips,
  and decision cards consume the same component; browser-smoke asserts monograms render with
  zero image provider configured.

### M2-3 · Premiere cast strip + pre-HOH board reframe — M · `P1` · ✅ DONE (evidence: `frontend/tests/test_m2_3_premiere_strip.py`, 14/14 green; `os-prem-count` in `orwellStatusPanel.js`)
*Reconciled 2026-07-13: BUILT — the header's "NEXT" was stale. Shipped on
`OrwellMonogram.face()`: the 16-tile premiere strip, the `os-prem-count` met-progress gate (in
`orwellStatusPanel.js`), and the pre-HOH board reframe (when `status.hoh` is null and week === 1)
are all present and gated by `test_m2_3_premiere_strip.py` (14/14 green). Tracking issue: verify
by M-id and close on the passing gate.*

Source: audit B2 (`s-b1` — empty premiere, `HOH — / Noms — / Veto —`). Depends: M2-2 ✅.
- **DoD:** premiere shows the sixteen-tile strip lighting up with the met-progress gate (0/15 →
  15/15), clicking a tile scrolls/focuses the chat (never replaces it — ADR 0003); pre-HOH the
  dead board rows read "First HOH tonight" instead of em-dashes; strip disappears (or docks)
  after the first HOH; Vault-free proof (tiles render only roster/met/public-status data).

### M2-4 · One verb set across the entry journey — S · `P2` · ✅ DONE
*2026-07-08: the pinned line is one diegetic, house-centric register — **Enter the house →
Take your cast photo → Meet the house**. M2-1 set the onboarding CTA; this renames the casting
photo pill ("Choose Your Character" was RPG-speak off the fiction) with its aria following; the
premiere tutorial + status-panel objective already spoke "Meet the house" and stay. Structural
ids (`data-ob-setup-start`, `orwell-choose-character`, `hs-choose-btn`) unchanged. Gate:
`tests/test_m2_4_verb_set.py` — pins each surface to its verb AND asserts the retired verbs are
no longer renderable (render-site scan, so history comments stay legal); smoke + oobe pins moved.*

Source: audit B9 ("Start casting" / "Choose Your Character" / "Meet the house").
- **DoD:** one naming line (casting → premiere → play) applied across onboarding card, chat gate
  card, and premiere card; pytest source gate pinning the copy set so it can't re-diverge.

### M2-5 · Narrator identity + production-slate beat styling — M · `P2` · ✅ DONE
*2026-07-08 (owner pick this session): the transcript author is **"Production"** — ONE constant
(`GAME_NARRATOR`, `orwellToolBeats.js`; also `window.ORWELL_GAME_NARRATOR`) consumed by all six
game-build author sites (live stream, placeholder/resume via `_senderLabel`, continuation rounds,
history reload, image bubbles); slash/compacted meta-bubbles keep "Orwell" (product chrome).
Beats render as production slates in the game build: aligned rail + slate caps
(`game-trim.css`, `body[data-game-build]`-scoped), NO lowercase "done" tail (failures stay
literal — operator truth), outcome slates keep richer type via the persistent
`.ow-slate-outcome` marker (the reveal class is transient). Gates:
`tests/test_m2_5_narrator_identity.py`; C14 pins retargeted to the constant; live screenshot
verified. P-1 rebrand = one line.*

Source: audit B4/B7 (bubbles "Orwell", beats "· ✔ 📺 PRODUCTION done", fiction "Big Brother").
- **DoR:** owner picks the transcript author name (recommend the diegetic show voice; "Orwell"
  stays product chrome). *(Note: final naming may be revisited by parked item P-1 — implement as
  a single constant so the rebrand is one-line.)*
- **DoD:** assistant bubbles carry the chosen diegetic author; tool beats render as production
  slates (aligned rail, styled label, no lowercase "done" debug tail); beat labels stay sourced
  from `orwellToolBeats.js` (single registry); browser-smoke label checks updated.

### M2-6 · In-world timestamps on beats — S–M · `P2` · OPEN (recon done, unbuilt — no `game_moment` stamp at the persist site or in `roleTimestamp()`; no gate)
*Hand-off: stamp `game_moment` into assistant-message metadata at the persist site — the seam
already stamps `phase="casting"` pre-game (`routes/chat_routes.py` ~1457) and carries a
server-minted ts via the ADR-0012 `message_saved` event; the render hook is `roleTimestamp()`
(`chatRenderer.js` ~825) — prefer `metadata.game_moment`, demote the wall clock to `title`.
The moment string comes from the engine status the FE already fetches (week/phase/time-of-day).*

Source: audit B5 (wall-clock "12:35 PM" inside the fiction). Depends: M1-2 (clock live).
- **DoD:** transcript messages stamp the game moment ("Week 1 · Eviction Night · Late night")
  with the real clock demoted to hover/metadata; pre-game (casting) keeps neutral stamps; render
  contract test for the stamp source; no engine change (the moment is already in state).

### M2-7 · Rename the reasoning surface diegeticly — S · `P3` · PARTIAL (beat chips = "📋 Production notes" in `orwellToolBeats.js`; the reasoning **accordion** header + Settings copy still read "View thinking process" — `markdown.js:561`, `chat.js:1872` — and there is no gate)
Source: audit B8 ("View thinking process"; Settings "Show <think> collapsible bars").
- **DoD:** accordion label + settings copy renamed ("Production notes" family), admin surfaces
  keep the technical wording; the P1 owner ruling (collapsed-by-default, debug-viewable, scrubbed
  public reply) untouched — the existing browser-smoke thinking-split block still green.

### M2-8 · Curate the game build's theme list — S · `P3` · PARTIAL (the J1-06 tuck exists — game build shows house themes first + hides the rest behind "Show all themes" in `theme.js` ~1516 — but "Show all themes" still lists GPT/claude/etc; the DoD asks for a curated **allowlist** with a source gate, which is absent)
Source: audit B6 (`r-11` — "GPT", "claude", "organs", "cute" inside the fantasy).
- **DoD:** game build's "Show all themes" lists only the curated on-brand set (core six +
  approved extras); Customize stays for power users; dropped themes remain available outside the
  game build; pytest source gate on the game-build theme allowlist.

### M2-9 · Idle send button stops announcing "New chat" — S · `P3` · OPEN (decision-mode aria is fixed — `chat.js:3197` sets "Send answer" — but the idle-mode composer control aria is unaddressed; no a11y gate added)
Source: audit B10 (`aria-label="New chat"` on the composer's primary control in idle mode).
- **DoD:** the send control's accessible name reflects its action in every mode; the session
  guard's New-Chat protection unaffected; a11y assertion added to the browser smoke.

---

## Wave M3 — faces in the flow (idea catalog 1–6)

### M3-1 · The room strip — S · `P1` · ✅ DONE (evidence: `frontend/static/js/orwellRoomStrip.js` + `frontend/tests/test_m3_1_room_strip.py`, green)
Source: idea 1 (presence chips above the composer from `whereabouts.present`). Depends: M2-2.
- **DoD:** a slim strip of portrait chips for the player's current room, dimming on exit, 🌙 on
  turned-in, role badges via M2-2; updates on the existing poll + `orwell:gamechanged` (no new
  dispatcher); collapses gracefully pre-game and on narrow viewports (responsive matrix case);
  Vault-free proof (renders only the whereabouts projection); ADR 0003 note in-PR (augments, no
  click-to-act beyond M3-6's dossier door).

### M3-2 · Speaker-attributed dialogue (the microformat) — M–L · `P1` · ✅ DONE (evidence: `frontend/tests/test_m3_2_speaker_chips.py`, green; shipped PR #1251, commit c1b6ba1, golden fixture regenerated in the same PR)
Source: idea 2 (the deepest version of the owner's faces idea). Depends: M2-2.
- **DoR:** microformat decided (recommend inverting the existing `npc:<id>` scrub: a sanctioned
  well-formed speaker tag renders as a face chip; malformed still scrubs); **five-place FE wiring
  rule acknowledged** — the prompt change and FE render land in the SAME PR (the c13 lever-drift
  lesson, three occurrences now).
- **DoD:** narration quoting an NPC shows their chip in the bubble gutter beside the line;
  absent/malformed tags fail open to today's plain prose (render-contract test driving
  `markdown.js` with tagged, untagged, and malformed fixtures); `test_c13_lever_drift` green;
  the game-build scrub still redacts raw ids (existing gate); golden fixture regenerated in the
  same PR if the narrator prompt changed (0108 rule).

### M3-3 · One-on-one scene header — M · `P2` · OPEN (no scene-header code; no gate)
Source: idea 3 (DM-style header when a scene is you + one houseguest). Depends: M2-2, M3-1.
- **DoD:** when `whereabouts` (or the auto-record `withIds`) resolves a two-person scene, the
  chat header morphs to portrait + name + public status, dissolving on room change; never blocks
  or replaces chat input (ADR 0003); Vault-free proof; browser-smoke state-transition check.

### M3-4 · Faces on decisions — S · `P1` · ✅ DONE (evidence: `frontend/tests/test_m3_4_decision_faces.py`, green; portrait/monogram person options in `orwellDecision.js`)
Source: idea 4 + audit's text-only eviction vote. Depends: M2-2, pairs with M1-4.
- **DoD:** nominee/vote/houseguests-choice options render as portrait buttons (monogram
  fallback); the finale jury reveal rows carry faces; pick-count/binding semantics byte-identical
  (C20 gates untouched); responsive matrix covers the face-button grid on the phone profile.

### M3-5 · The player's own face — S · `P2` · OPEN (no player-face-on-"You"-bubble / board-You-row code; no gate)
Source: idea 5 (headshot exists; the player is the only faceless person in the house).
- **DoD:** the casting headshot/avatar renders on "You" bubbles and the board's You row (initial
  monogram fallback); no layout shift when absent; screenshot pair in PR.

### M3-6 · Every face is a door — S · `P2` · OPEN (`OrwellDossier.open` is wired only from `orwellCast.js`, not from every portrait chip across strip/cards/slates; no shared click handler; no gate)
Source: idea 6 (one interaction rule). Depends: M4-1 (dossier exists), M3-1/M3-4/M3-5.
- **DoD:** every portrait chip anywhere (strip, cards, cast window, slates) click-opens that
  houseguest's dossier; one shared handler; keyboard-operable with an accessible name; asserted
  once in the browser smoke over a representative chip in each surface.

---

## Wave M4 — surface the invisible game (audit lane C + ideas 7–16)

### M4-1 · Houseguest dossier view — M · `P1` · ✅ DONE (evidence: `frontend/static/js/orwellDossier.js` + `frontend/tests/test_m4_1_dossier.py`, green)
Source: audit C4 + idea 12 (cast tiles are dead ends; witnessed-behavior ledger).
- **DoR:** content contract fixed: public persona + met/last-seen + **witnessed** history beats
  + public alliances/deals with the player — facts and sources ONLY, never a weight/number
  (Vault Wall; the player forms their own reads).
- **DoD:** cast-window tiles (and M3-6 chips) open the dossier window (OrwellWindow kit — F-3
  ratchet); every rendered line traces to the player's witness set or public projection, proven
  by a leak test templated on the casting-leak gate; empty states designed ("You haven't crossed
  paths yet"); paging replaced by a full grid in the cast window (audit C4's 2×2 dots finding).

### M4-2 · The Memory Wall (knowledge journal) — L · `P1` (the flagship) · ✅ DONE (evidence: `frontend/static/js/orwellMemoryWall.js` + `frontend/tests/test_m4_2_memory_wall.py`, green; PRs #1288 fact-line unify, #1294 WS poll-cancel)
Source: audit C1 (`getVisibleStateFor`/`sealedFromHouse`/confidences have no surface).
Depends: M4-1 (shares the fact-rendering component).
- **DoR:** projection audit first: confirm the engine's knowledge read returns fact + pathway +
  (qualitative) confidence per entry Vault-free; any gap becomes an engine-side spec item BEFORE
  FE work starts.
- **DoD:** a kit window listing what the player knows, grouped by houseguest/week, each fact with
  its pathway ("Deja told you, Week 2 — secondhand"); distorted beliefs render as *beliefs*
  (source + qualitative confidence), never truth-flagged; zero numbers; the leak gate proves the
  whole window renders only player-held knowledge; sidebar entry beside Cast; recall parity
  sanity check (journal content survives reload/restart — the 0007 non-degradation promise made
  visible).

### M4-3 · Recap affordance — S · `P2` · OPEN (no composer/rail recap chip that sends a "Previously, in the house…" prose turn; `dailyRecap`/`seasonRecap` remain silent model beats with no player-facing affordance; no gate)
Source: audit C2 (`dailyRecap`/`seasonRecap` are model-called silent beats; players can't ask).
- **DoR:** ADR-0003 shape confirmed: the affordance *asks the narrator* (a prefilled prose turn
  "Previously, in the house…"), never renders engine text directly.
- **DoD:** a rail entry/composer chip sends the recap request through the normal chat path; the
  model's recap lands as narration (dailyRecap stays a silent beat); works pre-noms and
  post-eviction; discoverability copy in the house handbook (M4-4); browser-smoke click-through.

### M4-4 · The house handbook + first chat hints — S · `P2` · OPEN (the `OrwellChatHint` **registry** exists in `orwellChatHint.js` but ships empty — no handbook window and no registered contextual hints; no gate)
Source: audit C3 + idea 14 (fifty verbs, zero discoverability; `OrwellChatHint` ships empty).
- **DoR:** the verb list drawn from `PLAYER_TOOLS`' player-meaningful subset (deals, alliances,
  confide, confront, trade/expose secrets, turn in, ask the producers, self-eviction), written
  as diegetic prose — no tool names.
- **DoD:** a one-page handbook window reachable from the premiere card + sidebar; 3–5 contextual
  hints registered in the existing `OrwellChatHint` registry (e.g. first lull → "you could pull
  someone aside"), each dismissible and once-only; hints keep the empty-registry default OFF the
  non-game build; pytest for hint registry gating.

### M4-5 · Casting file gadget — S · `P2` · OPEN (no casting-file rail gadget consuming the 0050 casting-status projection; no gate)
Source: audit C5 (0050 status exists engine-side; the interview flies blind).
- **DoD:** during casting the rail shows the file (Name ✓ · Backstory … · Motivation … ·
  Headshot …) straight from the casting-status projection; it disappears at season start;
  fail-open when the engine is down; leak test (casting card only, no derived stats).

### M4-6 · Ceremony slates — M · `P1` · ✅ DONE (evidence: `frontend/tests/test_m4_6_ceremony_slates.py`, green; slate rendering from engine truth in the tool-beat/slate path)
Source: idea 7 (closed-set beats render as designed full-width cards). Depends: M2-2, M2-5.
- **DoR:** slate set fixed (HOH win / nominations / veto win / veto ceremony / eviction result /
  week roll), each rendered FROM ENGINE TRUTH (the tool-result/beat payload), never parsed from
  prose (ADR 0005 closed-set rule).
- **DoD:** each beat inserts a slate card into the transcript (portrait, name, role line) beside
  the model's narration; slates render identically on reload from persisted state; F1 parity
  (mirror window shows the same slate — extend the mirror harness assertion); Vault-free proof;
  reduced-motion respected.

### M4-7 · Episode title cards — S · `P3` · OPEN (no episode-title slate; no `EPISODE N — …` render path; no gate). Depends on M4-6 (done) + M2-6 (open).
Source: idea 8. Depends: M4-6 (shares the slate component), M2-6.
- **DoD:** week/day transitions render a title slate ("EPISODE 4 — *The Backdoor*"); the title is
  one utility-model call, fail-open to "Day N" (no model ⇒ plain); never blocks the transition.

### M4-8 · Point scene stills at the big beats — S · `P3` (config-gated) · OPEN (no HOH/eviction-slate scene-still request via `recordImageBeat`; no slate-composed still; no gate)
Source: idea 10 (0051 image beats exist). Depends: M4-6.
- **DoD:** with an image provider configured, HOH/eviction slates request one still via the
  existing `recordImageBeat` budget-capped path, composed under the slate; zero-provider install
  renders slates without gaps; budget caps (`imageConstants.ts`) respected — no new spend class.

### M4-9 · Deals & alliances board, verified and first-class — S–M · `P2` · PARTIAL (a **pre-existing** read-only deals tracker `orwellDeals.js` = feature 0039 exists; missing DoD: no deal **duration** (0104), no **named alliances** (0107), no visible expiring/dissolving; no `test_m4_9`)
Source: audit C7 + idea 13 (`state.deals` ships; mid-season rendering unverified).
- **DoR:** one real-model mid-season pass (piggyback M0-3's live session) confirming what
  `orwellDeals.js` renders when deals/alliances actually exist — findings recorded before scoping.
- **DoD:** the gadget shows deals you shook on (with duration — 0104 deal-duration data) and
  named alliances you're in (0107 projection), each expiring/dissolving visibly; nothing beyond
  the public/party-to projection (leak test); rail registry row per the kit contract.

### M4-10 · Endgame sequence instead of a window pile — M · `P2` · OPEN (no post-finale one-at-a-time sequence orchestration; the finale/retrospective/new-season surfaces exist independently but are not sequenced; no gate)
Source: audit C7/endgame (`r-6` — retrospective + season-complete + photo studio stacked scrimless).
- **DoD:** post-finale surfaces open as a sequence (finale board → retrospective → next-season
  hand-off), each dismissible, one at a time, kit-modal stacking rules obeyed (#870 invariants);
  browser-smoke asserts no two post-finale windows overlap on auto-open.

### M4-11 · Episodic retrospective — M · `P3` · PARTIAL (a **pre-existing** retrospective `orwellRetrospective.js` = feature 0048 exists with per-week evictee lines + highlights; missing DoD: no headline-first grouping of blindsides/flipped-votes/goodbye-tones and no vote-by-vote-behind-expanders; no `test_m4_11`). Depends: M4-10 (OPEN).
Source: audit C6 (`r-6` — the 0048 payoff as ~40 uniform bullets). Depends: M4-10.
- **DoD:** the retrospective groups by week with headline beats first (blindsides, flipped votes,
  goodbye tones) and vote-by-vote detail behind expanders; unsealing scope unchanged (post-finale
  gate only — 0048's code-gated path untouched); Vault-unseal legitimacy test still green.

### M4-12 · Board polish: You-row, Last out, Nightfall dupe — S · `P3` · OPEN (no dedicated gate; polish items unverified on main)
Source: audit C8 (`r-3` — cue collision "· running on empty You vote tonight", "Last out —"
through an eviction, moon+word repeated).
- **DoD:** You-row cues separate cleanly at every width (matrix case); "Last out" names the
  evictee from the beat that commits it (or the row hides untilweek 2 if that's the engine
  contract — verified, not assumed); Nightfall card title/body de-duplicated.

### M4-13 · Shareable episode card export — M · `P3` · OPEN (no export compositor; no gate). Depends: M4-7 (open), M2-2 (done).
Source: idea 15. Depends: M4-7 (title), M2-2 (portraits).
- **DoR:** owner OK on the export composition (title, three beats, portraits, season branding) —
  note P-1 naming dependency for any wordmark on the card.
- **DoD:** "Save episode card" renders the recap into a downloadable image entirely client-side
  (no external service — content stays local); the card contains only player-known facts (leak
  test over the composition input); export works with monogram portraits.

### M4-14 · Season poster — S · `P3` · OPEN (no season-poster compositor; no gate). Depends: M4-13 (open), M4-10 (open).
Source: idea 16. Depends: M4-13 (shares the compositor), M4-10.
- **DoD:** post-finale, the retrospective opens under a composed season poster (winner + cast +
  weeks); downloadable via the M4-13 path; monogram-complete without an image provider.

### M4-15 · Player help + in-app problem report — S · `P3` (owner: nice-to-have) · PARTIAL (the `POST /api/orwell/fe-report` ring client `orwellReport.js` exists; missing DoD: the "Report a problem" **entry-points** in settings + the engine-degraded banner and the rate-limit copy are unverified/unwired; no gate). Depends: M4-4 (OPEN).
Source: market #8. Depends: M4-4 (handbook is the "how to play" half).
- **DoD:** a "Report a problem" entry (settings + engine-degraded banner) posts a player note to
  the existing `POST /api/orwell/fe-report` ring with the current session id attached — admin
  sees it on /admin/status beside the G11 failures; no new backend surface; rate-limited
  client-side like the ring; copy names where the operator reads it.

---

## Reconciliation note (2026-07-13)

Source-audited every item against `main` (code surfaces + the `frontend/tests/test_m*.py` gate:
**270 passed, 1 skipped**). Method per CLAUDE.md ("trust the code over prose"): a passing
dedicated `test_m<W>_<N>_*.py` + the named surface = **built**; a pre-existing surface that does
not meet the M-item DoD = **partial/open**; no surface + no gate = **open**.

**Items the stale 2026-07-08 header wrongly reported as "not started" / not-shipped — they are
built + green on `main`:**

- **M2-3** (premiere cast strip) — header said "NEXT"; in fact BUILT, `test_m2_3_premiere_strip.py`
  14/14 green.
- **M3-1** (room strip), **M3-2** (speaker chips; PR #1251, commit `c1b6ba1`), **M3-4** (faces on
  decisions) — the whole "Wave M3 — not started" claim was wrong; 3 of 6 are shipped with gates.
- **M4-1** (dossier), **M4-2** (Memory Wall — the flagship; PRs #1288, #1294), **M4-6** (ceremony
  slates) — "Wave M4 — not started" was wrong; 3 of 15 are shipped with gates.

**OPEN (no surface, no gate):** M0-6, M2-6, M2-9, M3-3, M3-5, M3-6, M4-3, M4-4, M4-5, M4-7,
M4-8, M4-10, M4-12, M4-13, M4-14. **PARTIAL (surface exists, DoD not fully met):** M2-7 (beat
chips renamed, accordion/settings copy not), M2-8 (J1-06 tuck, not the allowlist DoD), M4-9
(pre-existing 0039 deals tracker, no duration/alliances), M4-11 (pre-existing 0048 retrospective,
not the headline/expander restructure), M4-15 (`orwellReport.js` ring client exists; entry-points
unverified). *(M0-6 is the one M0 residual — an OPEN docs/config reconcile blocked on the owner
DoR.)*

**Built-on-`main`-but-tracker-may-still-be-open (for the lead to close):** the roadmap dispatches
work as GitHub issues referencing these M-ids, so each *built* M-item above likely has a tracking
issue still open. History is squash-merged, so most implementing shas aren't cleanly traceable;
the citable ones from `git log`:

- **M3-2** — speaker-attributed dialogue, fixing commit `c1b6ba1` ("M3-2: speaker-attributed
  dialogue (the chip microformat) + golden fixture regen (#1251)").
- **M4-2** — Memory Wall, follow-on commits `063f218` (#1288, fact-line unify) + `7764eb4`
  (#1294, WS poll-cancel).
- **M2-3, M3-1, M3-4, M4-1, M4-6** — built + gated on `main` (dedicated `test_m*` files green);
  implementing shas obscured by the #1523 R3-PR5 refactor rewrite, so no clean single sha to cite
  — verify the tracking issue by M-id and close on the passing gate.

*(No GitHub API was called for this reconciliation — the above is git-log evidence only; the lead
should confirm issue numbers before closing.)*

## Parked (owner-owned decisions — not scheduled; cheap prep only)

### P-1 · IP / naming (Big Brother vocabulary + the "Orwell" collision) — OWNER
Prep task available on request: a vocabulary inventory sweep (every trademark-adjacent string
across prompts, FE copy, theme names, docs) sizing the rebrand before the decision. M2-5
deliberately isolates the transcript author name behind one constant for this reason.

### P-2 · Who pays for inference (BYOK vs hosted) + unit economics — OWNER
Prep task available on request: the cost-per-season instrument — a read-only harness over the
0069 token ledger emitting $/season for N real seasons. No product change; feeds the pricing
decision whenever taken. *(Partially fed by M0-1: the GLM 5.2 + Qwen record run produces the
first real cost-per-week number from the token ledger; the owner's local-Qwen posture drops the
utility tier's marginal cost to ~zero in production.)*

---

*Excluded by owner triage (2026-07-07): demo/trailer, re-engagement/push, player cost caps,
content-tone controls, hosted-scale ops (Postgres tier, billing, telemetry, cloud backup,
monitoring), a11y conformance statement, i18n declaration, store packaging. Revisit only on an
explicit owner call — none of these blocks the waves above.*
