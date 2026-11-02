# Cross-cutting audit: orwell @ 344a09e6 (read-only)

Tags: **VERIFIED** means I traced the code path end to end. **LIKELY** means the code reads that way but I did not execute it. **SUSPECTED** means it needs a closer look or an owner ruling. No tests were run; the lead is running those separately.

---

## 1. Feature-flag inventory

The deploy opt-ins come from `deploy/orwell-env-defaults.sh` (used by both install and update). "/health" means the flag is listed in `src/featureFlags.ts` `FEATURE_FLAGS`. "Outcome" means flipping the flag moves seeded comp, vote or jury results, so the calibration has to be re-measured.

| Env var | Feature | Code default | Real deploy | In /health | Outcome? | Notes |
|---|---|---|---|---|---|---|
| ORWELL_EMBEDDINGS / _EMBED_CACHE | ADR 0004 | fake | **ON** (fastembed) | – | no | |
| ORWELL_CAMPAIGNS | 0085 | off | **ON** | yes | **yes** (campaignTiltFor, `liveSeason.ts:1560`) | |
| ORWELL_TRAJECTORIES | 0087 | off | **ON** | yes | likely | |
| ORWELL_TRIGGERS | 0091 | off | **ON** | yes | likely | |
| ORWELL_SECRET_PACING | 0092 | off | **ON** | yes | no (knowledge layer) | |
| ORWELL_JURY_HOUSE | 0100 | off | **ON** | yes | **yes** (finale lean) | |
| ORWELL_SEEDED_TIE_SURFACING | 0059 §5 | off | **ON** | yes | likely | |
| ORWELL_MYTH_MAKING | 0101 | off | **ON** | yes | no (claims own rng) | |
| ORWELL_SHOWRUNNER | #1401 Phase 1 | off | **ON** | yes | no | |
| ORWELL_SHOWRUNNER_REWEIGHT | #1455 Phase 2 | off | off (on purpose) | **no** | **yes** | |
| ORWELL_COMP_INTENT | 0006b | off | **ON** | yes | **yes** (NPC throws) | |
| ORWELL_VOTE_DEDUCTION | 0110 | off | **ON** | yes | jury | |
| ORWELL_TIME_OF_DAY | 0066 | off | off in env, but the FE setting `time_of_day_enabled: True` (`frontend/src/settings.py:35`) pushes `setTimeOfDay` at boot and on the first turn, so **ON in practice** | yes | **yes** (rest penalty) | |
| ORWELL_TIME_PER_CONVERSATION | 0066 P2 / 0117–0119 | **ON** (`!== "0"`, `GameSessionAdapter.ts:746`) | ON | **reported wrong** | pacing | see finding 11 |
| ORWELL_SOCIAL_FATIGUE | 0066 P2 | **ON** (`:751`) | ON | **reported wrong** | yes (sway) | see finding 11 |
| ORWELL_MULTI_NIGHT_FATIGUE | 0066 P2 ext. 3 | off | **OFF** | yes | yes | Built, but players never get it |
| ORWELL_DEAL_DEPTH | 0121 | off | **ON** | yes | **yes** | |
| ORWELL_STRATEGIC_CADENCE | 0120 | off | **ON** | yes | likely | |
| ORWELL_SCHEME_TARGETS | wave 2 | off | **ON** | yes | no | |
| ORWELL_CONFESSIONAL_DEPTH | 0122 | off | **ON** | yes | no (Vault only) | |
| ORWELL_NPC_DEAL_OFFERS | 0123 | off | **ON** | yes | yes | **can soft-lock the game** (finding 1) |
| ORWELL_SOUL_DEPTH | 0124 | off | **ON** | yes | likely | |
| ORWELL_COMP_MECHANICS_PLUS | 0126 | off | **ON** | yes | **yes** | |
| ORWELL_COMP_MIXED | 0127 | off | **ON** | yes | **yes** | |
| ORWELL_GOSSIP_DRIFT | #1397 | off | **ON** | yes | no | |
| ORWELL_SECRET_BARTER | 0099 | off | **ON** | yes | no | |
| ORWELL_PLAYER_DOSSIER | #1793 | off | **ON** | yes | no | the model can't call it (finding 2) |
| ORWELL_TRAITORS_FURY | #1790 | off | **ON** | yes | presentation | see section 10 |
| ORWELL_PRODUCER_READ | #1792 | off | **ON** | yes | no | |
| ORWELL_DEAL_WITNESSES | #1802 | off | **ON** | yes | likely | |
| ORWELL_BOOTH_RECEIPTS | #1800 | off | **ON** | yes | no | the model can't call it, and 2 of its 3 checks are dead (finding 3) |
| ORWELL_ACT_COMMIT_VOICE_VETO_CEREMONY | #1782 | off | **OFF** | yes | none | Placeholder only, does nothing (`liveSeason.ts:2452-2456` TODO). The comment at `GameSessionAdapter.ts:583` says "the deploy sets it", which is false. The FE setting `act_commit_voice_veto_ceremony` (`settings.py:50`) is read by nothing. |
| ORWELL_WIPEOUT_REEL | C1 / #1788 | off | **OFF** | **no** | **no** (forked rng) | Built and presentation-only, so it is safe to turn on |
| ORWELL_TIE_REVEAL | 0095 overhear pathway | off | **OFF** | **no** | yes (edge folds) | No admin toggle (the static setter has no MCP route). The `accuseTie` half works without the flag. |
| ORWELL_REACTIVE_TWISTS | 0025 reactive redesign | off | **OFF** | **no** | **yes** | The README says "all 3 twists live", but deploy runs the legacy path. FE can't handle `secret-veto` (finding 6). |
| ORWELL_GEN_COMPETITIONS | #1400 | off | **OFF** | **no** | no | The FE driver `orwell_gen_competitions.py` is effectively a no-op |
| ORWELL_MEMORY_CALLBACKS (FE) | #1394 | off | **OFF** | – | no (prompt only) | `chat_helpers.py:4141` |
| ORWELL_FORESHADOW | 0103 (frozen) | – | – | – | – | Never read; `foreshadow.ts` is dead code |
| ORWELL_DISABLE_DIVERSITY | 0063 kill switch | off | off | – | – | |
| FE: ORWELL_WS_TRANSPORT | ADR 0017 | ON | ON | – | – | |
| FE: ORWELL_OVERSEER(_MODE) / FAITHFULNESS_MODE / ENRICHMENT_POLICY / ALLOW_FLOOR_START / GAME_BUILD | 0079–0081 etc. | setting/env | defaults | – | – | not traced further |

**Built features that are OFF in a real deploy:** reactive twists (0025 redesign), tie-reveal overhear (0095 half), wipeout reel, generative competitions (#1400), memory callbacks (#1394), multi-night fatigue, and the veto-ceremony DECIDE pipeline (#1782, which is only a placeholder anyway). Only wipeout reel, generative competitions and memory callbacks are calibration-neutral and can simply be turned on.

## 2. Engine tool wiring (port → registry → McpServer)

Clean.
- All 66 registry tools (57 player, 9 admin, plus `producerVault`) have a `callTool` dispatch case.
- The only dispatch cases outside the registry are the intentional INFRA pair `sealedFromHouse` and `knowledgeScopeManifest`.
- Port methods not in the registry are all accounted for:
  - `movePlayer` and `recordHouseguestMove` dispatch as `moveTo` and `moveHouseguest` (`McpServer.ts:524-532`).
  - `producerVaultDump` is reached through `producerVault`.
  - `notorietySummary` is internal only; its tool was removed on purpose in #1791.
- Every engine tool name the FE calls exists. The reverse check: `playerDossier` and `playerReceipts` are engine tools that the FE never calls (see section 3).

## 3. FE tool wiring (prompt levers → FE)

| Lever named in BASE_GAME_MASTER_PROMPT | schema | ORWELL_GAME_TOOLS | GAME_TOOL_KEEP | exec | orwell_engine | beats |
|---|---|---|---|---|---|---|
| `playerReceipts` (`momentPrompts.ts:584`) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `playerDossier` (`momentPrompts.ts:589`) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| the other 30 levers | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**VERIFIED.** This is exactly the "lever-drift trap" CLAUDE.md warns about:
- `playerDossier` was added by 1f6ff550 and `playerReceipts` by ace11887, both engine-only commits made on 2026-07-30.
- The last FE commit (90e6b8de) is from 2026-07-28, so `fe-unit` hasn't run since either lever was added.
- `frontend/tests/test_c13_lever_drift.py::test_every_prompt_advertised_lever_is_agent_callable` will fail on the next FE PR.
- Meanwhile, a model that follows the prompt gets "Unknown function" errors.
- No FE game tool points at a missing engine tool. `MOMENT_PROMPTS` names no further unwired tools.

## 4. Pending-decision kinds, end to end

Internal union (`liveSeason.ts:153`): 17 kinds. `deal-offer` exists only in the external view; it comes from the adapter's `live.dealOffer`.

| kind | engine / adapter | orwellDecision.js | relay allowlists (tool_impl:5245 / orwell_routes:1562 / ws_routes:64) | FE tool-schema enum (`tool_schemas.py:1384`) | responsive_matrix | s4ff.mjs | UAT harness |
|---|---|---|---|---|---|---|---|
| the 14 weekly-loop and finale kinds | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| exit-interview | ✓ | ✓ | ✓ | **✗** | ✓ | ✓ | ✓ |
| self-evict | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| **deal-offer** (0123, **deploy ON**) | ✓ (`GameSessionAdapter.ts:8681`) | ✓ renders and posts it | **✗ ✗ ✗** | **✗** | ✗ | ✗ | ✗ |
| **secret-veto** (0025, deploy off) | ✓ | **✗** | **✗ ✗ ✗** | ✗ | ✗ | ✗ | ✗ |

(`_golden_driver.py` and the visual-regression driver were removed along with 0108/0113.)

## 5. Beat kinds, end to end

`INERT_BEATS` (`liveSeason.ts:145`) contains `comp-elimination`, `day-break` and `exit-interview`.

| Beat | Draws rng / folds? | Inert? | Moves the clock (when time-of-day is on)? |
|---|---|---|---|
| eviction-reveal (4–8 batches per eviction, `:2071-2086`) | **no rng, presentation only** | **✗** | **yes, +3h each** (`beatFeltHours` → null → flat `perBeatHours: 3`, `daySchedule.ts:109-131`) |
| eviction-goodbye (one per NPC sender) | folds manner | ✗ | +3h each |
| eviction-result | rollWeek | ✗ | +3h |
| finale-reveal (one per juror) | presentation | ✗ | +3h (endgame, harmless) |
| veto-draw, twist-reveal, battle-back | draw rng | ✗ (correct) | +3h |

FE icons (`orwellToolBeats.js:151`) are missing for `comp-elimination`, `battle-back`, `day-break` and `self-eviction`; they fall back to "•" (cosmetic). Moment-prompt fragments are keyed by phase rather than sub-beat, which is fine.

## 6. Dead code

| Module | Status |
|---|---|
| `src/engine/foreshadow.ts` (156 lines) | Not imported anywhere (0103 is frozen, so this is expected). VERIFIED |
| `src/engine/suspicionLedger.ts` (269 lines) | Test-only. The README says "0097 engine core built, unwired"; the ledger and CLAUDE.md say "frozen". VERIFIED |
| `src/engine/schedule.ts` | **Test-only, yet the 0008 daily-event BDD runs entirely against it** (`features/step_definitions/daily_event.steps.ts:4`). The live loop never uses it, so the 0008 BDD tests a shadow scheduler. Live daily-event coverage depends on the orchestrator's "no-daily-event" checkpoint instead. VERIFIED |
| `src/engine/decisions.ts` | Test-only. The 0019 BDD (`agent_play_loop.steps.ts:4`) checks a decision seam that production replaced with `liveSeason.applyDecision`. VERIFIED |
| `src/engine/gameProgression.ts`, `src/domain/temperature.ts` | Test-only (persistence / outcomes property tests). Low priority |
| `src/engine/calibration.ts`, `richness.ts` | Measurement tools; test-only by design |
| `Orchestrator.idleSince` / `lastActivity` (`orchestrator.ts:131,219`) | The comment says "Presence reads this", but no `src/` code calls it; only tests do. Leftover from the watcher. VERIFIED |
| `frontend/static/js/emojiPicker.js` (272 lines) | Never loaded (inherited workspace code) |
| FE setting `act_commit_voice_veto_ceremony` | Never read |

## 7. Real-time purge residue

No code references remain to `GameWatcher`, `SystemClock` or `ORWELL_WATCHER_*`. What's left:
- Comments that still say "read once at module load, like the watcher cadence" (`GameSessionAdapter.ts:451,462,587,596`).
- The 0049 BDD step "the watcher treats the milling as activity rather than idleness" (`0049-…feature:63`, step `house_presence.steps.ts:354`) asserts the dead `idleSince`.
- 0038 says "When the off-screen watcher runs several ticks".
- **ADR 0018 (Accepted)** still says "`GameWatcher` stays built and off" and cites `ORWELL_WATCHER_TICK_MS=0` (`docs/decisions/0018-…md:10,30,55,265`). Also stale: ADR 0017, `docs/design/websocket-phase1-protocol.md`, `IMPLEMENTATION_QUEUE.md`, `HERMES-INTEGRATION-MAP.md`.
- FE player-facing copy is clean.

## 8. Status sources that disagree

| # | README | PO ledger | cucumber | CLAUDE.md | Problem |
|---|---|---|---|---|---|
| 0108 | **Decommissioned 2026-07-21** (fixture, scripts and CI job removed) | "📝 Spec only / Pending" | – | "**armed**", with a page-long "golden-path re-record obligation" | CLAUDE.md is badly stale: agents will try to re-record a fixture that doesn't exist. `frontend/tests/golden/` is absent, and `ci.yml` has no golden, visual-regression or theme jobs. |
| 0113, 0114 | Decommissioned | no row | – | "built (FE + CI gates)" | stale |
| 0111, 0112 | Built 2026-07-10 | no row | 0111 yes | "in progress (being built now)" | stale |
| 0097 | "REOPENED + engine core built" | Frozen | – | Frozen | three-way disagreement |
| 0080 | Built | Spec only | – | built | ledger stale |
| 0094, 0095, 0096, 0101 | Built | Spec only | wired | built | ledger stale |
| 0093, 0099, 0102, 0109 | Built | "Build-ready" | wired (except 0102) | built | ledger stale |
| 0010 | "real-Proxmox smoke owed" | "PO confirms run on a real server" | – | "still owed" | conflicting |
| 0076 | 🚧 | ✅ Built | – | – | minor |
| 0115–0132 | rows present | rows only for 0115 and 0122–0124 | 0115–0127 and 0130 wired | "spec set to 0114" | CLAUDE.md doesn't know 0115–0132 exist |
| Default models | – | – | – | narrator `deepseek-v4-pro` + portrait `gemini-2.5-flash-image`; elsewhere "Seedream portraits" | Code says `z-ai/glm-4.7` + `google/gemini-3.1-flash-image` (`settings.py:75,374`, `oobe_reset.py:18`) |

The "# spec-only" markers on built features (0029, 0032, 0033, 0036, 0051, 0053, 0064, 0069, 0074, 0079, 0081, 0090, 0102, 0112) are consistent with their intended meaning ("not in cucumber"). Not a defect.

## 9. Spec-vs-spec conflicts and stacking

- **Calibration never measures the deployed configuration (LIKELY, high impact).** `juryReach`, gradient and UAT run with every flag off. The only flags-on heavy runs are for SHOWRUNNER_REWEIGHT (`juryReachShowrunnerReweight.property.test.ts:28`) and `setGenCompetitionsEnabled` (`liveSentinel`). Deploy turns on about 11 outcome-affecting layers at once: campaigns, deal depth, comp intent, comp mixed, comp mechanics+, jury house, vote deduction, soul depth, trajectories, time-of-day plus social fatigue, and traitors fury. All of them feed one vote formula (`liveSeason.ts:1555-1563`: threat×paranoia + blocTerm(0043 + 0107 allianceTie) + campaignTilt(0085) − dealHonor(0039/0121) − juryMgmt − bondKeep). The "active wins 20% vs passive 7%" result in CLAUDE.md applies to a configuration no player ever runs.
- **Time and pacing (0066/0118/0119 vs the staged eviction, LIKELY).** 0118 schedules evictions for the evening (hour 16 or later). The staged eviction then emits about 5 reveal batches + the eviction beat + N goodbye beats + the result. Each non-inert beat advances the clock by +3h with wrapping on (`advanceClockBy(..., true)`, `liveSeason.ts:1683-1692`), so 16 + 15 + 2 is already ≥ 32 (the end of the day). The wrap sets `lastSleepDepth = DAY_END_HOUR` (maximum sleep debt) and calls `accrueNightFatigue`, right before the next HOH comp, where the hidden rest penalty applies. This contradicts 0119's own "eviction ~2h" and the #537 principle that "the clock advances only on substantive play". The existing guard (`timeOfDaySession.test.ts:66`) covers only staged comps.
- **0129 vs 0100.** Both are called "the jury house". 0100 is a hidden second society (built); 0129 is player-facing Q&A with jurors (spec only). 0129's "witness-bounded juror knowledge" will collide with the 0100 / Traitors' Fury beliefs that the jury house diffuses among jurors (see section 10). This needs a ruling before 0129 is built.
- **0128 vs 0045.** 0128 replaces 0045's single Final-3 HOH. It's spec-only, so there's no conflict yet.
- **Gossip models** (0002/0038 diffusion, #1397 drift, #1789 telephone provenance, 0094 confront): they look layered rather than double-counted. #1789 rides `ORWELL_GOSSIP_DRIFT`. Clean as far as I traced.
- **Relationship math** (0017/0026/0124): not traced deeply; no contradiction found.

## 10. Vault Wall spot-check

- **Finale `asking.heldBelief` / `bearing` (#1790, deploy ON). SUSPECTED.**
  - `finaleView` reads `npcKnowledge.known(juror)` and returns the first fact containing "turned on them" (`GameSessionAdapter.ts:10503-10507`).
  - Those facts are built from `deducedCulprits`, which is 0110 vote deduction over **secret ballots** (`:7861`). They are then diffused juror-to-juror in the hidden jury house.
  - So (a) per-voter attribution beliefs (who voted against whom) cross to the player channel before the 0048 retrospective, which seems to bend E12's "attribution unseals only in the retrospective". (b) The first-match `.find` can hand the asking juror a *different* juror's diffused blame fact.
  - `bearing` is a word mapped from the hidden `juryGrudge` number. A label rather than a number, so arguably allowed.
  - The sentinel test (`traitorsFuryFinale.test.ts:76`) checks only for sentinels and ids, not E12 attribution.
- **`playerReceipts`** reads `engine.events.queryAll()` (all events, including hidden ones) filtered only by `initiator === player` (`GameSessionAdapter.ts:11362-11377`). Low risk, since player-initiated events are witnessed, but it doesn't filter `hidden`. The `status === "open"` filter on final-two deals could create a side channel if a deal's status can flip off-screen. SUSPECTED, low.
- **Receipt summaries print raw entity ids** ("promised final-two to … npc:3, npc:7", `receipts.ts:66-72`): `partnerNames` holds ids, not names. Cosmetic; the markdown scrub may catch it.
- **Canaries exist** for #1869 skeletons, #1791 notoriety, `producerVault`, the dossier OOC boundary, and the #1790 sentinel. `producerRead` is structurally Vault-free.
- **`receipts.test.ts` breaks the hard "no names in tests" rule** (Leo / Maeve, lines 79-95).

---

## Top 15 cross-cutting findings, ranked by payoff

1. **The NPC deal offer can soft-lock the game in every deploy.** VERIFIED (code-traced, not run live).
   - Evidence:
     - `ORWELL_NPC_DEAL_OFFERS=1` is in `orwell-env-defaults.sh`.
     - `advanceOneBeat` refuses to advance while `live.dealOffer` is set (`GameSessionAdapter.ts:8612-8613`), and only `resolveDealOffer` clears it (`:10104`).
     - Resolving it needs `submitDecision({kind:"deal-offer"})`. All three FE relays reject that kind (`tool_implementations.py:5245`, `orwell_routes.py:1562` returns 400, `ws_routes.py:64` returns unknown-kind), and so does the tool-schema enum (`tool_schemas.py:1384`). `orwellDecision.js:40,817` renders the card and posts it anyway.
   - What a player sees: a houseguest offers a deal, Confirm fails, and from then on the week never advances. Every advance is a no-op.
   - Fix: add `"deal-offer"` to the 3 allowlists and the schema enum. **S**

2. **The `playerReceipts` and `playerDossier` levers are advertised to the model but not callable.** VERIFIED. (`momentPrompts.ts:584-592`; no FE schema, KEEP, exec, engine wrapper or beat label; the engine-only commits 1f6ff550 and ace11887 came after the last FE commit.)
   - What a player or owner sees: the narrator tries the Diary Room "receipts" and gets "Unknown function". The next FE PR then goes red in `fe-unit` (`test_c13_lever_drift`) for reasons unrelated to it.
   - Fix: the 5-place FE wiring plus a beat label. **S–M**

3. **Booth Receipts (#1800) can never produce a "target-vote-mismatch" receipt.** VERIFIED.
   - The adapter maps `kind: e.kind`, but `GameEvent` has `type`, not `kind` (`GameSessionAdapter.ts:11377`, `event.ts:22`). No event type `vote-evict` exists either (that's a deal *action* kind, `deal.ts:111`).
   - The week-grouping heuristic `id.split(":")[0]` is also meaningless.
   - The unit test only passes because its fixtures are built by hand.
   - What a player sees: the producer never calls out "you said you'd target X and voted Y". The feature is mostly hollow.
   - Fix: map to `type`, derive votes from the vote ledger, and also fix the id-vs-name summaries and the named test. **M**

4. **The eviction night wraps the in-game day and hands the player maximum sleep debt before the next HOH.** LIKELY. (`liveSeason.ts:145` leaves `eviction-reveal` and `-goodbye` out of `INERT_BEATS`; flat +3h per beat via `daySchedule.ts:109-131`; the wrap is at `:1683-1692`; time-of-day is on through the FE setting `settings.py:35`.)
   - What a player sees: every eviction night skips to the next morning as if they'd pulled an all-nighter, and they quietly do worse in the HOH comp that follows.
   - Fix: give reveal and goodbye beats a 0h or small felt duration, or treat them as inert for the clock, and add an eviction-night clock test. **S**

5. **Deployed calibration is unmeasured.** LIKELY. (Section 9: heavy sims run flags-off; deploy turns on about 11 outcome-affecting layers that stack in `voteChoice`, `liveSeason.ts:1555-1563`.)
   - What an owner sees: the "playing the game converts" guarantee (EARNED_WINS) is proven for a configuration no player runs. Real seasons could be badly unbalanced without anyone knowing.
   - Fix: add a "deploy-profile" jury-reach + gradient shard that applies `orwell-env-defaults.sh`. **M**

6. **Reactive twists (0025 redesign) are OFF in deploy, and the FE couldn't handle them if switched on.** VERIFIED. (`GameSessionAdapter.ts:1635`; not in the defaults or /health; `secret-veto` is missing from `orwellDecision.js`, all 3 relays and the schema.)
   - What a player sees: they only get the legacy double-eviction twist. Turning the flag on would put up a `secret-veto` pending nobody can answer, and the game would soft-lock just like finding 1.
   - Fix: wire `secret-veto` through the FE, then flip the flag after calibration. **M**

7. **CLAUDE.md is stale in ways that misdirect agents.** VERIFIED.
   - It says the 0108 golden path is "armed" and spends a long section on the re-record obligation, but the fixture, scripts and CI jobs were deleted 2026-07-21 (README:184).
   - It says 0113/0114 are built (they were decommissioned) and 0111/0112 are "in progress" (they're built).
   - It doesn't know 0115–0132 exist, and its default models are wrong.
   - What an owner sees: agents waste runs trying to re-record a fixture that doesn't exist and give wrong answers about status.
   - Fix: a docs reconcile. **S**

8. **Finale `heldBelief` surfaces secret-ballot attribution beliefs from the hidden jury house before the retrospective, and may pick the wrong juror's belief.** SUSPECTED. (`GameSessionAdapter.ts:10503-10507`, `:7861`)
   - What a player sees: a juror's question hints at who (they think) voted against them, which is jury-house knowledge the player never got through any in-game pathway, and sometimes it's a different juror's grudge.
   - Fix: filter to the asking juror's own seeded `factId` and get an owner ruling on E12. **S**

9. **The tie-reveal overhear pathway (0095) is unreachable in deploy.** VERIFIED. (`GameSessionAdapter.ts:6191-6195`: env only; not in defaults or `FEATURE_FLAGS`; `setTieRevealEnabled` has no admin route.)
   - What a player sees: pre-show ties only come out if the player guesses them with `accuseTie`. They never overhear a tie being revealed.
   - Fix: add it to the defaults after calibration, and to /health and the God-Mode dial. **S**

10. **The 0008 daily-event and 0019 decision BDDs test shadow modules.** VERIFIED. (`daily_event.steps.ts:4` uses `engine/schedule.ts`; `agent_play_loop.steps.ts:4` uses `engine/decisions.ts`; neither is imported by `src/`.)
    - What an owner sees: green BDD for two of the eight priority invariants proves nothing about the live loop.
    - Fix: re-point the steps at `liveSeason` or `GameSession`. **M**

11. **`/health` reports `timePerConversation` and `socialFatigue` as false while both are on.** VERIFIED. (`featureFlags.ts:89`: the `inverted` parser is `v !== undefined && v !== '0'`, which returns false when unset; the engine uses `!== "0"`, `GameSessionAdapter.ts:746,751`.)
    - What an owner sees: the operator health panel misreports the live pacing layers.
    - Fix: change the parser to `v !== '0'`. **S**

12. **The PO ledger disagrees with the README for about 11 features.** VERIFIED. (Section 8: 0080, 0093–0096, 0099, 0101, 0102, 0109 listed as "Spec only / Build-ready" but built; 0108 listed as "Spec only" but decommissioned; 0097 frozen vs reopened; 0010 smoke owed vs done.)
    - What an owner sees: sign-off sessions run against the wrong build status.
    - Fix: a ledger reconcile pass. **S**

13. **Several built, calibration-neutral features are simply off.** VERIFIED. Wipeout reel (C1), generative competitions (#1400), memory callbacks (#1394). Not in the defaults; the first two aren't in /health either.
    - What a player sees: same-y competition drop narration, and no narrator memory callbacks, even though the code exists.
    - Fix: add them to `orwell-env-defaults.sh` and `FEATURE_FLAGS`. **S**

14. **The #1782 veto-ceremony pipeline is a no-op placeholder advertised as deployed.** VERIFIED. (`liveSeason.ts:2452-2456` TODO; the comment at `GameSessionAdapter.ts:583` says "the deploy sets it", which it doesn't; the FE kill switch `settings.py:50` is read by nothing; it still shows in /health.)
    - What an owner sees: a switch in health and settings that does nothing.
    - Fix: drop the setting and the false comment until slice 2 lands. **S**

15. **Real-time purge leftovers.** VERIFIED. ADR 0018 (Accepted) still says `GameWatcher` "stays built and off". The `idleSince`/`lastActivity` tracking is dead code with a misleading comment. The 0049 BDD step asserts "the watcher" (`orchestrator.ts:207-221`; `house_presence.steps.ts:354`; ADR 0018 lines 55 and 265).
    - What an owner sees: docs that suggest the house can still run in real time, plus a vestigial idle clock.
    - Fix: amend ADR 0018 and delete or rename `idleSince` and the step text. **S**

Honorable mentions:
- `exit-interview` is missing from the FE `submitDecision` schema enum, so the model can't submit it; only the card path works (S).
- No FE icons for the `comp-elimination`, `battle-back`, `day-break` and `self-eviction` beats (S).
- `GameSessionAdapter.ts` contains literal NUL separators (around lines 371 and 385), which make grep and ripgrep treat the 11k-line core adapter as binary (S).
- `emojiPicker.js` is dead (S).
