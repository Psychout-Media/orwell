# 2026-07-03 — Product-review fix ledger (10 parallel domain sweeps, source-verified on main @ 88816c6)

**Method.** Ten parallel read-only specialist sweeps (narration/LLM-seam, distributed-consistency/two-window,
social-game/genre, UX flows, IA/wayfinding, interaction/feedback, content/a11y, visual/motion HIG-parity,
responsive/cross-platform, engine-architecture/perf/testing + security/ops/deploy), each cross-referencing the
full audit corpus (UX-AUDIT-LOG, ROAST-LOGs, BB-nerd synthesis, ship gate, refresh/settings audits) against
**current source** — every item below is file:line-grounded and every stale historical finding was re-verified
before listing. Roughly **100+ historical findings were verified ALREADY-FIXED** on main and are recorded as
such per domain (do not re-open them).

**Relationship to the final pre-ship audit (PR #1163, `docs/audits/2026-07-03-final-pre-ship-audit/`, ~969
findings / 39 lanes).** That corpus landed on main mid-review; this ledger was produced independently and
**corroborates it**: A3 = CONS/DRIFT/PUSH here; A4 = NAR-4; A9's family = the token-policy items; the
consistency lane (CON-1..22) matches the CONS/BIND/IDEM series. Treat the two documents as one body of work —
the pre-ship RANKED_MASTER_V2 carries the blocker ranking (A0–A10); this ledger adds source-verified
current-state statuses, the already-fixed roster, and additional items the 39 lanes did not carry
(e.g. the owner-keying belt-lattice hole NAR-1, the responsive-gate blindness RSP-1/RSP-2, the toast
severity cascade VIS-1, the folder-delete touch dead-end RSP-6).

**Executive priority (merged view):**
1. **A0 (pre-ship): the model-level knowledge wall** — NPCs omniscient of the whole chat incl. Diary Room. The single highest-value fix.
2. **NAR-1 (here): the owner-keying hole** — the reactive belt lattice is inert under `AUTH_ENABLED=false` (the local/live posture). This is also the "structural multiplier" the pre-ship audit names; one `_belt_key` sweep re-arms F14/L39b/NARR-3 single-tenant.
3. **A3 / the two-window mirror** — duplicate LLM responses + non-mirrored elements (CONS-4, DRIFT-1, PUSH-1, CON-1..22). A focused fix is in flight on this branch.
4. **A2+NAR-3: fabrication + identity-blind guard** — extend the eviction identity check to HOH/veto/nominee fresh-crown claims; make the guard reject the phantom SCENE, not one sentence.
5. **A4/NAR-4: reasoning re-emit** — pipe the empty-body re-emit through scrub + outcome guard (GLM makes this hotter).
6. **A9 + dark-feature activation + storyFacts delivery** (pre-ship quick-wins 1–3) — the biggest felt-quality jump per hour.
7. **ENG-1/NAR-6/SOC-I2: feature 0108** — the real-model golden-path gate; retires the whole "held-for-live" class and protects the GLM switch.
8. **SEC-1 (ops): rotate the owed live secrets** — standing P0 debt.

# Orwell — Master Fix/Improvement Compilation (in progress)
Legend: P0 launch/correctness · P1 high · P2 polish · P3 parked/owner-decision · (S/M/L effort)

## DOMAIN: UX Flows & Journeys (sweep complete; ~45 historical items verified ALREADY-FIXED on main)
OPEN items:
- FLOW-1 [P1/S] Nomination-identity outcome-guard gap (#561-class): guard checks nominee-set COUNT moved, never the NAMED nominee vs nomNames — wrong-nominee narration passes. Mirror _eviction_evictee_mismatch onto nomNames. chat_helpers.py:1222-1228.
- FLOW-2 [VERIFIED-FIXED on /decision route by ops sweep — orwell_routes.py:1091-1096 + dup-decision cache :163-169] DB1/DB2 retry storm. RESIDUAL → OPS ERR-1 (other routes still blanket-502).
- FLOW-3 [P1/S] KEEP-path relationship-isolation VERIFY: carried player must be a stranger to new cast; structurally plausible via resetUser but NO dedicated test asserts empty NPC→player edges post-KEEP. Add callTool-driven isolation test. GameSessionAdapter.ts:3356-3374.
- FLOW-4 [P2/M] F8: nomination ceremony never narrated for NPC HOH (engine self-advances past `nominations` moment same call; noms appear only in HUD). Generalize _eviction_reveal_steer into ceremony-narration belt. agent_loop.py steered set / liveSeason.ts:1402.
- FLOW-5 [P2/M] F5-premiere: gather ritual has no engine presence projection (houseEvent.kind lacks "premiere"; narration vs whereabouts contradict). GameSession.ts:997-1002.
- FLOW-6 [P2/M] UI-4 #534/#537: time-of-day HUD contradicts narration clock (timeOfDay not injected into renderGameContext). momentPrompts.ts.
- FLOW-7 [P2/S] J3-20: cast roster lacks per-name met/unmet state during premiere (aggregate counter exists). orwellCast.js + premiereIntros projection.
- FLOW-8 [P3/S] F13: Houseguest's-Choice veto chip collapsed in narration when NPC holds it. Strengthen veto-competition fragment. momentPrompts.ts:589-593.
- FLOW-9 [P3/S] J4-21/J-38: no ambient "decision pending" chrome indicator (2.5s repoll covers worst case).
- FLOW-10 [P3/S] J4-28/J-39: no signpost from decision card naming a houseguest → cast panel.
- FLOW-11 [P3/S] J5-22: one residual system-language error string ("your move wasn't allowed") — grep-confirm then fix.
- FLOW-12 [P3/M] J-49: /api/orwell/status pending served from in-memory cache; FE restart mid-decision + refresh shows no card until next turn. Fall back to live engine pending query.
- FLOW-13 [P3/S] J-37: post-confirm composer prefill still authors words (kind-specific now; owner taste call: empty box + placeholder?).
  - **Resolved 2026-11-25 (ORW-919, Coordinator ruling; F-NEW-5 amended):** the prefill is gone. A successful decision submit arms ONE hidden production cue (the ORW-771/924 kind: no player bubble, no clock charge, armed only by a success) and the page sends it, so the narrator voices the locked-in beat at once; the box stays empty, and a cue that cannot go out leaves it empty (never words sent for the player). F-NEW-5's purpose, "never speak for the player", is kept.
- FLOW-14 [P2/S] LEDGER#1 residual: live MOBILE re-verify of casting-skip fix still owed (keyed playtest).
- FLOW-15 [P3/S] J-1 residual: regression pin that holding-card + setup-wizard can't both show in a race.
- FLOW-16 [P3/S] J-29: exhaustive Continue▸ coverage sweep of every truncation/timeout branch (verify-only).
- FLOW-17 [P3/S] UI-2/#555 residual: standalone regression pin for progress-bar arithmetic post-#556 fix (verify-only).
- FLOW-18 [P2/S] J2-05/J2-09: mobile cast IA — roster behind hamburger exactly when most needed at premiere; 4 inconsistently-labeled "Cast" surfaces (Phase-4 backlog).
- FLOW-19 [P3/–] J1 cosmetic backlog still open per ledger: welcome-card sizing J1-10, dual theme paths J1-15, vocabulary drift J1-33. (NOTE: J1-06 theme-grid + J1-14 settings-default-tab verified ALREADY-FIXED by the wayfinding sweep — theme.js:1345-1373, settings.js:5742.)

## DOMAIN: IA / Wayfinding (sweep complete; W-1..W-10, W-21 + most J-items verified ALREADY-FIXED on main)
OPEN items (deduped vs FLOW):
- WAY-1 [P2/S] W-17: composer placeholder still "Message Orwell..." — no game-build guard at all; the one control used every turn breaks fiction. index.html:1241. (Missed by the game-build-guard sweep.)
- WAY-2 [P2/S] W-12 (=FLOW-10, upgraded to P2): "Who's this?" affordance from decision-card houseguest chips → OrwellGadgetRail.focusGadget('orwell-cast-pin') — seam already exists (orwellGadgetRail.js:807).
- WAY-3 [P2/S-M] W-16 (=FLOW-7): per-tile met/unmet badge on Cast roster during premiere; prem.remaining already available FE-side — render-time join.
- WAY-4 [P2/S-M] W-19 (=FLOW-9, upgraded): "● decision pending" badge on House Status gadget title when a dismissed-not-decided pending is outstanding.
- WAY-5 [P3/S] W-3 residual: 4px progress bar still visually unlabeled for sighted users at 0% premiere — add title/tooltip mirroring aria-describedby.
- WAY-6 [P3/S] W-11: mobile Settings/theme hamburger-gated (severity downgraded; cast half fixed by #gadget-rail-open). Optional first-run gear glyph.
- WAY-7 [P3/S-M] W-13 (NEW): two different parked-window destinations — #minimized-dock (sidebar, hamburger-gated on mobile) vs gadget-rail dock — "where did my window go" break. Needs owner ruling: unify or explain (post-action toast).
- WAY-8 [P3/S] W-15 residual: "Pinned Cast" vs "The Cast" relationship unexplained — tooltip or fold into one gadget with expand affordance.
- WAY-9 [P3/S] W-20 residual: defense-in-depth visible "still working" cue during any residual stall window.
- WAY-10 [P2/verify] Live re-verify owed: W-20 anti-sycophancy stall guards (3+ scenarios), W-14 time-of-day HUD vs narration clock. (W-22 #554 cast-pin cap: VERIFIED FIXED by flows sweep J-58 + interaction sweep IF-20.)

## DOMAIN: Interaction / Feedback / Cognitive Load (sweep complete; IF-01..07, IF-13..23, IF-27/28 verified ALREADY-FIXED)
OPEN items (deduped — IF-09=WAY-4 upgraded P1; IF-10=WAY-2; IF-24=WAY-3; IF-08=FLOW-13):
- INT-1 [P1/S] IF-11 (NEW): silent no-op when clicking a 3rd nominee chip past pick=2 on the NOMINATIONS card — no shake/hint/aria-live; chip still looks clickable; sync() not called. orwellDecision.js:497-503. Fix: reduced-motion-safe pulse + polite aria-live line in .odec-hint.
- INT-2 [P3/S] IF-13 residual: engine-down banner recovery is 15s-poll only — add "Retry now" button calling window.orwellRefreshEngineStatus() (already global). orwellEngineStatus.js:20,129,132.
- INT-3 [P2/S] IF-17 residual (#891): outbox is in-memory only — hard reload while a send is QUEUED loses it. Persist queue to the composer-draft record. **SHIPPED 2026-07-11 (#891 P0 batch):** reload-durable per-tab sessionStorage outbox (queued + in-flight-unconfirmed both persisted; restore + resume drain on boot; at-most-once via a pre-send `client_msg_id` history dedupe) + honest `queued`/`queued — offline` bubble status, offline-send preflight, fetch-failure classification → requeue, and `online`-event/backoff auto-drain. Gate: `frontend/tests/test_891_reload_durable_outbox.py`.
- INT-4 [P3/S] IF-21: #951 tracker/doc discrepancy — orwellNotice.js already implements unified kit; check whether residual scope = legacy callsite migration; reconcile ship-gate PARKED entry.
- INT-5 [P3/S] IF-25 (unconfirmed-carried J3-23): thinking accordion renders inside the AI bubble border — first-timer misreads reasoning as in-fiction. Visual-hierarchy fix; verify current placement first.
- INT-6 [P3/verify] IF-15 residual: verify orwellFinalizing sweep fires on a synchronous pre-reader throw (live network-drop repro).
- INT-7 [P3/verify] IF-20 note: re-verify cast-pin grid past 6 evictees live.
- INT-8 [P3/verify] IF-23: J3-11/J4-27 tutorial graduation fix ledger-confirmed not source-verified this pass.

## DOMAIN: Visual & Motion / Liquid Glass HIG parity (sweep complete; Glass cluster #709 substantially SHIPPED, favicon #926 shipped, Settings/Theme kit migration DONE, J2-16 red-focus fixed via #729)
OPEN items (deduped — F8=WAY-1, F9=FLOW-18, F10=FLOW-19/J1-15):
- VIS-1 [P1/S] Toast severity-color CSS cascade bug: .on-card.on-toast border-left (--accent, later in source) beats .on-sev-success/warn/error border-color at equal specificity → success toast renders 3 green edges + 1 accent/red left edge. orwellNotice.js:210-214,557. Fix: --on-toast-accent var deferring to severity.
- VIS-2 [P2/S-M] Cold-load loader removal is a hardcoded setTimeout(5000), not readiness-based — perceived-wait inflation on fast boots, FOUC on slow boots. index.html:375-419 (only removal path). Wire to a shell-ready signal; keep timer as fail-safe ceiling.
- VIS-3 [P2/S] Risk-skin coverage gap: veto-decision + self-evict missing from HIGH_STAKES_KINDS — quitting the game reads visually like a comp-intent pick. orwellDecision.js:49-60.
- VIS-4 [P2/M] styledConfirm/styledPrompt last hand-rolled .modal surfaces — outside kit material + z-authority (z-index:99999 !important vs _owNextModalZ — two racing z schemes). ui.js:500-575, style.css:5884-5894. Migrate to OrwellWindowKit modal or formally exempt.
- VIS-5 [P3/S] Loading sliver + on-continue nudge key off --accent/--red — under house themes the-feed/room-101 (true saturated red) neutral chrome reads destructive (same class #729 fixed for focus rings). orwellWindow.js:373-379, orwellNotice.js:216, theme.js:33,35. Route through neutral/info token.
- VIS-6 [P3/S] Toast in/out slide axis asymmetric (+120% in, -120% out) — non-mirrored motion; verify intent then mirror. orwellNotice.js:273-274. Also VERIFY toast keyframes respect prefers-reduced-motion.
- VIS-7 [P3/M] mix-blend-mode:luminosity vibrancy on glass labels still unimplemented (corpus's own "Open/remaining polish"; only flip+halo shipped). One grep hit :30742 (overlay tint, not labels). Needs parity pass vs Apple refs.
- VIS-8 [P3/verify] Contrast carries not re-verified: J4-10 .odec-err on light theme; J2-17 portraits CTA ~3.29:1.
- VIS-9 [P3/verify] Confirm GitHub PR #709 formally closed (code is on main).

## DOMAIN: Distributed Consistency / Concurrency / Two-Window Parity (sweep complete; A-S3 core, R-BND-1/2, A-S5, GAP-1 all ALREADY-FIXED)
OPEN items (priority order per the sweep):
- CONS-4 [P1/M] Model-driven tool seam ENTIRELY outside the 0065 sync spine: do_advance_game/do_submit_decision/do_record_interaction/do_move_to/do_make_deal attach no expectedBeatSeq, mint no idempotencyKey, never refresh _LAST_BEAT_SEQ. → (a) transport retry can DOUBLE-ADVANCE (at-least-once treated as exactly-once; hotter now with forced tool_choice #1157); (b) manufactures single-tab self-409s (ROAST 9/4742); (c) CAS bypass. Fix: one shared mutate-call wrapper (generalize _backfill_with_cas). tool_implementations.py:4811-4826+, orwell_engine.py:246-262.
- DRIFT-1 [P1/M] Mutating-tool sets re-drifted: 0093/0099 tools (formAlliance/joinAlliance/exposeSecret/tradeSecret) missing from chat.js:2625 allowlist AND chat_helpers.py:2498-2501 GAME_ENGINE_WRITE_TOOLS → no HUD dispatch, no peer push, E22 mis-fire. Structural fix: derive both sets from the engine registry manifest + extend test_g15 to diff vs registry. (Targeted closure delegated to mirror-fix agent.)
- CI-1 [P1/M] F5 mirror gate NOT a CI job — ship gate's own #1 bar regresses silently; ci.yml has zero refs to run_mirror_gate.sh/mirror_*_parity.mjs. Add path-filtered fe-mirror job into ci-gate; MIRROR_LIVE as nightly.
- PUSH-1a [P1/S-M] Chat-turn mutated-gate blind spots (composes with CONS-4+DRIFT-1). (Targeted closures delegated to mirror-fix agent: beatSeq refresh, allowlist adds, portrait-backfill publish PUSH-1b, reset peer-notify PUSH-1c.)
- OWN-1 [P1/L] No single per-turn reconciliation owner across the ~12-mechanism lattice. Proposal: TurnReconciler module owning beat-token lifecycle, single mutate funnel (CAS+idempotency+retry-once+never-drop-fold), ADR-0011 cascade budget, end-of-turn duties. _backfill_with_cas is the embryo.
- CONS-5 [P2/M] Transport retry × missing idempotency keys on recordInteraction/makeDeal/moveTo → same scene can fold TWICE (commit+lost response+retry+#591 re-attempt). Extend optional idempotencyKey to the 3 back-fill tools; or disable transport retry for keyless mutating calls.
- CONS-1-residual [P2/S] E22 floor-digest path still reconciles-and-SKIPS on first 409 (chat_helpers.py:2632-2638) — when it fires it IS the turn's only record. Route through _backfill_with_cas.
- BIND-3 [P2/S] Cold-start two-tab parallel casting: bind first-writer-wins at the FIRST framed casting POST (not game start) so tab 2 lands in the #1148 attach path.
- ADR11-tails [P2/S-M] Guardrail-cascade total cap per turn (ADR 0011:140-143) absent; FEJS-4 suppressed-bubble unmount (hidden-DOM O(rounds)).
- VERIFY-1 [P2/S] Owed runs: live-LLM two-window re-run + mid-gen-join pin (MIRROR_LIVE=1 exists; fold into CI-1 nightly).
- BIND-2-b2 [P3/owner] Casting cross-tab convergence — owner has now effectively ruled "mirror EVERYTHING" (delegated to mirror-fix agent).
- CONS-2-hardening [P3/S] Turn the backgroundPersist invariant into a boundary test (advance→beatSeq B→recordOffscreenSceneTexture→assert B) + arch rule: INFRA_LEVERS write-backs must not reach commit.
- CONS-3-cleanup [P3/S] Pin a wording-drift test on the stale-beat prose fallback; schedule fallback removal.
- IDEM-2 [P3/S] Idempotency cache process-local, cleared on restore — persist in snapshot or document the exactly-once durability boundary in 0065.

## DOMAIN: Content & A11y (sweep complete; massive verified-fixed roster — J1/J3/J4/J5/A11Y/RESP/TRANS/CARRY families closed)
OPEN items (deduped — CA-4=ops AUTH-1 upgraded):
- CNT-1 [P1/M] CA-4/#914: unconditional unannounced window.location='/login' on ANY 401 (app.js:45-53) — no draft stash, no aria-live warning, no soft re-auth. Promotion criterion (loses a turn) plausibly met. Fix: stash composer draft + announce + soft modal re-auth for background-call 401s.
- CNT-2 [P2/S] CA-3/A11Y-6: window-kit titlebar controls 24px desktop/32px touch — below project 44px floor on Normal theme+touch (frosted has invisible 44px ::after; Normal doesn't). Extend the ::after technique or formally rule the exception. orwellWindow.js:268-294.
- CNT-3 [P3/S] CA-5/#964: "the engine confirms it" machinery-naming under stall loop — add "engine"/"beatSeq" to the momentPrompts denylist + optional FE scrub; needs live-model verify.
- CNT-4 [P3/S] CA-6/#989: residual "Let me…" scrub edge — treat as live-model regression-test item vs blind copy fix.
- CNT-5 [P3/S] CA-2/J1-33 residual: "Chats" vs "Search conversations" noun drift (index.html:946 vs :898/:935/:2606).
- CNT-6 [P3/S] CA-1: prefill → placeholder swap option (orwellDecision.js:678) — owner voice call (=FLOW-13/IF-08).
  - **Resolved 2026-11-25 by ORW-919** (see FLOW-13): no prefill at all; a hidden decision-beat cue instead.
- CNT-7 [P3/S] CA-7: icon-rail buttons title-only accessible names — add aria-label parity w/ expanded sidebar (index.html:919 etc.).
- NOTE: WAY-1 (composer placeholder "Message Orwell...") DISPUTED — content sweep found sender label rebranded to "Orwell" in-fiction (#889, chat.js:71-73), making the placeholder ON-VOICE. Verify before fixing; likely stale finding.

## DOMAIN: Engine Architecture / Correctness / Perf / Testing Gates (sweep complete; R3 core, R-BND seam, ISSUE-1/6, SG7, PV1, PV2, R1a, R2, DB1/DB2 all ALREADY-FIXED)
OPEN items (deduped — B2 confirms DRIFT-1 and adds `confide` to the missing set; R1c = CONS-1 residual family):
- ENG-1 [P1/L] F1: feature 0108 real-model golden-path replay gate SPEC-ONLY — the #1 gate gap (record-once fixture at llm_core.py chokepoint → key-free PR replay in ci-gate → secret-gated nightly re-record).
- ENG-2 [P1/S-M] B1: registry-derived EXHAUSTIVE write-back boundary gate — iterate PLAYER_TOOLS∪ADMIN_TOOLS through McpServer.callTool asserting shape-400-never-unknown-tool; + WRITE_BACKS manifest w/ happy-path args + backgroundPersist flag (feeds C1 beatSeq gate).
- ENG-3 [P1/S] E1: numeric non-degradation round-trip proof owed — play 2 weeks, snapshot, restore into fresh registry, byte-equal re-export (mandate #4's last open proof). tests/unit/roundTripNumericFidelity.test.ts sketch provided.
- ENG-4 [P1/M] A1 residual: per-commit save write still O(total state) — FileSaveStore.saveFor full JSON.stringify + 2 fsyncs/commit; exportSnapshot full serialize per rev; every-32nd-commit full-verify latency cliff; playerSweep on hidden-adding commits. Fix: append-only journal + periodic compaction (share R3_FULL_CHECK_EVERY window) OR promote ORWELL_STORE=sqlite to deploy default; + a late-season per-commit latency regression gate (nothing measures this today).
- ENG-5 [P2/S] C1 gate: generic "INFRA_LEVERS write-back leaves beatSeq unchanged" test + fix stale contradicting comment in offscreenTextureBoundary.test.ts:200-203.
- ENG-6 [P2/S] F3: heavy-sims CI de-sharded (one serial job) while shard scripts + CLAUDE.md describe a matrix — restore matrix or update docs + duration alarm.
- ENG-7 [P2/S] F5: legacy-name ban test guards 3 of ~16 names (FORBIDDEN_SAMPLE) — expand to full legacy roster + optional grep-gate (CARRY-2).
- ENG-8 [P2/S] F6 (=ops SEC-2): no secrets scanner; VulnHawk removed; add gitleaks job to ci-gate w/ curated allowlist.
- ENG-9 [P2/S] I1-I3 doc drift: CLAUDE.md "0087-0104 mostly spec-only" STALE (most built+cucumber-wired); OOB model defaults STALE (glm-4.7 / gemini-3.1); heavy-sims sharding text STALE; 0066 Phase-2 "deferred" STALE (#1125 built all three).
- ENG-10 [P2/M] F2 residual (=VERIFY-1): live-model mirror nightly (MIRROR_LIVE) unscheduled — fold into 0108 nightly.
- ENG-11 [P3/S] A2: JSON.stringify(live) per-commit progress check → replace with beatSeq key (orchestrator.ts:355).
- ENG-12 [P3/S] F7: spec-numbering collision — two 0107s (llm-call-observability vs named-alliances); renumber before 0108 builds against it.
- ENG-13 [P3/S] F4: coverage ratchet available (measured ~92.7/90/86 vs floors 90/88/82).
- ENG-14 [P3/S] D1 residual: confirm FE createCharacter finalize REFUSES on missing required fields (engine delegates the hard stop to FE; one pytest if absent).
- ENG-15 [P3/S] G2 residual: PV4 fired-twist serialization assert; G5: PV3 confessional shell-diversity distribution gate post-0089.
- ENG-16 [P3/S] R5 verify: client-storage isolation guard (data-user fail-closed) unverified this pass; R4 tail: F-S4-F name-drift-on-resume unverified.

## DOMAIN: Narration / LLM↔Engine Seam (sweep complete; F14/F16/F8, ADR-0016 §A-D, ISSUE-2 casting leak X10, ISSUE-7/8/9, NARR-7/10/11, CARRY-1, PV1/PV2, A-S3 pin — all ALREADY-FIXED)
OPEN items:
- NAR-1 [P0/M] O1: OWNER-KEYING HOLE — reactive belt lattice INERT single-tenant (AUTH_ENABLED=false, owner=None): _TURNS_SINCE_PROGRESS writes under `if owner:` but reads `owner or ""` (stall-nudge never fires, agent_loop.py:4744-4750); _ADVANCE_STALL_LEVEL same (:5004-5007, L39b unreachable); _LAST_FRAMED_BEAT_KEY read `owner or ""` vs stash `user or "default"` (:4785/:4916 vs chat_helpers.py:2316 — F14 eviction-drain + peer-advance DEAD); `:6105 if _is_live_game and owner:` gates surface-the-pending belt + NARR-3 roster check. Fix: one _belt_key(owner) helper (sentinel "default"), sweep all reads/writes; un-gate :6105 correctness belts; pytest twin per belt (pattern: test_loop_forces_under_no_auth_owner_none).
- NAR-2 [P0/M-ops] O2: GLM-4.7 live verification NOT done — every "live-verified" artifact (ship-gate G1-G9, F16 held ×7) certifies retired DeepSeek. One recorded GLM golden-path run asserting: reasoning never in rendered DOM, tool-call rate ≫0%, forced beats return the named call, §D A/B craft comparison. Feeds NAR-6/8/12 + ENG-1.
- NAR-3 [P1/M] O4 (=FLOW-1 superset): outcome-guard identity-blindness for HOH/veto-winner/nominee FRESH-CROWN claims — branches fire only when the field did NOT move; wrong name on a moved field streams. Clone _eviction_evictee_mismatch pattern for hoh/vetoHolder/noms. chat_helpers.py:1217-1235.
- NAR-4 [P1/S] O5: FEPY-2 reasoning re-emit path bypasses _scrub_game_leak AND _pre_emission_outcome_guard (agent_loop.py:3490-3494 → :6337-6341 yields verbatim) — higher risk under GLM where reasoning IS tool-planning machinery. Pipe through scrub→guard; empty ⇒ F2 producer-line branch.
- NAR-5 [P1/S-M] O6: no OOB openrouter_provider pin for GLM narrator + no reasoning-suppression assertion (ADR 0016's explicit Cerebras-flake hazard). Ship provider preset + per-turn reasoning-share alarm on /admin/status.
- NAR-6 [P1/L] O3 (=ENG-1): 0108 replay gate spec-only AND its spec pins retired deepseek-v4-pro — update pin to resolved default_model; recording run doubles as NAR-2.
- NAR-7 [P2/S] O7: forced tool_choice sent verbatim to FALLBACK candidates — a DeepSeek fallback 400s at exactly the catastrophic-miss beats. Re-check _model_honors_forced_tool_choice per candidate in llm_core.py:2349 chain.
- NAR-8 [P2/M] O8: finale/jury lane has NO belt, NO forcing coverage, name-only juror roster projection (playtest's #1 blind spot). Add jury-vote/finale-reveal steer twin, finale in _FORCE_ADVANCE_PHASES, re-inject juror public facets at jury-finale moments.
- NAR-9 [P2/S] O9 (=FLOW-5): premiere gather projection missing — houseEventInSession has no premiere case (GameSessionAdapter.ts:2982-2999); 0106 pattern :3006-3030 is the template.
- NAR-10 [P2/S] O10: NARR-3 backstop misses single-token invented names (_TWO_TOKEN_NAME_RE only) + owner-gated (NAR-1). Higher-bar single-token pass w/ dialogue-attribution binding.
- NAR-11 [P2/M] O11: TRANS-1/2/3 unbounded render accumulation (continuation bubbles / per-round accordions / tool-beat chips, no cap/dedup) — AMPLIFIED by GLM's higher call rate. chat.js:2616/1601-1648/2177 + chatRenderer.js:2012-2070. (=ADR11-tails FEJS-4.)
- NAR-12 [P2/S] O12: guard regexes tuned on DeepSeek phrasings — GLM miss-rate unmeasured; mine NAR-2's transcript, extend from evidence only.
- NAR-13 [P3/S] O13: no capability manifest for known-hazard narrators (Kimi leaks raw tool tokens; Gemini-Flash body reasoning) — settings warning at endpoint save; owner: warn or block.
- NAR-14 [P3/S] O14: CARRY-3 "Producer's Vault" spoken post-season (#607) — PO-confirm term or rename in retrospective fragments.
- NAR-15 [P3/M] O15 (=ENG-15/PV3): confessional shell-pool widening keyed archetype/arc.

## DOMAIN: Social Game / BB Genre Fidelity (sweep complete; F14/F16/F8/F13/F9/F2 eviction seam, PV1/PV2, SG7, 0090/0089, 0093/0099/0109, 0100 grudge book, NPC-initiated play all ALREADY-BUILT/FIXED — several held-for-live)
OPEN items:
- SOC-C1 [P1/M] NPC alliance EXISTENCE has no gossip pathway — invisible to non-members until it votes (SOC-1 core residue). Emit rumorFrom-style vague gloss into diffuseGossip on NPC alliance formation/scenes; hop-decay/distortion applies. alliances.ts:29-31, gossip.ts:101-103.
- SOC-C2 [P1/M] socialRead still count-plus-binary ("N moments, M things") — never quotes the player's own earned beliefs w/ graded provenance; no "recently reached you" block in moment context (voicing is call-dependent = under-call family). PlayerSurface.ts:74-92 + momentPrompts weave.
- SOC-C3 [P1/S] Deal-break / named-alliance betrayal has NO ceremony steer — marquee genre beat degrades to a sidebar recolor. Add betrayal beat kinds to _CEREMONY_STEER. agent_loop.py:1626-1635, orwellDeals.js:47,81.
- SOC-G1 [P1/S] (=NAR-9/FLOW-5 CONFIRMED still open): premiere gather — houseEventInSession has no premiere case; move-in seeds dispersed presence + forces only the PLAYER to the living room (GameSessionAdapter.ts:3582-3596); observational projection fix, 0106 pattern, calibration byte-identical.
- SOC-I1 [P1/M] 0102 daily bedtime recap + cliffhanger — PO-RESOLVED build-ready; the missing tension-and-release scaffold; natural home for SOC-C2's "what reached you today".
- SOC-I2 [P1/L] (=ENG-1/NAR-6): 0108 gate — retires the whole held-for-live tier (R1-R3/J4/N1/PV live-verifies) under the NEW narrator.
- SOC-C4 [P2/M] Recurring-cluster observational read over player's OWN witnessed co-presence ("always the same three in the backyard") — derived per-call, never stored; sequence AFTER C1+C2.
- SOC-G2 [P2/S] Premiere STILL-TO-MEET lines lead with archetype label (F3 fix covered roster only; observable() at momentPrompts.ts:1005-1010) — mirror the roster demotion; maybe deliberate, live-check.
- SOC-B1 [P2/M] Blindside signal-rate instrument: seeded calibration counting pathway-borne warning fragments reaching player before upset evictions; tune GOSSIP.transmitProb to a band (≥1 fragment in ~60-80% of upsets).
- SOC-B2 [P2/M] 0094 distorted-gossip consequences (spec-only): acting on a bad belief should cost — legitimizes blindsides.
- SOC-B3 [P2/M] 0096 emergent nemesis (spec-only) — sequence after C1/C2.
- SOC-B4 [P2/M] 0095 pre-show ties → time-bombs (spec-only).
- SOC-B5 [P2/M] 0101 NPC myth-making (spec-only) — the one missing irony direction (player hears distorted self); pairs w/ built 0104 notoriety.
- SOC-P3 [P2/S] PV3 residual: pools 3×4 lines; confessionals lack source-thread tag (Vault-internal threadId).
- SOC-P4 [P2/S] PV4 verify: seeded armed-twist serialization test (=ENG-15).
- SOC-M2 [P2/S] (=ENG-3): numeric Soul round-trip proof.
- SOC-J3 [P3/S] Passive-floater F2-reach lever (juryManagementWeight) — PO call; do NOT touch gameRespect.
- SOC-M1 [P3/S] activeCount on /state (F15 optional); never prune house[].
- SOC-M3 [P3/S] Feature-index drift: 0093/0099/0109 rows still "build-ready" though merged; 0102 filename rename pending.
- SOC-P2r [P3/S] PV2 residual: overhear clarity proxied by fragment LENGTH not stored per-hop confidence — thread the real number (rendered as a word).
- NOTE: S3 frozen specs (0097/0098/0103) — owner-ruled DO NOT BUILD; recorded so nobody re-proposes them.

## DOMAIN: Responsive / Cross-Platform (sweep complete; #935/#552/#551/#553/#554/#555/J2-06/J2-18/RESP-1..4/iOS-zoom/E92/drag-touch/DPR-canvas all VERIFIED FIXED; XFAIL registry empty)
OPEN items:
- RSP-1 [P1/M] RM-01: CI responsive matrix runs ENGINE-LESS — every game surface (HUD, decision card, cast, presence, retro, finale) measured at ZERO viewports on every merge (stage_game→False w/o ORWELL_MATRIX_ENGINE; ci.yml sets none). Boot engine in FE CI job + export the env; piggyback ORWELL_MATRIX_FINISH=1.
- RSP-2 [P1/S] RM-04: tap-target sweep's offsetParent!==null filter EXCLUDES all position:fixed chrome (hamburger, drawer opener, FAB) — the exact mobile-critical controls. Replace with checkVisibility(). responsive_matrix.py:389.
- RSP-3 [P1/L] PF-01: ~1.09MB core JS parses every mobile load — settings.js 315KB + admin.js 166KB eager tags; slashCommands.js 271KB is a STATIC ES IMPORT of chat.js (no strip can reach it). Lazy import() on first open + dynamic import at composer command gate + longer-term chat.js split.
- RSP-4 [P1/M-verify] KB-01: iOS keyboard vs composer/decision-sheet UNPROVEN on device — interactive-widget is Chromium-only; 100dvh doesn't shrink for iOS keyboard. One physical-iPhone pass + CDP visualViewport proxy pass in matrix (RM-05).
- RSP-5 [P1/S-verify] MJ-01 (=FLOW-14): live mobile casting re-verify owed (cancelled-turn fix).
- RSP-6 [P2/S] HV-01: sidebar folder-delete × is hover-only + min-height:0 defeats the token floor — unreachable/17px on touch (no hover:none fallback, no focus-within; verify no long-press alternative). style.css:1684-1691; correct pattern at :1378-1381.
- RSP-7 [P2/S-M] RM-02/03/05/06: matrix tier gaps — no landscape-844 tier (the #935 fix is regression-unguarded), no DPR≥2 contexts, no keyboard-open pass, endgame sweep never in CI. One PR to the gate.
- RSP-8 [P2/S] RM-07: token min-width floor 36px vs project/matrix 44px — reconciled only by accreting per-control !important blocks; raise token to var(--tap-min) under coarse + .tap-exempt, delete patches.
- RSP-9 [P2/S] TT-01: hamburger pair ~36-39px wide on touch, absent from RESP-4 list, invisible to the sweep (RM-04).
- RSP-10 [P2/M] EQ-01 (=FLOW-18): premiere-week mobile affordance — badge the opener with met/unmet count or tutorial deep-link to cast pin (avoid persistent HUD strip — ADR 0003).
- RSP-11 [P2/S] EQ-07: --safe-left/right tokens ~unused — hamburger left:9px / opener right:9px / drawer flush right:0 can sit in notch zone landscape+cover. Consume tokens at edge-pinned chrome.
- RSP-12 [P2/M-verify] PF-02: glass tiers (backdrop-filter + adaptiveGlass sampling + SVG refraction) frame-time unmeasured on mobile GPUs — measure, then coarse-pointer de-escalation seam exists.
- RSP-13 [P3/S] TT-02 verify: kit titlebar 32px coarse ruling requires ≥8px inter-control clearance for the WCAG 2.5.8 spacing exception — verify gap.
- RSP-14 [P3/S] TT-07 footer actions ~36px wide on touch; KB-02 welcome-lift vh→dvh; KB-03 orphaned --vh setter (delete or wire); PW-01 stale manifest branding; PW-02 blob-manifest install-scope verify; PW-03 SW precaches stripped scripts; MJ-02 optional capture="user" camera input; MJ-03 live-verify desktop-geography narration fix; EQ-08 latent 100vh modals (full-workspace only); X-938 undefinable from repo — needs tracker record.
