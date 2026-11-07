# Open-items verification campaign (2026-06-21)

**Mode:** read-only verification of every tracked open item against the *current source* (not the
trackers' prose). **Why:** an exhaustive open-items aggregation found the trackers
(`CLAUDE.md`, `docs/features/README.md`, `UX-AUDIT-LOG.md`, `AUDIT-LOG.md`,
`docs/audits/2026-06-21-window-system-scope.md`) are **substantially stale** — a large fraction of
items marked "open"/"owed" have shipped. This doc records the reconciled truth and is the
authoritative current-status snapshot as of 2026-06-21. Items are grouped by the tiers used in the
aggregation. Each verdict carries file/test/commit evidence in the body (summarized here).

> **Headline:** there are **no launch-blockers left**. The named launch-blocker (cast-photo a11y,
> J1-25) and every critical engine / anti-sycophancy / sync / FE-signal item are **built and
> test-pinned**. What remains is: an ADR-0010 token-economy cluster, owed *verification runs* (not
> code) for the live mirror/concurrency, the post-launch refactor roadmap
> (`docs/REFACTOR-ROADMAP.md` R1–R7), a low-severity UX-polish tail, and the one hardware-gated
> Proxmox host smoke.
>
> **F5 RE-FLAGGED THEN CLOSED (2026-07-09):** the "no launch-blockers left" headline briefly failed
> on F5. On 2026-07-09 the F5 mirror-parity harness
> (`docs/audits/playtest-harness/mirror_live_parity.mjs`) was **executed on current main and found
> RED** — it exited 1 on `bUsesIncrementalRenderer`, a render-race regression — so F5 was momentarily
> the sole launch-blocker (re-verification `docs/audits/2026-07-09-ship-gate-reverification.md`, PR
> #1269). **RESOLVED the same day by PR #1276 (`fa60f70c`):** the render race was fixed AND the harness
> gate was **wired into CI as a required check** (runs in `ci-gate`), so F5 is now proven green on
> every PR rather than by manual run. **F5 is no longer a launch-blocker** — the "no launch-blockers
> left" headline stands again. (Reconciled 2026-07-10.)

## Tier 1 — Critical / launch-blocking → **CLOSED**

| Item | Verdict | Evidence |
|---|---|---|
| **J1-25** cast-photo a11y (the launch-blocker) | ✅ DONE | per-window `modal:true` (scrim + focus-trap + `inert` + `aria-modal`), `orwellWindow.js`; applied `orwellHeadshot.js:424`; `test_f_window_kit.py` + `browser_smoke.py`; commit `f6b9b13`. |
| **J3-05** fictional-HOH anti-sycophancy | ✅ DONE (mitigated) | pre-emission outcome guard `chat_helpers.py:928` / `_pre_emission_outcome_guard` `agent_loop.py:2305`; `test_0065_pre_emission_guard.py` (incl. `test_phantom_winner_is_held`); PR #434. |
| **J4-05 / J4-06** progression stall | ✅ DONE (mitigated) | stall-nudge `_ADVANCE_NUDGES` + L39b forced-advance `_FORCED_ADVANCE_NUDGE` (`agent_loop.py`); `test_orwell_advance_stall_nudge.py`; PR #434. |
| **J3-06** premiere meet-everyone belt | ✅ DONE | `_auto_mark_premiere_intros` `agent_loop.py:1940` (wired `:3841`); anonymous-owner soft-lock fixed; `test_premiere_meet_everyone.py`. |
| **J4-18 / J3-12** engine-stall FE signal + decision card | ✅ DONE | server-side loop-breaker `agent_loop.py:4218`; decision card re-arms on boot via `/api/orwell/status` `orwellDecision.js:525`; tests pinned. |
| **S3-LOOP / ADR 0011** two-tab agent-loop spin | ✅ DONE (core) | beat-aware guardrail `agent_loop.py:1573` + gate `:3910`; `test_adr0011_concurrent_loop.py` (16 tests); commit `72d9e0b` / PR #497. |
| **R2-02** eviction-night belt | ✅ working-as-designed | one-beat-per-turn `_pre_resolve_npc_ceremony`; classified NOTE in ledger. |

**Tier-1 residual (minor):** J1-30 in-universe "producers" pre-token copy (generic spinner exists);
ADR-0011 deferrals (a) loop-breaker aggregate total-cap, (b) suppressed round-bubble *unmount*.
**Caveat:** the anti-sycophancy/stall items are LLM under-call error-correctors — CI stubs the LLM, so
tests source-pin the wiring; real-model confirmation came from the manual R1/R2/R3 probes.

## Tier 2 — Forward strategic / product

**Already shipped (trackers stale):** 0062 zeitgeist FE wiring (`orwell_zeitgeist.py`, `c407e47`) ·
0051 browser-smoke render (`browser_smoke.py:1166`) · 0057 live browser validation
(`browser_smoke.py:1197`) · **0059 hidden seeded relationships** (`seededRelationships.ts`,
`seededRelationships.test.ts`) · G12 soul-write breathing (`SoulStore.ts`, `burstBreathing.test.ts`) ·
calibration (`gameRespect=0.7`, `juryManagementWeight=0.1`, `EARNED_WINS` gate) — nothing pending ·
A4 private-repo PAT scripts.

**Genuinely open:** 0010 real-Proxmox host smoke (hardware-gated; also clears 0067/0068 host-smoke) ·
R3 deep O(Δ) export/`isSuperset` rewrite (partially mitigated: WeakMap memo + per-user export cache
shipped; export still O(events) per mutation — self-flagged `sessionSnapshot.ts:266`) · 0066 tuning
(flip `ORWELL_TIME_OF_DAY` default; magnitudes).

**Deferred-by-design (no action):** 0022 (MVP-2; plumbing shipped, player-read cards need ADR-0002
redesign) · Postgres + pgvector (MVP-002) · ADR 0006 Phase-2 (next-day / multi-night / per-conversation
fatigue — PO review list) · 0059 organic pathway-surfacing depth follow-on.

## Tier 3 — ADR open questions & tuning

**Confirm-only / resolved-by-build:** 0007 #1 edge gate (deploy dashboard, out of code scope) ·
0009 engine occupancy double-buffer (FE-freeze shipped #469; double-buffer deferred-not-rejected) ·
0001 emotional volatility/mean-reversion (tuning only) · 0002 NPC→player edges (DONE,
`consequence.test.ts`).

**Genuinely open (cluster = token economy + live-mirror verification):**

| Item | Verdict | Remains |
|---|---|---|
| 0007 #2 session TTL | 🟡 PARTIAL | logout revocation built; shorten the 7-day TTL (`auth.py:50` + cookie `max_age`). |
| 0010 #1 per-class `max_tokens` runtime-editable | ✅ DONE (2026-07-10) | shipped — `max_tokens_budget` (a `{call_class: value}` override) is admin-editable at runtime beside `reasoning_budget`, resolved from the settings dict in `frontend/src/token_policy.py` (`resolve_token_policy` + `max_tokens_bounds`). |
| 0010 #2 model-aware reasoning sizing + fold Anthropic 8192 | 🔴 OPEN | effort-only; 8192 hardcoded `llm_core.py:718`. |
| 0010 #3 `appliedMaxTokens` + `finishReason` in the ledger | ✅ DONE (2026-07-10) | shipped — both fields are now recorded in the token *ledger* itself (`frontend/src/orwell_token_ledger.py`: the entry schema + `_clean_int(applied_max_tokens)` / `_clean_id(finish_reason)`), `appliedMaxTokens` = the OUTPUT cap actually sent on the wire (the ADR-0010 #1 per-class value). |
| 0010 #4 `Continue ▸` in chat mode | 🔴 OPEN (non-blocking) | truncation event agent-mode only. |
| 0008 #5 live two-tab real-model re-run | 🔴 OPEN | server-layer gated; live run owed; harness `s3raceloop.mjs` doc-only. |
| 0012 #6 mid-gen-join splice pinned | 🟡 PARTIAL | mechanism dup/drop-safe `agent_runs.py:205`; only finished-run replay tested. |
| 0012 #7 buffer retention knob | 🟡 PARTIAL | built as constant `_EVICT_GRACE_S=180`; not exposed. |
| 0012 #8 live-LLM two-window CI cadence | 🔴 OPEN | no CI gate; manual harness; cadence decision unrecorded. |

## Tier 4 — Window/overlay refactor (`window-system-scope.md`)

| Step | Verdict |
|---|---|
| A1 per-window modal option (closes J1-25 + scrim cluster) | ✅ DONE (`f6b9b13`) |
| A3 reset-positions sweep (closes settings F3) | ✅ DONE (`settings.js:1765`) |
| A0 delete ~700 lines dead `modalManager` chain-physics | 🔴 OPEN (still present, no-caller confirmed) |
| A2 single z/focus authority (closes DWE F9) | 🔴 OPEN (kit `_zTop` still split from `ui.js _zCounter`) |
| B unify free-windows + gadget rail (J2-09/04/05) | 🔴 OPEN — next milestone, no code |
| C full `.modal`→kit (W15) migration | ⏸ DEFERRED — "do not attempt" |
| P6 consolidate 6 poll/backoff loops | 🔴 OPEN (low) |

## Tier 5 — UX-AUDIT-LOG backlog (verified; ledger markers stale in places)

Net of the ~62 findings verified: **~18 DONE · ~10 PARTIAL · ~34 OPEN**; the open set is almost
entirely **low-severity Phase-4 polish / a11y / IA** (no functional blockers).

**Stale-in-ledger → actually DONE:** J3-16, J3-17, **J3-18** (focus-on-mount, `e461139`),
**R2-01** (re-tap no-op, `c7ff13d`), **J2-07** (shared cue seam), **J3-21** (`msg-ooc` demarcation,
L36), **J3-24** (aria-hidden emoji, `fef04af`), J1-02 (#492), J1-22/J2-14 (game-build strip),
J3-25, J3-09, J3-11, J2-11, J1-32, J1-14, J2-04, J1-11 (re-measured: not a defect).

**Open clusters (low-sev):** decision-card copy/affordances (J4-17/20/26/04/07/19/21/28, J3-22/23,
J5-22) · wayfinding (J3-07/08, J3-13) · premiere motion/visual (J2-10, J1-20, J2-13, J2-15, J2-18,
J3-15) · welcome polish (J1-09/10/31) · theme/settings IA (J1-06 picker still shows all 21 themes,
J1-07, J1-15, J1-17, J1-19[by-design], J1-24, J1-33, J1-12) · cast IA (J2-05, J2-06, J2-09, J3-19,
J3-20) · contrast misses (J2-16 coral `--accent`=eviction-red, J2-17 headshot CTA missed the
`--on-accent` sweep) · J1-30 producers copy.

**Verify/ruling:** J5-23 NOFIX (design ruling) · R5-02 (KEEP-path zero prior-season knowledge —
deterministic check owed) · R7-01 (season-2 casting rig gap).

## Tier 6 — AUDIT-LOG S-series + architecture latents

Most genuinely-open latents are filed **POST-LAUNCH in `docs/REFACTOR-ROADMAP.md` (R1–R7)**; the
close-out verdict is *none is a launch-blocker*.

**DONE:** A-S5 (stale-409 now structured `{code,beatSeq,board}`, prose=fallback) · F-S4-C (mid-stream
errors surfaced `e065f1f`) · S1-1L.
**Highest-value open:** **A-S3** — a stale-409 on `recordInteraction`/`makeDeal`/`moveTo` hard-drops
the scene's only consequence fold (`agent_loop.py:1711`, "Do NOT retry"); mandate-#4 tension; tracked
R1c. Then A-S4/D2 (`gamechanged` 7-name allowlist vs `PLAYER_TOOLS`, masked by a turn-end catch-all),
A-render (chat.js vs chatRenderer.js drift, R2), S1-D (no shared poller), F-S2-B (2 console 404s),
reasoning-channel-split, OBS-8, State-5 (out-of-scope-for-launch).

## Tier 7 — refresh/settings residue → **CLOSED** (window-scope P7 was stale)

Refresh-persistence F1–F5 (F7 surface removed) and settings-wiring F1–F4, F6 all **shipped** with
source-pinned tests (`test_g16_refresh_fixes.py`, `test_g17_composer_draft.py`,
`test_s1s2_settings_wiring.py`). **Only open:** settings-wiring **F5** (3-way keybind default-table
drift, LOW, open by explicit product decision).

## Tier 8 — Doc hygiene (this campaign's corrections)

Corrected here / in this commit: `README.md` 0051 & 0057 rows (owed→Built); `CLAUDE.md` 0059
"spec only" (it is Built) + feature range (now 0069); `UX-AUDIT-LOG.md` stale OPEN cells
(R2-01/J2-07/J3-18/J3-21/J3-24); `window-system-scope.md` P5/P7 (settings F3 + refresh R3 shipped).
Standing: O-2/O-6 calibration-artifact hygiene (write instrument output to a gitignored path).

## Tier 9 — Code-level

Dead `modalManager` chain-physics (~700 lines, refactor A0) still present; otherwise clean (no real
TODOs, empty XFAIL registry, one opt-in test skip `fastembedReal.test.ts`).

---

## Consolidated genuinely-open work (after verification)

> **GitHub issue tracking (added 2026-06-23).** The items below are now filed as GitHub issues
> (labelled `type:*`/`area:*`), except where noted "doc-only" (deferred-by-design or not yet
> scheduled):
> 1. ADR 0010 token-economy (4) → [#572](https://github.com/Psychout-Media/orwell/issues/572).
> 2. Live-mirror/concurrency verification (ADR 0008/0011/0012) → **doc-only** (owed manual runs/pins).
> 3. Architecture latents R1–R7 → **A-S3** = [#591](https://github.com/Psychout-Media/orwell/issues/591); rest **doc-only** (`REFACTOR-ROADMAP.md`).
> 4. Window refactor (A0/A2/B) → [#573](https://github.com/Psychout-Media/orwell/issues/573).
> 5. UX Phase-4 polish (~34) → [#606](https://github.com/Psychout-Media/orwell/issues/606).
> 6. Ops: Proxmox host smoke → [#577](https://github.com/Psychout-Media/orwell/issues/577); A4 private-repo flip → [#579](https://github.com/Psychout-Media/orwell/issues/579).
> 7. Perf: R3 O(Δ) export → **doc-only** (late-season only).
> 8. Tuning/small: session TTL → [#581](https://github.com/Psychout-Media/orwell/issues/581); `ORWELL_TIME_OF_DAY` default → [#583](https://github.com/Psychout-Media/orwell/issues/583); J1-30 → [#606](https://github.com/Psychout-Media/orwell/issues/606); settings F5 → [#586](https://github.com/Psychout-Media/orwell/issues/586).
> 9. Deferred-by-design: ADR 0006 Phase-2 → [#604](https://github.com/Psychout-Media/orwell/issues/604); 0059 follow-on → [#605](https://github.com/Psychout-Media/orwell/issues/605); 0022 + Postgres+pgvector = **doc-only** (deferred).
> 10. Doc hygiene → **doc-only**.

1. **ADR 0010 token-economy (4 → 2 remaining):** ~~per-class `max_tokens` runtime-editable~~ **DONE
   (2026-07-10, `token_policy.py`)** · model-aware reasoning sizing + fold the Anthropic 8192 stopgap ·
   ~~`appliedMaxTokens`+`finishReason` into the ledger~~ **DONE (2026-07-10, `orwell_token_ledger.py`)** ·
   `Continue ▸` in chat mode. **Still open: #2 (model-aware reasoning sizing) + #4 (`Continue ▸`).**
2. **Live-mirror/concurrency verification (mechanisms built; pins/manual runs owed):** ADR 0008 live
   two-tab real-model re-run · ADR 0012 mid-gen-join test pin + retention knob + CI-cadence decision ·
   ADR 0011 (a) loop-breaker total-cap + (b) bubble unmount.
3. **Architecture latents — `docs/REFACTOR-ROADMAP.md` R1–R7 (post-launch):** **A-S3** (dropped
   consequence fold — highest value, mandate #4), A-S4/D2, A-render, shared poller, etc.
4. **Window refactor:** A0 (dead-code delete), A2 (single z/focus authority = DWE F9), B (rail
   unification); C deferred.
5. **UX Phase-4 polish (~34):** motion/staging, wayfinding (incl. J1-06 theme scope), decision-card
   copy/affordances, contrast misses (J2-16/J2-17).
6. **Ops:** 0010 real-Proxmox host smoke (hardware-gated; clears 0067/0068) + A4 private-repo flip.
7. **Perf:** R3 deep O(Δ) export/`isSuperset` rewrite (self-flagged; late-season only).
8. **Tuning/small:** shorten 7-day session TTL · flip `ORWELL_TIME_OF_DAY` default · J1-30 producers
   copy · settings F5 keybind defaults.
9. **Deferred-by-design (no action):** 0022 · Postgres+pgvector · ADR 0006 Phase-2 · 0059 depth
   follow-on.
10. **Doc hygiene:** keep `CLAUDE.md`/README/ledger reconciled; O-2/O-6 calibration artifacts.
