# Orwell — Pre-Launch Exhaustive Roast Ledger

> Companion to `AUDIT-LOG.md` (the careful VIEWED/VERIFIED trace ledger). This file is the
> **exhaustive roast** the owner asked for: every issue / bug / problem / thing-not-wired /
> playtest / UX smell, no matter how small, grounded in **current source (file:line)**.
> Single writer = the lead. Read-only specialists fan out and return findings; the lead
> reconciles, de-dupes, and logs here.

## Hard exclusion (owner directive, 2026-06-22)
**Do NOT roast anything `AUDIT-LOG.md` records as `VERIFIED-FIXED` / `VERIFIED`** (visually
re-confirmed in the playtest harness). Re-roasting a fixed bug is embarrassing. Every entry below
is either (a) OPEN / partial / deferred / latent in the ledger and **re-confirmed still-real in
current source**, or (b) **absent from the ledger entirely** and confirmed in source. The ledger
prose drifts — the code is the oracle, so every roast cites `file:line`.

## Severity legend
`[BLOCK]` launch-blocking · `[POLISH]` high-priority polish · `[LATENT]` latent/potential (same
mechanism, not yet firing) · `[NIT]` small/cosmetic · `[DOC]` documentation drift / not-wired claim

## Status
`PROPOSED` (specialist reported) · `CONFIRMED` (lead verified in source) · `VIEWED` (seen in
telemetry) · `ROOT-CAUSED` · `DUP` (already in AUDIT-LOG) · `REJECTED` (theory w/o mechanism, or
actually fixed) · `FIXED`

## Method
Real stack (TS engine :8765 = ground truth, FastAPI FE :7000), engine-is-truth oracle, harness in
`docs/audits/playtest-harness/`. Static code roast first (this pass), live two-window×device VIEW
to follow on the juiciest. No theory without a traced mechanism.

---

## GitHub issue tracking (added 2026-06-23)

Every actionable finding in this ledger is now tracked as a GitHub issue. **This ledger stays the
evidence record** (severity, mechanism → `file:line`, falsifier); GitHub Issues are the live status
tracker. Finding-code → issue map (roundup issues bundle several codes):

| Issue | Finding(s) |
|---|---|
| [#540](https://github.com/Psychout-Media/orwell/issues/540) | LIVE-7 |
| [#541](https://github.com/Psychout-Media/orwell/issues/541) | LIVE-4 |
| [#542](https://github.com/Psychout-Media/orwell/issues/542) | NARR-7 |
| [#558](https://github.com/Psychout-Media/orwell/issues/558) | SEC-1 |
| [#559](https://github.com/Psychout-Media/orwell/issues/559) | SEC-2 |
| [#560](https://github.com/Psychout-Media/orwell/issues/560) | SEC-3 |
| [#562](https://github.com/Psychout-Media/orwell/issues/562) | SEC-4 |
| [#563](https://github.com/Psychout-Media/orwell/issues/563) | SOC-NEW-2 |
| [#565](https://github.com/Psychout-Media/orwell/issues/565) | SOC-NEW-3 |
| [#567](https://github.com/Psychout-Media/orwell/issues/567) | SOC-NEW-4 |
| [#570](https://github.com/Psychout-Media/orwell/issues/570) | SYNC-FOCUS-1 |
| [#571](https://github.com/Psychout-Media/orwell/issues/571) | SYNC-RING-1 |
| [#574](https://github.com/Psychout-Media/orwell/issues/574) | NARR-8 |
| [#576](https://github.com/Psychout-Media/orwell/issues/576) | NARR-9 |
| [#578](https://github.com/Psychout-Media/orwell/issues/578) | NARR-10 |
| [#580](https://github.com/Psychout-Media/orwell/issues/580) | NARR-11 |
| [#582](https://github.com/Psychout-Media/orwell/issues/582) | SET-NEW-1 |
| [#585](https://github.com/Psychout-Media/orwell/issues/585) | ENG-NEW-3 |
| [#587](https://github.com/Psychout-Media/orwell/issues/587) | ENG-NEW-2 |
| [#588](https://github.com/Psychout-Media/orwell/issues/588) | ADM-NEW-2 |
| [#589](https://github.com/Psychout-Media/orwell/issues/589) | ADM-NEW-3 |
| [#590](https://github.com/Psychout-Media/orwell/issues/590) | RESP-NEW-1 |
| [#591](https://github.com/Psychout-Media/orwell/issues/591) | PERS-NEW-1 (A-S3) |
| [#592](https://github.com/Psychout-Media/orwell/issues/592) | PERS-NEW-2 |
| [#593](https://github.com/Psychout-Media/orwell/issues/593) | F-NEW-1 |
| [#594](https://github.com/Psychout-Media/orwell/issues/594) | F-NEW-2, F-NEW-3 |
| [#595](https://github.com/Psychout-Media/orwell/issues/595) | F-NEW-6 |
| [#596](https://github.com/Psychout-Media/orwell/issues/596) | F-NEW-7 |
| [#597](https://github.com/Psychout-Media/orwell/issues/597) | F-NEW-11, F-NEW-12 |
| [#598](https://github.com/Psychout-Media/orwell/issues/598) | A11Y-3, A11Y-6, A11Y-7, A11Y-8, A11Y-10, A11Y-11 |
| [#599](https://github.com/Psychout-Media/orwell/issues/599) | TX-1, TX-2, TX-3, TX-4, TX-5, TX-6 |
| [#600](https://github.com/Psychout-Media/orwell/issues/600) | F-NEW-4, F-NEW-5, F-NEW-8, F-NEW-9, F-NEW-10, F-NEW-13 |
| [#601](https://github.com/Psychout-Media/orwell/issues/601) | CAST-NEW-2, SET-NEW-2, SET-NEW-3 |
| [#602](https://github.com/Psychout-Media/orwell/issues/602) | CONT-1, CONT-2, CONT-3 |
| [#612](https://github.com/Psychout-Media/orwell/issues/612) | SOC-1 |
| [#613](https://github.com/Psychout-Media/orwell/issues/613) | NARR-3 |
| [#614](https://github.com/Psychout-Media/orwell/issues/614) | FEJS-1 |
| [#615](https://github.com/Psychout-Media/orwell/issues/615) | TRANS-1 |
| [#616](https://github.com/Psychout-Media/orwell/issues/616) | UX-1 |
| [#618](https://github.com/Psychout-Media/orwell/issues/618) | OPS-CI-1 |
| [#619](https://github.com/Psychout-Media/orwell/issues/619) | ENG-2 |
| [#620](https://github.com/Psychout-Media/orwell/issues/620) | NARR-1, NARR-4, NARR-5, NARR-6 |
| [#621](https://github.com/Psychout-Media/orwell/issues/621) | FEPY-1, FEPY-2, FEPY-3, FEPY-5 |
| [#622](https://github.com/Psychout-Media/orwell/issues/622) | FEJS-2, FEJS-3, FEJS-4, FEJS-5, FEJS-6 |
| [#623](https://github.com/Psychout-Media/orwell/issues/623) | EXPOSE-1, EXPOSE-2, EXPOSE-4, EXPOSE-5 |
| [#624](https://github.com/Psychout-Media/orwell/issues/624) | SOC-2, SOC-3, SOC-4 |
| [#625](https://github.com/Psychout-Media/orwell/issues/625) | RESP-1, RESP-2, RESP-3, RESP-4 |
| [#626](https://github.com/Psychout-Media/orwell/issues/626) | UX-2, UX-3, UX-4, UX-5, UX-6, UX-7, UX-8, UX-9, UX-10 |
| [#627](https://github.com/Psychout-Media/orwell/issues/627) | TRANS-2, TRANS-3, TRANS-4 |
| [#628](https://github.com/Psychout-Media/orwell/issues/628) | ENG-3, R-BND-1, R-BND-2, TEST-3 |
| [#629](https://github.com/Psychout-Media/orwell/issues/629) | DOC-1..DOC-8, R-DOC-1 |

Codes absent from this map are either already `VERIFIED-FIXED` in `AUDIT-LOG.md`, positives, or
environmental (e.g. OPS-1). The session-3 live-LLM findings (NARR-NEW-*, CARRY-*, NAME-1, EVT-1)
are mapped at the top of `ROAST-LOG-3.md`.

---

## Lead's own findings (pre-fan-out)

### R-DOC-1 · `[DOC]` · CONFIRMED · CLAUDE.md systematically understates the built feature set
- **Evidence:** `CLAUDE.md` says "through **0069**" / "drafted spec set (0001–0069)" in ≥4 places
  (status header, "Current status", "Open decisions"); but `docs/features/README.md` index ships
  **0070–0074** as ✅ Built (0070 off-screen texture, 0071 redaction/URL guards, 0072 multi-platform
  gateway, 0073 game-build CI wall, 0074 local HTTPS / ADR 0014).
- **Mechanism:** CLAUDE.md is hand-maintained prose; the feature index is reconciled against source.
  The two diverged when 0070–0074 merged without a CLAUDE.md sync. CLAUDE.md even lists ADRs
  "0001–0014" (so 0014/HTTPS is known) yet the feature prose stops at 0069 — an internal contradiction.
- **Why it matters:** CLAUDE.md is the FIRST doc a new implementer/agent reads ("read these first").
  Understating the built surface by 5 features mis-briefs every future contributor about what exists,
  what's wired, and what's launch-relevant (0071 redaction + 0072 gateway + 0074 HTTPS are all
  security-surface).
- **Confidence:** high. Falsifiable by a single grep; already cross-checked both files.

*(More findings appended below as the fan-out returns.)*

---

## Lane 2 — Engine boundary / adapters / MCP / Vault / composition

### R-BND-1 · `[LATENT]` · CONFIRMED (lead-verified in source) · 0070 off-screen-texture write-back bumps the closed-set `beatSeq` — the exact pattern the registry engineered *around*
- **Lens:** distributed consistency (optimistic CAS / lost-update) + architecture (ADR 0005 open-vs-closed split).
- **Evidence:** `src/adapters/engine/GameSessionAdapter.ts:4162-4163` (`recordOffscreenSceneTexture` → `this.persist()`); `:408-414` (`persist()` → `onPersist?.()`); `src/composition/registry.ts:573-586` (the wired `onPersist` = `commit()` → `session.bumpBeatSeq()` at `:583`). **Contrast that proves intent:** `registry.ts:430-443` — the next-season warm explicitly does NOT route through `commit` ("it must NOT bump `beatSeq`… or a BACKGROUND advance-warm would look like a board mutation… and trip a phantom desync"), using `invalidateSnapshot` + blind `saveUser` instead. FE trigger: `frontend/src/orwell_offscreen_texture.py` `kickoff_enrich` is a fire-and-forget `loop.create_task` voicing ≤6 scenes, each calling the write-back with **no `expectedBeatSeq`** and bypassing `_refresh_beat_seq` (`frontend/src/orwell_engine.py:470-476`). Test comment admits the unguarded bump: `tests/unit/offscreenTextureBoundary.test.ts:200-203` ("only textureOverrides and beatSeq (commit counter) differ").
- **Mechanism (lead-verified):** turn completes at `beatSeq=N`; FE refreshes last-seen to N; `kickoff_enrich` then bumps N→N+6 in the background while the player composes T+1. Dominant path (turn-start framing read picks up N+6 before any mutate) is SAFE. Residual race: a texture write commits *between* T+1's framing read (N+2) and its mutating call (carries N+2) → `StaleBeatError` → 409 `stale-beat`. For `advanceGame`/`submitDecision` it reconciles; for the `_backfill_with_cas` belts (`frontend/src/agent_loop.py:1725-1731`) the player's scene/deal/move is **reconciled-and-SKIPPED** — its only consequence fold dropped — attributed to a "genuine concurrent move" that was in fact *the engine's own enrichment task*.
- **Differential:** not a lost update (engine CAS prevents double-apply); not a leak (content-only, boundary-guarded `McpServer.ts:166-177`); distinct from the documented A-S3 latent (that posits a real second device — here the trigger is self-inflicted, so it reproduces in single-tab play). "Harmless, turn-start refresh always closes it" fails: enrichment is async/unbounded in completion vs the player's next mutate, so the interleave window is real (narrow).
- **Why it matters:** ADR 0005's spine — open-set prose must never perturb closed-set machinery. A flavor task can burn a stale-beat reconcile + model re-ground (an extra round, feeding the very S3-LOOP exhaust ADR 0011 fought) AND silently drop a player scene's consequence fold (mandate #4 non-degradation). The correct pattern already exists one function over.
- **Confidence:** high (bump traced end-to-end + test comment). **Falsifier:** route durability through `invalidateSnapshot(user)` + blind `saveUser(user)` (like `warmNextSeason`); a unit test `advance → read beatSeq=B → recordOffscreenSceneTexture → assert beatSeq===B` currently **fails** (returns B+1) and would then pass.
- **Harness-confirmable?:** yes, deterministically, no model: the Vitest assertion above. FE: a pytest that the 0070 path never threads `expected_beat_seq`.

### R-BND-2 · `[LATENT]` · CONFIRMED · `recordWorldSnapshot` shares the same `beatSeq`-bump smell (lower exposure)
- **Evidence:** `src/adapters/engine/GameSessionAdapter.ts:4105` (`recordWorldSnapshot` → `this.persist()`); FE driver `frontend/src/orwell_zeitgeist.py` (best-effort background task).
- **Mechanism:** identical to R-BND-1 but the zeitgeist is captured ONCE, at/just-after game start before the player is deep in mutating turns, so the interleave window rarely overlaps a CAS write. Same principle violation (open-set capture moving the closed-set counter); same fix (durability via `invalidateSnapshot` + blind save).
- **Confidence:** high on the bump, low on live impact. **Falsifier/harness:** same shape as R-BND-1.

**Lane-2 scope confirmed CLEAN (not roasted):** the four-place write-back gotcha is comprehensively closed — all six `GameSession` write-backs (`preSeedCast`, `preSeedNextSeason`, `recordCastProfile`, `recordWorldSnapshot`, `getOffscreenSceneSkeletons`, `recordOffscreenSceneTexture`) + `recordImageBeat` are wired in all four places with a `McpServer.callTool` boundary test each; no outward module imports `VaultStore`/`VectorIndex`/`SoulProvider`; the single restart door holds (`registry.resetUser`); the `beatSeq` commit funnel bumps once-per-commit and rolls back on a refused checkpoint; the SQLite store serializes the whole snapshot as JSON so new fields round-trip without schema drift. **Lane-2 structural smell:** there's no *enforced* seam for "open-set fail-soft write-back persists WITHOUT bumping `beatSeq`" — the correct pattern lives as a prose comment on one call site (`registry.ts:432-443`), so the next two background write-backs to ship both silently took the wrong channel. Same "typechecks, passes arch, wrong at runtime" trap as the dispatch gotcha, but on the consistency axis.

---

## Wave-1 tally (8 static lanes complete, 2026-06-22)
~40 findings. Highest-signal NEW (lead-verified): **ENG-1** (sleep clock ships ON, uncalibrated, anti-sycophancy tilt), **SOC-1** (emergent blocs never surfaced as structure), **NARR-3** (no structural cast-invention guard — bites on `-flash`), **R-BND-1** (open-set write bumps `beatSeq`), **FEPY-1** (casting error renders as GM narration), **FEPY-4** (concurrent stale-409 drops a scene's only consequence fold). Plus a substantial **doc-drift** cluster (DOC-1..8) and two latent **public-exposure security** gaps (EXPOSE-1/2).

---

## Lane 1 — Engine domain core & mechanics (`src/domain`, `src/engine`)

### ENG-1 · `[LATENT·high]` · CONFIRMED (lead-verified) · The time-of-day sleep penalty ships **ON** in the deployed game but **no calibration gate runs that path** — an uncalibrated, player-favoring anti-sycophancy tilt
- **Lens:** anti-sycophancy (mandate #3) + behavioral fidelity + MDA (a static stat laundered as a per-night choice).
- **Evidence:** `frontend/src/settings.py:35` `"time_of_day_enabled": True`; `frontend/routes/chat_helpers.py:77` pushes it to the live engine at boot; `src/adapters/engine/GameSessionAdapter.ts:3001-3010` `timeOfDayOverride` overrides the `ORWELL_TIME_OF_DAY` env default; engine comment `:2997` confirms golden sims set neither ⇒ stay OFF. Penalty math: `liveSeason.ts:869` `npcRestDeficit(stats)=restDeficitFor(bedtimeFor(stats))`; `timeOfDay.ts:103-108` `bedtimeFor = social − physical` (≥0.12 ⇒ late-night ⇒ deficit 1.0); `competitionOutcome.ts:118` `rest = −restPenalty × sleepPenalty(0.15)`. Calibration gates run clock-OFF (`juryReachShared.ts:104`).
- **Mechanism:** an NPC's comp rest penalty is a pure function of its **static** `social − physical` aptitude, recomputed every comp all season, decoupled from what it did that night. Social archetypes carry a permanent ~−0.15 malus (~42% of the temperature band) into every comp; comp-beasts never pay; the **player's** deficit is dynamic and avoidable via the player-only `turnIn` lever. So a savvy human gains an edge the social NPCs structurally cannot escape — on the path the deploy actually runs, which no gate measures.
- **Differential:** not a determinism leak (byte-stable); not a spine regression (band runs OFF). The defect is the deploy-on path being unmeasured + the asymmetry. CLAUDE.md's "opt-in default off" is true of the gates, **false of the shipped product** (cross-ref R-DOC drift).
- **Confidence:** high on mechanism/asymmetry/default-on; med on player-impact magnitude (depends on `turnIn` discoverability). **Falsifier:** re-derive `npcRestDeficit` from each NPC's actual simulated bedtime, OR ship clock-OFF, OR add a clock-ON jury-band gate.
- **Harness-confirmable?:** yes — play a clock-ON seeded season, compare social-archetype vs comp-beast comp-win rates against the spine; or assert `restOf(socialNpc)===1.0` on turn 1 before any night occurred.

### ENG-2 · `[LATENT]` · PROPOSED · `diffuseGossip` internal defaults diverge 3.2× from the named `GOSSIP` tunables
- **Evidence:** `src/engine/gossip.ts:125-126` `transmitProb = deps.transmitProb ?? 0.8` vs `GOSSIP.transmitProb = 0.25` (`:43-48`). Both live callers pass the constant (`orchestrator.ts:578`, `registry.ts:222`) ⇒ dormant.
- **Mechanism:** the fallback contradicts the module's declared spread rate by 3.2×; a future caller/test relying on the default silently gets a wildly over-diffusing rumor layer. Maintenance trap of exactly the "a contradictory constant is a lie" class the codebase audited out elsewhere (E52/E53). Fix: `?? GOSSIP.transmitProb`. **Confidence:** high (literal mismatch).

### ENG-3 · `[NIT]` · PROPOSED · Dead `% pool.length` in `nextHouseEvent`
- **Evidence:** `src/engine/houseEvents.ts:71` `pool[Math.floor(rng.next()*pool.length) % pool.length]` — `rng.next()∈[0,1)` so the modulo is unreachable. Cosmetic dead-branch; the substring-coupled prev-line dedup is fine at current 12-line content.

**Lane-1 CLEARED (not roasted, explicitly checked):** all hard rules correct (outgoing-HOH bar incl. double-eviction 2nd cycle; veto-winner-not-replacement in every path; HOH tie-break; jury-of-9; last-evicted-juror tiebreak; veto field of 6 + Houseguest's-Choice; intent locked pre-result); staged-comp byte-identity holds (`stagedTrajectoryNeutral.test.ts`); zero determinism leaks in `src/domain`+`src/engine`; no decorative constants; anti-sycophancy otherwise intact (`EARNED_WINS≥2` guard); non-degradation intact (6-signal round-trip); Vault holds (overhear surfaces a 60% prefix only). **Lane-1 smell:** the sleep economy is the one place a static stat is laundered into a pseudo-behavioral consequence, asymmetrically + uncalibrated + on-by-default.

---

## Lane 3 — FE Python (agent loop / routes / services)

### FEPY-1 · `[POLISH]` · PROPOSED · Casting / new-chat **mid-stream** upstream error renders inside the "Big Brother" GM bubble (F-S4-C OPEN sibling, Python contributor)
- **Evidence:** `frontend/src/agent_loop.py:3464-3467` converts a mid-stream `data:{"error":…}` into a reply-channel `delta` (`*[Stream error: …]*`, no `thinking` flag) ⇒ renders as body text; a no-game send force-escalates to agent mode (`chat_routes.py:600-601`) so a casting 502/503/504 hits this path.
- **Mechanism:** the in-game F-S4-C fix reclassified only the *pre-stream* `!res.ok` holder to `.msg-system`; the *mid-stream* error stays a body delta in the `msg-ai` bubble with the "Big Brother" label ⇒ a gateway outage reads as in-fiction producer narration (immersion break). **Why it matters:** two fresh tabs or any casting turn during an OpenRouter blip. **Fix:** emit a typed `error` SSE here (Python) and/or reclassify the inline delta (JS). **Confidence:** high.

### FEPY-2 / NARR-2 · `[LATENT]` · CONFIRMED-by-two-lanes · A DeepSeek answer routed entirely into the **reasoning** channel → blank public GM bubble; body never recovered
- **Evidence:** `frontend/src/agent_loop.py:2588-2609` (`_empty_response_fallback` returns `(round_reasoning, None)`) + caller `:4653-4657` (`if _fallback_chunk:` false ⇒ nothing yielded to body). JS side `chat.js:2910,2947-2953` (empty-body fallback only recovers inline `<think>` tags, not channel-routed reasoning).
- **Mechanism:** reasoning deltas are tagged `thinking:true` ⇒ accordion only. When V4 misroutes the *answer* into `reasoning_content` (empty `content`), the fallback recovers it for persistence/return but **not** the visible bubble, AND bypasses the empty-response error ⇒ blank GM bubble + populated Thinking accordion. Asymmetric with the JSON/tool extractors which DO read `reasoning`. **Tier:** Flash's heavier reasoning makes the misroute likelier ⇒ a Pro↔Flash drift surface. **Confidence:** high mechanism, model-stochastic trigger. **Falsifier:** a server site re-emitting reasoning as a non-thinking body delta on empty content — none.

### FEPY-3 · `[LATENT]` · PROPOSED · Per-class `max_tokens` is **not** runtime-editable (ADR 0010 follow-on claimed-but-unwired)
- **Evidence:** `frontend/src/token_policy.py:74` ("no settings override yet"), `:90-91` (`max_tokens = _DEFAULT_MAX_TOKENS[class]` unconditional; only `effort` reads the admin override). Narration cap = **4096** (`:41`). No `appliedMaxTokens`/`finishReason` envelope field.
- **Mechanism:** only reasoning *effort* is admin-tunable; the output *cap* is hardcoded, so a deployment hitting narration truncation can't raise it without code, and nothing tells the admin which cap bit. **Confidence:** high.

### FEPY-4 · `[LATENT]` · PROPOSED (ties A-S3) · A peer-induced stale-409 **silently drops a scene's only consequence fold** (non-degradation mandate #4)
- **Evidence:** `frontend/src/agent_loop.py:1711-1736` (`_backfill_with_cas` reconciles then `return None` ⇒ skipped); the 0055 guarantee routes through it (`_auto_record_scene` `:2070-2073`), same for `makeDeal` (`:2234`), `moveTo` (`:1824`). The compensating `_DESYNC_REGROUND` re-grounds but does NOT re-issue the dropped `recordInteraction`.
- **Mechanism:** two-tab play, a peer's serialized advance bumps `beatSeq` between framing and the belt's mid-turn write ⇒ 409 ⇒ the fold (the only record of a social beat) is dropped; the "re-derives next turn" comment is aspirational (player has moved on). **This is the live trigger BND-1 makes single-tab reproducible** (the engine's own enrichment task can be the "peer"). **Confidence:** med-high it drops, high that nothing re-banks. **Falsifier:** a deferred-retry queue re-issuing the skipped record — absent.

### FEPY-5 · `[NIT/LATENT]` · PROPOSED · `orwell_cast_authoring` write-back silently no-ops on a falsy `accepted` (no log)
- **Evidence:** `frontend/src/orwell_cast_authoring.py:232-237` logs on *exception* but drops a `{accepted:False}`/non-dict return at `:237` with no log line (unlike `orwell_prewarm`/`orwell_zeitgeist` which log refusals). **Mechanism:** the four-place-gotcha's observability blind spot — a genuinely rejected `recordCastProfile` is invisible. **Confidence:** high.

**Lane-3 CLEARED:** A-S5 structured-409 is fully built (`orwell_engine.py:204-214`, consumed code-first `chat_helpers.py:695,714`); ADR 0011 beat-aware suppression resets the right counters (`agent_loop.py:3827-3829`); cold-start two-session window is closed **server-side** (residual is the JS lane); 0071 log redaction installed + effective. **Lane-3 smell:** the FE "error-corrects the model" lattice (~12 nudge/belt/CAS mechanisms) was retrofitted from a sole-writer assumption to a concurrent-writer reality one patch at a time, with **no single per-turn reconciliation owner** — FEPY-2 (model misroute) and FEPY-4 (peer mutate) are the same root: a fold/answer falls through a gap no component owns.

---

## Lane 4 — FE JS client (`frontend/static/js/`)

### FEJS-1 · `[LATENT]` · CONFIRMED (lead-verified) · Per-user client-storage keys collapse to one shared namespace — `data-user` is never set
- **Evidence:** grep of `app.py`/`index.html`/`routes` for `data-user` ⇒ **nothing** (only `data-game-build` is injected, `app.py:886`). 12 readers collapse to `…:""`: `orwellOnboarding.js:217`, `orwellWindow.js:251/268/582`, `orwellGadgetRail.js:219`, `orwellComposerDraft.js:33`, `orwellStatusPanel.js:63`, `orwellCastPin.js:31`, `orwellPremiereTutorial.js:27`, `orwellChatHint.js:44`, `orwellSlots.js:68`, `settings.js:1760`.
- **Mechanism:** `body.dataset.user` is `undefined` ⇒ two accounts on the same browser profile (logout→login) share one keyspace: user B skips welcome (A saw it), may see A's composer draft, inherits A's window geometry/gadget order/cast-pin. Engine cross-user isolation is independently clean (AUDIT-LOG §2.12) — this is purely client-storage namespacing. **Confidence:** high attr-unset, med severity (depends on shared-device multi-account being supported). **Fix:** inject `data-user` like `data-game-build`.

### FEJS-3 · `[POLISH]` · PROPOSED · `orwell:gamechanged` allowlist omits 8 mutating beats (latency, not staleness)
- **Evidence:** `chat.js:2418-2419` allowlists 7 tools; omits `moveTo`/`moveHouseguest`/`makeDeal`/`markHouseguestMet`/`turnIn`/`surfaceInformationTo`/`diaryRoom`/`recordImageBeat` (all real beats). **Differential downgrade:** the turn-end catch-all `orwellGameChanged('turn-settled')` (`chat.js:3326`, above the `_isBg` gate) fires on every terminal path ⇒ the 8 tools refresh ~250ms after settle, not mid-stream. So a sub-second parity asymmetry on long multi-tool turns, not persistent staleness. **Cross-ref SYNC-STALE** (below) for the meatier Python-side gap.

### FEJS-4 · `[LATENT]` (ADR 0011 deferred) · PROPOSED · Per-round AI bubbles `display:none`'d, never unmounted, for the life of a turn → O(rounds) hidden DOM
- **Evidence:** each `agent_step` creates a fresh `.msg-continuation` bubble (`chat.js:2736-2752`); prior round hidden not removed (`:2722,2228,2953,2992`); no per-round `.remove()`. A 20-round spin leaves ~19 hidden bubbles. **Confidence:** high.

### FEJS-5 · `[LATENT]` (ADR 0011 deferred) · PROPOSED · Per-round reasoning accordions accumulate inside the hidden bubbles; only <20-char noise pruned
- **Evidence:** live accordion built per round (`chat.js:1601-1648`); only prune is `<20`-char noise (`:1723`). N rounds → N retained accordions in hidden DOM. Compounds FEJS-4.

### FEJS-2 · `[NIT]` · CONFIRMED · `window.settingsModule` fallback in onboarding is dead — the global is never assigned
- **Evidence:** `orwellOnboarding.js:298` reads `window.settingsModule`; `settings.js:5490-5493` exports a **module** default, no `window.settingsModule =` anywhere. Degrades correctly (clicks `#user-bar-settings` first) so dead code, not a break. (Confirms A-settingsModule latent.)

### FEJS-6 · `[NIT]` · PROPOSED · Dead stall-banner machinery orphaned behind the deliberately-disabled watchdog
- **Evidence:** `_startStallWatchdog` (`chat.js:3597-3603`) is an intentional no-op; its `#stall-banner` builder (`:3564-3596`) + state (`:37-41`) are unreachable. Confirmed nothing re-arms it. Cleanup only.

**Lane-4 CLEARED:** reasoning-channel split is sound (no regex-extract-reply-from-merged; the merged-buffer renders all route through `markdown.js processWithThinking` which scrubs reasoning/`npc:`/asides); g15 single-dispatcher holds (no ad-hoc `new CustomEvent('orwell:gamechanged')`); live↔reload render paths **currently converge** (same `processWithThinking`, role-mask, `msg-continuation`, beat cap). **Lane-4 smell (A-render confirmed real, benign, fragile):** two duplicated render engines (`chat.js` live + `chatRenderer.js` reload) hand-mirror every body-shaping rule with paired "matches the live path" comments and **no shared seam** — the reasoning-scrub convergence (where a drift becomes a *leak*) survives only because both happen to funnel through `processWithThinking`. Fix: a shared `renderAssistantBody()` helper.

---

## Lane 5 — Tests / CI / unwired specs

### TEST-2 · `[LATENT]` · PROPOSED · `recordImageBeat` is the one FE-driven write-back without the mandated `McpServer.callTool` **boundary** test
- **Evidence:** its functional assertion (`tests/unit/portraitPrompts.test.ts:216`) calls the adapter directly; `grep "callTool('recordImageBeat'"` ⇒ empty. The dispatch case is live today (`McpServer.ts:129,301`) and the `liveSentinel` sweep would catch a *fully dead* case — but **not** the historically-real silent-no-op-at-the-boundary (the exact way `recordCastProfile`/`recordWorldSnapshot` shipped dead). **Why it matters:** a silent boundary no-op means shown 0051 images leave no memory event, undetected.

### OPS-CI-1 (= TEST-1 = EXPOSE-3) · `[POLISH]` · CONFIRMED-by-two-lanes · `deploy/expose/host-hardening.sh` is parse-checked + security-linted by **nothing**
- **Evidence:** CI `.github/workflows/ci.yml:322` `for s in deploy/*.sh` (non-recursive); `tests/unit/opsPrivateRepo.test.ts:22` reads `deploy` non-recursively; `find deploy -name '*.sh' -mindepth 2` ⇒ exactly this one file. **Mechanism:** both the `bash -n` syntax gate AND the E84 `curl|bash`/`raw.githubusercontent` security lints skip the one script in `deploy/expose/` — the public-internet hardening script. A syntax error or an introduced remote-pipe ships green. **Fix:** `find deploy -name '*.sh'` / `git ls-files 'deploy/**/*.sh'`. **Confidence:** certain.

### TEST-3 · `[NIT]` · PROPOSED · 14 `docs/features/*.feature` files are un-executable orphans (gated elsewhere, but never run as Gherkin)
- **Evidence:** `.feature` for 0010/0022/0029/0032/0033/0036/0051/0053/0064/0066/0067/0068/0069/0074 exist (e.g. 0064=19 scenarios) but are absent from `cucumber.cjs` paths; zero step defs for 0064/0066/0067/0068/0069/0074. **Differential:** no *coverage* hole (each is gated by FE/unit tests, verified) — but the `.feature` files read as executable contracts that never execute; **0036** even has a `.feature` while its README gate is `unit`. **Fix:** a `spec-only` marker or shelf + a meta-test.

### TEST-4 · `[NIT/disclosed]` · PROPOSED · 16/20 `tests/property/*` are seeded fixed-loop, not fast-check (already disclosed, audit T18)
- **Evidence:** only 4 import fast-check. Down-rated: for distribution claims a fixed seeded set is the right tool; naming smell, not a fitness gap. `replayability`/`outcomes` would benefit from generative coverage but aren't currently making claims their fixed seeds falsify.

**Lane-5 CLEARED:** no `.only`/`.todo`/`xit`/`fdescribe` committed; exactly 1 non-env skip (env-gated `fastembedReal`); anti-sycophancy `juryReach`/gradient gates have real per-win `EARNED_WINS` teeth + completeness checks; sharded heavy lanes can't vacuously pass; CI path-filter has no engine-skip hole; no names-in-tests violation; Vault-Wall depcruise is default-deny + tripwire. **Lane-5 smell:** the gate layer leans on **one generic Vault-leak sweep (`liveSentinel`) as a stand-in for per-tool boundary-functional tests** — it proves *no leak* for every tool but *nothing about whether each tool did its job*; that asymmetry is exactly how write-backs silently no-op'd. A single "every write-back, dispatched through `callTool`, produces its expected mutation" meta-test closes it.

---

## Lane 6 — Deploy / ops / docs drift

### EXPOSE-1 · `[LATENT]` · PROPOSED · Public-profile boot guard omits the bind-host check
- **Evidence:** `frontend/core/middleware.py:199-216` unsafe-set = `{AUTH_ENABLED=false, LOCALHOST_BYPASS=true, SECURE_COOKIES!=true, ALLOWED_HOSTS unset/"*"}`; no `ORWELL_BIND_HOST` check though the status route computes `bindHost` (`admin_public_deployment_routes.py:149`). **Mechanism:** an operator setting `ORWELL_PUBLIC=1` (all pass) + `ORWELL_BIND_HOST=0.0.0.0` (a one-line edit the unit comment invites) boots green on all interfaces, bypassing the cloudflared/Caddy perimeter. LATENT (auth still on ⇒ exposed-but-authenticated). **Falsifier:** `assert_public_profile_safe({ORWELL_PUBLIC:1,…safe…,ORWELL_BIND_HOST:0.0.0.0})` raises.

### EXPOSE-2 · `[LATENT]` · PROPOSED · Cloudflare connector token passed on the `cloudflared` argv
- **Evidence:** `deploy/orwell-ops-public-deployment.sh:206` `cloudflared service install "$(cat "$TOKEN_FILE")"` — token on argv (readable in `/proc/<pid>/cmdline`); the DNS-token sibling (`orwell-ops-tls.sh:116`) deliberately uses an **env var** "so it never shows in ps". The inconsistency is the tell. File lifecycle is otherwise exemplary (0600, shredded). **Fix:** env-var the token.

### EXPOSE-4 · `[POLISH]` · PROPOSED · `host-hardening.sh` ufw reset→allow→enable is a non-atomic remote-lockout window
- **Evidence:** `deploy/expose/host-hardening.sh:25` `ufw --force reset` → `:30/:32` SSH allow → `:42` enable, under `set -Eeuo pipefail`. A failure between reset (defaults deny-incoming) and the SSH allow aborts with no SSH rule ⇒ remote lockout; every re-run `reset`s, discarding coexisting rules. **Fix:** allow-SSH-first / set rules without `reset`.

### EXPOSE-5 · `[NIT]` · PROPOSED · `orwell-https.sh` interactive gate keys on never-assigned `MODE_GIVEN`
- **Evidence:** `deploy/orwell-https.sh:166` `-z "${MODE_GIVEN:-}"`; `grep 'MODE_GIVEN='` ⇒ none (the real flag is `MODE`). The TUI-suppress guard is dead; harmless in the always-`--yes` ops path. (shellcheck SC2154.)

### DOC-1..8 · `[DOC]` · CONFIRMED (R-DOC-1 is the headline; these extend it) · Systematic one-directional "ceiling freeze" across every orientation doc
- **DOC-1** `CLAUDE.md` never mentions 0070–0074 ("feature-complete through 0069"; `grep '007[0-4]'`⇒0). **DOC-2** `README.md:25-27,522-524` calls 0070–0073 "authored and queued, not yet built" — all shipped (PRs #504–#511). **DOC-3** `README.md:557` "ADRs 0001–0013" but ADR 0014 exists + built (`decisions/README.md:21`); CLAUDE.md correctly says 0014 ⇒ the two top docs disagree. **DOC-4** `CLAUDE.md:443` local-run uses FE port **7000** — appears in no other source (prod default 8080: `INSTALL.md:47,141`, `orwell-frontend.service:42`); the brief's "FE 7000" premise inherits this. **DOC-5** `CLAUDE.md:452` omits 6 existing deploy scripts (the whole TLS + public-exposure control surface). **DOC-6** `IMPLEMENTATION_QUEUE.md:7-15` "queue drained / every batch ✅ DONE" stops ~9 features short (newest is 0065). **DOC-7** `docs/CLAUDE_CODE_INSTRUCTIONS.md:45` (the "start here" brief) says "through **0050**" — 24 features stale. **DOC-8** `docs/features/README.md:56` audit-scope says "Every feature **0001–0063** cross-checked" while its own index runs to 0074 — the drift-proof anchor has an internally inconsistent scope line.

**Lane-6 CLEARED:** deploy lane is unusually mature — consistent `set -Eeuo pipefail`, `sanity_path` depth-guards before every `rm -rf`, idempotent env upserts, fail-closed boot guard, secret shredding, correct `pct` host-bridge + `bbai` fallback, A4 local-copy rule. **All three reset-tier contracts honor their claims** (game-reset preserves accounts/LLM config; factory-reset `exec`s oobe-reset; oobe keeps keys+models). systemd hardening (E85) solid. Cast/jury/F2/veto counts + engine port 8765 consistent everywhere. **Lane-6 smell:** the prose froze at staggered ceilings while the *scripts* were extended in lockstep — so the risk is a contributor/operator not knowing the public-exposure + local-HTTPS subsystem (where EXPOSE-1/2 live) even exists.

---

## Lane 7 — Narration fidelity & prompts (DeepSeek V4 Pro/Flash)

### NARR-3 · `[LATENT·near-block on -flash]` · PROPOSED · "EXACT names, never invent" is **prompt-only** — zero structural roster-validation backstop
- **Evidence:** the rule lives entirely in `src/engine/momentPrompts.ts:245-251` + reinforcements (`:518-523,846-849`) + woven roster (`:723-747`); no FE/engine surface validates a narrated name against `state.house[].name`. The only pre-emission guards are the closed-set outcome guard (`chat_helpers.py:954-994`) and the evicted-in-a-room guard (`:1044-1065`) — neither checks name existence.
- **Mechanism:** houseguest **invention** (the most immersion-shattering grounding break, by the prompt's own "THE most important rule") is caught by **nothing** structural — enforcement = model compliance. S3-CORE's "0 inventions" was on `-pro`; the moment runtime config points at Flash (the tier the AUDIT-LOG itself says "invents cast"), an invented name reaches the player unchecked, while strictly-less-critical outcomes/placements DO have guards. The asymmetry is the launch risk. **Falsifier:** wire Flash, diff every Capitalized two-token name in the DOM against `/api/orwell/state`.

### NARR-1 · `[LATENT]` · PROPOSED · Gateway (0072) reasoning scrub is inline-`<think>`-only AND its narrator import is **dead**
- **Evidence:** `frontend/gateway/handler.py:180-181` `from src.agent_loop import _resolve_llm_fn` — but `_resolve_llm_fn` is defined in `orwell_cast_authoring.py:255` (takes `owner`), **not** in `agent_loop` (AST-confirmed) ⇒ `ImportError` caught ⇒ the gateway **always** returns the "not configured" placeholder (never narrates). `scrub.py:20` strips only inline `<think>` tags, not DeepSeek's separate `reasoning` channel or natural-language operator asides. Non-launch-critical surface but a real reasoning-leak/blank transport — the uncovered transport the browser channel-split never covered.

### NARR-4 · `[POLISH]` · PROPOSED · No tier-aware handling anywhere — identical prompt + absent `max_tokens` for Pro and Flash
- **Evidence:** only `flash` refs in `src/`/`routes/`/`js/` are loop-breaker *comments*; no code branches on the resolved model id for prompt length / output cap / verbosity. **Mechanism:** Flash bills reasoning against a 65,536 cap (vs Pro 384,000) and is verbose ⇒ mid-sentence truncation materially likelier, but the F-S4-D `Continue ▸` affordance is tier-blind, and nothing clamps verbosity or sizes UI per tier.

### NARR-5 · `[LATENT]` · PROPOSED · Dormant `token_policy.narration max_tokens: 4096` — resolved every turn, never applied; a pre-armed reasoning-truncation trap
- **Evidence:** `frontend/src/token_policy.py:41` (4096) resolved at `agent_loop.py:3071` but `_apply_reasoning_budget` (`llm_core.py:585-622`) consumes only `policy["reasoning"]`; no consumer of `policy["max_tokens"]`. Today dead (matches "no explicit max_tokens"). The moment the ADR-0010 follow-on wires it (the documented next step), narration hard-caps at 4096 — the exact reasoning-truncation the Anthropic fallback was raised 4096→8192 to avoid. **Gate:** any PR wiring `policy["max_tokens"]` must raise narration off 4096 first. (Ties FEPY-3.)

### NARR-6 · `[LATENT]` · PROPOSED · F-S4-F resume-path roster-reconstruction gate still ABSENT
- **Evidence:** resume replays a **buffered run** (`chat_routes.py:1362-1364`, `session_events.py:35-42`) — it does not re-frame; a one-time mid-gen name drift in the buffer replays verbatim, never reconciled. S3b recommended a gate asserting the resumable-stream path reconstructs the full seeded roster; it doesn't exist. Narrow (new turns re-ground fully) but a refactor could widen it.

**Lane-7 CLEARED:** engine prompt assembly is clean — `renderGameContext`/`buildSystemPrompt`/`portraitPrompts`/`imageConstants` read only Vault-free fields (no stats/souls/hiddenElements/privateStrategy/aptitudes enter a prompt); the FE weaves no game facts of its own; B61 cast-voice walling holds; prompts hand the model **facts to voice, not scripts to recite** (ADR 0003 smell absent). **Lane-7 risk:** NARR-3 — the one grounding rule the prompt calls most important has the weakest (wording-only) enforcement, and it fails exactly on the tier the audit says invents cast.

---

## Lane 8 — Social game: emergent-drama structure & legibility

### SOC-1 · `[LATENT·near-block for genre fidelity]` · CONFIRMED (lead-verified: zero bloc surface in player-facing layers or `renderGameContext`) · Emergent bloc/coalition structure is computed + decision-load-bearing but **never surfaced as structure** to narrator or player
- **Evidence:** `src/engine/blocs.ts:78-159` builds clique-like multi-party blocs (`sharedTarget`/`cohesion`/`loyaltyStrength`), consumed in noms+votes (`season.ts:106-109`, `liveSeason.ts:739,752,1376`). **No player projection references blocs** (lead-verified grep of `src/services`/`src/surfaces`/`frontend/static/js` ⇒ 0). The narrator's standing context `renderGameContext` (`momentPrompts.ts:673-875`) carries week/phase/ceremony/whereabouts/showmances/per-HG vibe but **no bloc structure**; `npcVoice` returns only **pairwise** flat labels (`relationships.ts:45-57`); `socialRead` returns counts + a binary unease hint.
- **Mechanism:** the only social-structure data crossing to the narrator is N independent pairwise edge-labels — there is no path that hands it the **bloc as an object**. So the narrator can voice "Maya is wary of you" but never "Maya, Dana, Griffin have hardened into a three targeting you," because it is never told. The player must reconstruct a coalition from N separate vibes, and the bloc that decides their eviction is an unattributable black box. The panopticon-engine sees every alliance; the watcher it surveils sees only fragments — and the coalition only becomes legible in the post-season retrospective.
- **Differential:** not Vault secrecy (blocs derive from the **public** bond read; 0002 forbids *storing* an alliance object, not *surfacing a derived read*); not covered by pairwise `npcVoice`; distinct from "player forms own reads" (that forbids a threat *meter*, not perceiving an alliance *exists* — the genre's central readable object). **Confidence:** high (absence exhaustively grep-confirmed both by the specialist and the lead). **How the rig VIEWs it:** a `-pro` season passes every grounding check yet feels socially flat — the player is blindsided by coordinated votes with no narrative means to read them coming.

### SOC-3 · `[POLISH]` · PROPOSED · Deal-break drama reaches the player as one log line + a silent sidebar recolor — thin ceremony weight on the marquee social beat
- **Evidence:** a broken player-party deal surfaces as a single witnessed event (`GameSessionAdapter.ts:3452-3454`) + the deals panel recoloring a row (`orwellDeals.js:91,135-165`) on the next poll; the status panel doesn't announce breaks (`announceDeltas` covers only phase/HOH/noms/veto). **Mechanism:** the consequence loop is intact (betrayal-shock + jury demerit + reveal), but presentation has no decision-card-style reveal/announcement — betrayal degrades to a passive state change unless the narrator dramatizes it well, and the under-call family makes that unreliable (worse on Flash). **Ties A-S3/FEPY-4** (a dropped fold erases the beat entirely).

### SOC-4 · `[LATENT]` · PROPOSED · Gossip can move the house against the player, but the standing player-read is content-free and the rumor→player content path is narrator-call-dependent — dramatic-irony asymmetry runs one direction
- **Evidence:** `gossip.ts:108-180` diffuses NPC→NPC and reaches the player only if a chain terminates at them (`:99-100`) AND the narrator calls `surfaceInformationTo`; the only *standing* read `socialRead` (`PlayerSurface.ts:88-91`) is a count + binary unease, never content/provenance. No engine auto-surface of a terminated rumor (unlike the deal-break `onPlayerEvent`). **Mechanism:** given the model under-call tendency, the rumor mill churns (moving NPC votes) while the player gets only generic unease — the irony payload (catch a fragment, suspect, act) rarely fires.

### SOC-2 · `[POLISH]` · PROPOSED · Standing *alignment* legibility absent (vote-count correctly constrained by secret ballot)
- **Evidence:** `orwellStatusPanel.js:295-368` renders titles (Week/Phase/HOH/Noms/Veto/own-badge) — glanceable + engine-accurate — but no who-aligns-with-whom read; `VisibleStateService` has no tally field. **Differential:** a persistent vote tally would break secret-ballot anonymization (correctly avoided); the real gap is SOC-1's alignment read, not the count. POLISH.

**Lane-8 steelman (CLEARED):** coalition/betrayal is **mechanically meaningful, not cosmetic** — `voteChoice` (`liveSeason.ts:731-744`) blends threat×paranoia + `blocTerm` − dealHonor − juryMgmt − bondKeep, all bounded; blocs vote together because every member derives the same bloc; deals fold real consequence (betrayal-shock + jury demerit + reveal); gossip moves third-party minds; the Diary Room wall is structural (`diaryRoom.ts:22-33`); jury management is the dominant finale term. **Lane-8 smell:** Orwell computes genuinely emergent coalition structure and renders **none of it as structure** — the surveillance apparatus never shows the watcher what it sees, which is the one thing the genre exists to do (SOC-1).

---

## Cross-cutting (de-duped across lanes)

### SYNC-STALE · `[LATENT]` · PROPOSED · FE-driven background write-backs mutate engine state but fire **no** `_publish_game_updated` SSE and **no** JS dispatch
- **Evidence (Lane-3/4 convergence):** `preSeedCast`/`recordCastProfile`/`recordWorldSnapshot`/`recordOffscreenSceneTexture`/`preSeedNextSeason` run as background tasks (`frontend/src/orwell_*.py`); `_publish_game_updated` has only 3 callers (`routes/orwell_routes.py`). **Mechanism:** an open page stays stale until the next 20–30s poll after a background enrichment lands — a real eventual-consistency lag (distinct from R-BND-1's beatSeq-bump, same family). **Cross-ref R-BND-1, FEJS-3.**

---

## Wave 2 — Responsive / cross-platform (static)

### RESP-1 · `[POLISH]` · PROPOSED · Minimized-window dock row's only close is a 16px hover-faded `×`; E95 removed the drag-close touch equivalent
- **Evidence:** `style.css:1137-1143` (`.minimized-dock-x` 16×16, opacity 0.4, `:hover`→1); `modalManager.js:376-380,392-398` (E95 sidebar row: body-click *restores*, "no drag", so the `×` is the sole close); stale CSS comment `style.css:962-964` still advertises the removed drag-to-trash model.
- **Mechanism:** any minimized kit window (status/cast/retro/presence/finale) docks as a "Windows" sidebar row = the mobile drawer representation; its only close is a 16px glyph failing WCAG 2.5.5 (44) and even 2.5.8 (24), at opacity 0.4 permanently on touch (no hover). **Differential:** not a pointer-affordance-with-touch-equivalent — E95 deleted the drag-close, so the tiny `×` is the literal close on all platforms; not hidden on mobile (grep empty). **Confidence:** high static; falsifier: if the kit forbids minimize ≤768px (then unreachable→LATENT). **Fix:** add `.minimized-dock-x` to the J5-01 `@media (hover:none) and (pointer:coarse)` floor (`style.css:36671`).

### RESP-2 · `[POLISH]` · PROPOSED · Cast-panel `.oc-pin` (28px) + `.oc-backfill` (32px) below the 44px touch floor, excluded from the J5-01 fix
- **Evidence:** `orwellCast.js:156,164,170-172` (min-height 28/32, mobile block only sets `width:auto`); J5-01 floor `style.css:36671-36682` targets chrome selectors only, not panel-body buttons. **Mechanism:** "Generate cast portraits" (`.oc-backfill`) is a universal action rendered on mobile at 32px — undersized tap. **Differential:** not reflow (fixed sub-floor heights); not hidden on mobile; not covered by J5-01 (selector inspection). **Fix:** add the cast-panel body buttons to the J5-01 coarse-pointer floor.

### RESP-3 · `[NIT]` · PROPOSED · Per-message `.copy-btn` is hover-only with no touch fallback (the code-block buttons have one)
- **Evidence:** `style.css:3554-3561` (`.copy-btn` opacity 0, revealed only via `.msg:hover`); contrast `style.css:4184-4188` (code-block buttons DO get `@media (hover:none){…opacity:0.7}`). **Mechanism:** on touch the copy control stays invisible (still hit-testable but undiscoverable). NIT (bubble text stays selectable; nothing lost). **Fix:** mirror the code-block `@media (hover:none)` reveal for `.copy-btn`.

### RESP-4 · `[LATENT]` · PROPOSED · The responsive-matrix gate can't see RESP-1/2 — 36px floor (project floor is 44px), narrow selectors, kit windows unmounted
- **Evidence:** `responsive_matrix.py:312-325` (selectors `button,[role=button],select,.settings-nav-item`; floor `w<36||h<36`); `GAME_SURFACES` `:237-238` doesn't mount panel toolbars; XFAIL empty `:73-76`. **Mechanism:** a 36–43px control passes the gate while violating the project's own 44px CSS floor, and panel-body controls aren't in the scanned DOM ⇒ a whole class of below-44px controls ships CI-green. **This is the guardrail-scope-drift root behind RESP-1/2/3.** **Fix:** align the gate floor to 44px, widen selectors (`a[href]`, interactive `[tabindex]`), mount the kit panels during the coarse-pointer sweep.

**Lane-RESP CLEARED:** the responsive contract is mature — `dvh` w/ `vh` fallbacks across overlays, `env(safe-area-inset-*)` on fixed bottom chrome, a `--composer-clearance` token kept live by Resize/Mutation observers (keyboard-robust), the State-6/J5-01 44px coarse floor genuinely covering titlebars + gadget-rail. The brief's big-ticket warnings (fixed-vh, sheet flush-width, cursor:move-on-touch, sheet/hamburger overlap) are really fixed. **Lane-RESP smell:** the touch floor is enforced + audited at exactly ONE altitude — chrome — while panel bodies and dock rows live just outside both the J5-01 selector list and the gate's DOM, so the guardrail's *scope* drifted behind the surfaces it protects (RESP-4).

---

## Wave 2 — Transient / animation lifecycle (static)

### TRANS-1 · `[POLISH·top FE-correctness candidate]` (agent proposed [BLOCK]) · CONFIRMED (lead-verified structure) · Mid-stream engine-tool error orphans a 50ms `_elapsedTicker` (+100ms wave) on the stuck "running" tool node — fires forever, 20fps DOM mutation
- **Lens:** transient correctness + distributed-consistency (trigger is a 409 stale-beat).
- **Evidence (lead-verified):** intervals armed `chat.js:2305,2314`; cleared at only 4 sites — Stop sweep `:369-371`, new-tool-mounts-clears-old `:2295-2296`, `tool_output` `:2361-2367`, and the **catch-`else`** sweep `:3284-3288`. The `finally` (`:3307-3319`) clears response-timeout/finalizing/aria-busy but has **no `.agent-thread-node.running` sweep**. The error path sets `_streamHadError=true` (`:1483`) and ends via the normal `[DONE]`/break → `finally`, **not** the throwing `catch`. Server: `agent_runs.py:117,129-137` catches a tool exception → emits `event: error` + `data:[DONE]` (graceful close, no client throw); `orwell_engine.py:215,223` raises on 409/5xx/timeout; `tool_output` (`agent_loop.py:4481`) never sent for the failed tool. **The dev comment at `chat.js:3278-3283` admits the leak** ("without this sweep they fire forever on the orphaned node, and auto-recover compounds it") — but parked the sweep in the catch, which the graceful-error close skips.
- **Mechanism:** `tool_start` mounts `.agent-thread-node.running` + arms two intervals; the engine tool raises (canonical: ADR-0065 stale-beat 409 under two-window play); the pump converts to `event: error`+`[DONE]`; the client renders the error and `break`s → `finally` (no sweep); `tool_output` never arrived → node stays `running` with `_elapsedTicker` rewriting its elapsed text 20×/s for the life of the page. Compounds under the ADR-0011 auto-recover cascade.
- **Differential:** not FEJS-6 (different machinery); not the clean-`[DONE]` case alone (rarer); ruled "the finally cleans it" by reading `:3307-3479` (sweeps spinners + `_streamSessionId`, not running-node intervals); ruled "engine tools never raise" by `orwell_engine.py:215/223`. **Severity calibration (lead):** POLISH not BLOCK — leaks a timer + shows a stuck "running" node (the brief's "orphaned node with live timer" / "stuck spinner" class), reachable in normal concurrent play, but does not break game progression. **#1 FE-correctness fix candidate** (one line: add the `:3284` sweep to the `finally`).
- **Confidence:** high (structure lead-verified + dev comment). **Falsifier:** a burst capture under a forced 409 shows the running node's intervals stop at the error frame ⇒ a sweep I missed exists. **Harness-confirmable?:** yes — force a 409 from window B mid-stream in window A; MutationObserver logs `.agent-thread-elapsed` text mutating every ~50ms with no unmount after the error bubble settles.

### TRANS-2 · `[POLISH]` · PROPOSED · The agent-thread running pulse (most-seen game animation) + the gadget-rail pulse family have no `prefers-reduced-motion` guard (WCAG 2.2.2)
- **Evidence:** `style.css:9218` `thread-pulse 1.5s infinite` (arms every tool round); `:789,809,831,9046,9028,9089` (`rail-notes-pulse`/`rail-min-pulse`/`rail-notif-pulse`/`stream-complete-pulse`/`bar-pulse`). Brace-balanced parse of all 17 `@media (prefers-reduced-motion:reduce)` blocks confirms **none** carry these selectors (only `#email-unread-dot` is covered). Contrast: the kit DOES gate (`orwellFinalizing.js:54-57`, `orwellDecision.js:83`, `orwellWindow.js:708,765`).
- **Mechanism:** decorative infinite pulses on persistently-mounted game chrome keep animating under reduced-motion (no blanket `*{animation:none}`); >5s infinite also trips WCAG 2.2.2 pause/stop/hide. **Confidence:** high (brace-balanced verified). **Fix:** extend a reduced-motion block to the decorative-loop selectors (ideally a shared `decorative-loop` class so coverage can't drift).

### TRANS-3 · `[POLISH]` · PROPOSED (corroborates SOC-3 from the transient lens) · Power-transition / ceremony reveal lands as a silent side-panel `textContent` swap — no animated weight
- **Evidence:** `orwellStatusPanel.js:300,302,307` (plain `textContent =` for HOH/noms/veto, no change-flash class; only `.os-chev` has a transition); the SR announce `:234-249` writes to a visually-hidden `#os-announce` (`:165` clip-path); chat-side marker is one static chip (`orwellToolBeats.js:101-124`, mounted `chat.js:2451-2454`, no entrance animation). Grepped all 21 `reveal|ceremony|crown` files — no mid-season ceremony stages an animated power-transition beat (finale/retro DO have ordered reveals).
- **Mechanism:** HOH→noms→veto→eviction reconciles as in-place text substitution in a collapsible panel + one quiet chip; no crown drop / gavel / card flip / row flash. **Steelman:** ADR 0003 makes narration carry the drama, HUD is a quiet ledger — valid; but when the narrator under-calls (worse on Flash) the reveal degrades to exactly this silent flip with no fallback weight (ties SOC-3 + A-S3 dropped-fold). **Fix:** a reduced-motion-gated delta highlight on the changed HUD row (the announce already computes the delta at `:242-247`) and/or a lightweight staged chip reveal for the four ceremony beats — without becoming the dashboard ADR 0003 forbids.

### TRANS-4 · `[NIT]` · PROPOSED · Streaming-status spinners (`whirlpool`, `thinking-dots`/`ai-spinner`) uncovered by reduced-motion (judgment call — essential motion?)
- **Evidence:** `style.css:1067,8888,9466` (infinite spins, none in a reduced-motion block); game-build usage `ui.js:327`, `chat.js:1689,5339`. Down-rated: a loading spinner conveys essential in-progress status (WCAG carves out essential motion), so a slowed/stepped variant — not removal — is the remedy. Flag for an explicit product decision alongside TRANS-2.

**Lane-TRANS CLEARED (lifecycle verified clean):** decision card (`orwellDecision.js` — `_doneTimer` self-removal guarded, reduced-motion gated, 15s backstop bounded), ask_user card (dedup on mount, removed on answer), finalizing indicator (begin/end paired + `finally` net), toast (single shared `#toast`, no stacking, reduced-motion covered `style.css:22186`), OrwellWindow open/minimize/dock (reduced-motion gated throughout). **Lane-TRANS smell:** TRANS-1 — the team KNEW about orphaned tool-node tickers and wrote the sweep, but parked it in the one terminal path (a thrown `catch`) that the graceful server-`event:error` close skips, so the leak survives exactly the concurrent 409 the AUDIT-LOG treats as a live scenario. A single missing line, 20 lines from the fix that already exists.

---

## Wave 2 — UX content & accessibility (static)

### UX-1 · `[POLISH·high quick-win]` (agent proposed [BLOCK]) · CONFIRMED (lead-verified) · Raw kebab-slug IDs injected into the player's finale composer prefill
- **Lens:** content / immersion (machinery-ish leak into the player's own voice).
- **Evidence (lead-verified):** `orwellFinale.js:25-30` (`APPEALS` ids `own-game`/`mend`/`connect`/`discredit-rival`); `:210` `addBtn("→ " + a.label, \`I answer the jury by making my "${a.id}" case.\`)` — button shows `a.label`, but `prefill()` writes `a.id` to `box.value` (visible textarea).
- **Mechanism:** at the finale "questions" stage a player-finalist clicking "Question my rival" gets `…making my "discredit-rival" case.` in their composer — a machine identifier in the player's voice at the game's emotional peak. **Differential:** pure content fault (`a.id` where `a.label` belongs); flow is correct. **Severity (lead):** POLISH not BLOCK — gated behind reaching F2 + using the shortcut, editable before send, doesn't block play; but trivial fix + visible fourth-wall break ⇒ high-priority quick win. **Fix:** `a.label` (or a label-derived phrase); if the LLM needs the slug, send it as a scrubbed hidden prefix. **Confidence:** high (string interpolation unambiguous).

### UX-9 · `[POLISH]` · PROPOSED · Decision-card note "Your selection only — never read from prose" is OOC engine-language delivered via `aria-describedby` on every standard binding card
- **Evidence:** `orwellDecision.js:421` (`multi ? "Select N — only a legal move counts." : "Your selection only — never read from prose."`); the note is the card's `aria-describedby` description (first thing a SR user hears). **Mechanism:** "never read from prose"/"legal move" address the engine boundary, not the houseguest — breaks fiction at nominations/eviction-vote, the most consequential moments. The per-kind overrides (`juror-question`: "Your own words…", `goodbye-message`: "Pick a tone — that's what binds.") prove the fix pattern is understood; the default else-branch just never got it. **Fix:** player-facing reword ("Tap your choice — the house only sees this card, not the chat."). **The lane's biggest smell.**

### UX-2 · `[POLISH]` · PROPOSED · Duplicate `aria-label="The Cast"` on two simultaneous collapsed-gadget-strip buttons (WCAG 4.1.2/2.4.6)
- **Evidence:** `orwellGadgetRail.js:43,47` (both `orwell-cast-pin` and `orwell-cast` have `title:"The Cast"`); strip builder `:169` `b.setAttribute("aria-label", g.title)`. Icons differ (👥/🎬) but `aria-label` overrides the icon ⇒ a SR/voice-control user hears two indistinguishable "The Cast" buttons. **Fix:** differentiate the two registry titles.

### UX-10 · `[POLISH]` · PROPOSED · Finale `.ofin-btn` `min-height:36px` defeats the coarse-pointer 44px floor via specificity
- **Evidence:** `orwellFinale.js:93` (`#orwell-finale .ofin-btn{min-height:36px}`, specificity 0,1,1) beats the responsive-tokens `@media (pointer:coarse){button:not(.tap-exempt){min-height:var(--tap-min)}}` (0,0,1) — so the 44px floor never applies on touch. Distinct from the closed J5-13 (which lifted ~27→36 but didn't notice the specificity defeat). **Mechanism:** the finale's four shortcut buttons (the most time-sensitive touch interaction in the game) ship 36px on touch, 8px below the project floor. **Fix:** add `.tap-exempt` + explicit 44px, or `min-height:max(36px,var(--tap-min,44px))`. (Pairs with RESP-2/4 — the touch-floor guardrail keeps getting beaten by panel-level CSS.)

### UX-3 · `[POLISH]` · PROPOSED · Premiere dismiss button Label-in-Name violation (WCAG 2.5.3)
- **Evidence:** `orwellPremiereTutorial.js:110` visible text "Close guide" but `aria-label="Dismiss the premiere guide"` — visible label absent from the accessible name ⇒ voice-control "click Close guide" fails to match. **Fix:** drop the `aria-label` (let "Close guide" be the name; `title` carries the hint) or prefix it with the visible text.

### UX-5 · `[LATENT]` · PROPOSED · Six static `role="dialog"` elements have no `aria-modal` + unconfirmed focus trap
- **Evidence:** `index.html:334,533,1237,1405,1431,1442` (Brain/Theme/Prompt/Rename/Cookbook/Settings) — grep `aria-modal` ⇒ 0 matches; the OrwellWindow kit sets `aria-modal` for *dynamic* windows but these legacy static modals are outside it. **Mechanism:** without `aria-modal="true"` a SR virtual cursor can wander outside an open modal (Settings is player-reachable every session). LATENT (game-trim may hide some; JS focus-trap existence unconfirmed from markup). **Fix:** add `aria-modal="true"` + verify a JS focus trap.

### UX-7 · `[LATENT]` · PROPOSED · Diary Room mode-entry is announced **silently** to screen readers (display toggle, not content mutation)
- **Evidence:** `orwellDiaryRoom.js:72-77` — pill created `display:none` with `role="status"` and content pre-set; `enterDRMode()` toggles `display`. **Mechanism:** `aria-live` fires on content mutation, not a style change ⇒ entering the private OOC channel (a consequential state change — DR vs public house message) gives a SR user no confirmation. **Fix:** mutate the live-region text content on entry (or start empty + inject on first show).

### UX-4 · `[POLISH]` · PROPOSED · Retrospective vault headings/button contain bare emoji without `aria-hidden` (WCAG 1.1.1)
- **Evidence:** `orwellRetrospective.js:150,171,196` (🔓/🗳/🔐 inline in text nodes; the J3-24 fix wrapped tutorial emoji in `aria-hidden` spans but it wasn't extended here). SR announces "closed lock with key, Open the Producer's Vault" on the key post-season CTA. **Fix:** apply the J3-24 `<span aria-hidden="true">` pattern.

### UX-8 · `[NIT]` · PROPOSED · Finale shortcut buttons' emoji/arrow glyphs unguarded in the accessible name
- **Evidence:** `orwellFinale.js:203,208,210,212` (`btn.textContent = label` incl. ✍/→/🗳) ⇒ "rightwards arrow, Own my game" / "ballot box…, Vote for X". **Fix:** `innerHTML` with `aria-hidden` spans around the glyphs.

### UX-6 · `[NIT]` · PROPOSED · Season chip accessible name is a static placeholder
- **Evidence:** `orwellSeasonProgress.js:174` `aria-label="Season number"` set once, never updated to the actual value ⇒ SR hears "Season number" not "Season 2". **Fix:** set `aria-label` to the live label, or drop it and let `textContent` be the name.

**Lane-UX CLEARED:** strong in-fiction copy throughout — Diary Room pill ("private & out-of-character; the house never hears this"), retrospective Vault CTAs, premiere tutorial, self-evict-cancel ("Cancel — stay in the house"), the Vault-safe decline ("The Vault would not open"). Chat `role="log" aria-live="polite"`, presence `role="status"`, decision-card `role="form"` + `role="alert"` error region, finale SR-only announce region — all structurally correct. Reduced-motion gated across the kit + tutorial. **Lane-UX smell (UX-9):** the OOC engine-language decision-card note is the most consistently present fiction-break — on every binding card, first thing a SR user hears — and the per-kind overrides prove the fix is understood but the default branch was skipped.

---

## Live-LLM lane — COMPLETE (real stack, `-pro` 22 turns + `-flash` 3 turns, 4742 engine calls, $0.95, 28 screenshots)

**Method:** real engine + FE per the harness, authentic in-chat casting → full week-1 (casting→eviction→week-2 roll), engine = oracle. Artifacts: `.audit-telemetry/live-play-roast.md` + `.audit-telemetry/shots/{play,playf}/` (gitignored). **What HELD (keep):** casting finalized promptly (S2-1 did not reproduce), distinct/stable NPC voices, **0 cast inventions / 0 hard machinery leaks / 0 `npc:N` in 55 messages**, anti-sycophancy held (lost both comps "competed", real NPCs won HOH), the staged eviction *reveal* drama, Vault posture clean, `-flash` now DOES `advanceGame` (B5/B6 improved). The conversation really is the game, and it's good. **Three of my static findings were empirically confirmed live** (ENG-1→LIVE-2/3/5, SOC-1→LIVE-10, FEPY-4/A-S3→single-tab repro).

### LIVE-4 · `[BLOCK]` · both tiers · VIEWED · Staged-comp advance-cascade silently skips the nomination + veto ceremonies
- **Lens:** narration faithfulness (omission) + core-loop integrity (the four weekly ceremonies are the BB spine).
- **Evidence:** turn-9 FE ledger `beat=35→42 tools=[advanceGame,submitDecision,advanceGame×3]`; turn-13 `beat=49→56` with **6 advanceGame** crossing veto-draw→comp→ceremony; engine recap holds the skipped beats verbatim ("X nominates Y and Z", "X wins the Power of Veto", "X does not use the veto") — **none narrated in real time** (full 23-message scan). **Flash:** skipped the player's OWN nomination, narration ended "who does [HOH] put on the block?" while engine `noms=[…, the player]`.
- **Mechanism (FE narration, NOT engine):** the engine returns a `BeatEvent` per ceremony (`liveSeason.ts:1288-1294`); the model receives it but keeps advancing to the next decision point, violating the explicit rule `momentPrompts.ts:98-100` ("never narrate past one without advancing it"). The staged comp's many advance-beats invite "just keep advancing"; nothing caps advances at a ceremony boundary.
- **Differential:** the INVERSE of the excluded S3-CORE/B6 (under-call) — here the model OVER-advances. Pro catches up ~2-3 turns late (with a vote retcon, LIVE-7); flash recovers worse. Recovery is luck, not design.
- **Tuning rec:** cap `advanceGame` to ONE ceremony-class beat/turn (staged `comp-elimination` sub-rounds excepted as one logical comp); require a returned ceremony `BeatEvent` (noms/veto-ceremony/eviction) be narrated before any further advance (analogous to `_auto_record_scene`); or emit a `pending` pause at the NPC-HOH nomination. **Confidence:** HIGH. **Falsifier:** any chat message showing a ceremony when it occurred — none did.

### LIVE-7 · `[BLOCK-candidate]` · pro · VIEWED · Narration fabricates the eviction result ahead of the engine, which then contradicts it
- **Evidence:** turn-17 GM narrated "**6 to 4 … [nominee] … is the first to fall … she's gone**" + farewell + walking out; turn-20 the engine returned MORE ballots ("the reveal isn't over"), still `phase=eviction, evicted=[]`, the evictee `active`; true tally was **8-5** (13 voters). The evictee "left" twice; the count retconned.
- **Mechanism:** the staged eviction reveal drips ballots per `advanceGame`, but nothing stops the model narrating the CONCLUSION (evictee named + departure) before the engine's commit beat. **Faithfulness violation** (narration contradicts engine truth); the persisted truth is correct (engine wins), but the player saw a contradiction at a peak moment. **Tuning rec:** forbid narrating the eviction result/departure until the commit beat returns the eviction event; surface "final ballot"/"reveal complete" so the model can't conclude early. **Confidence:** HIGH.

### LIVE-2 · `[POLISH·high]` (0066 tuning; **confirms+extends ENG-1**) · both · VIEWED · A single staged comp burns a full in-game DAY and sweeps the just-crowned HOH asleep
- **Evidence:** week-1 HOH comp drove `timeOfDay` morning/day1→late-night/day2 in one turn (~9 clock ticks); engine `asleep` then included the **HOH who just won**; reproduced week-2. The model narrated the HOH awake to dodge the absurdity — contradicting the engine flag.
- **Mechanism:** `GameSessionAdapter.ts:3299-3302` calls `advanceClock` UNCONDITIONALLY per `advanceBeat`; 0006 staged comps are ~4-8 advance-beats, so one comp consumes >1 day. `awakeSet` (`timeOfDay.ts:120`) has no HOH/ceremony exception. `time_of_day_enabled:True` is the FE default (ENG-1). **Tuning rec:** advance the clock once per LOGICAL comp (skip the tick on inert `comp-elimination` beats); exempt the just-crowned HOH from `awakeSet` for the winning beat. **Confidence:** HIGH.

### LIVE-3 · `[POLISH·high]` (0049/0066 integration) · both · VIEWED · The sleep state is invisible to the narrator; asleep NPCs vanish from rooms with no time cue
- **Evidence:** at late-night the `whereabouts` result lists only the 7 awake NPCs; the 8 asleep (incl. HOH) are absent from every room with **no `asleep`/`timeOfDay` field**; the moment prompt has no "late-night"/"asleep" cue (grep: 0 hits in `momentPrompts.ts`). The model sees a half-empty house with no reason → invents/contradicts (LIVE-5). **Tuning rec:** add `timeOfDay` + `asleep:[…]` to the `whereabouts` result and a one-line "It's late-night; these have turned in: …" to the moment prompt (all already Vault-free in `/status`). **Confidence:** HIGH.

### LIVE-5 · `[POLISH]` · both · VIEWED · Narration clock decoupled from engine — invents wall-clock times ("06:19 PM") while the engine says morning
- **Evidence:** engine `timeOfDay=morning`/day3/`asleep=[]`; narration prefixed "**06:19 PM**" (the engine has no clock-time, only 5 phase labels) + NPCs saying "get some sleep". Direct consequence of LIVE-3. **Rec:** anchor the narrator to the engine phase (same fix as LIVE-3). **Confidence:** HIGH.

### LIVE-8 · `[POLISH·high]` (B3 family) · pro · VIEWED · Eviction→next-week transition is a fragile over-long chain; the goodbye double-surfaces
- **Evidence:** the week-1 eviction needed 13 ballot reveals → a `goodbye-message` pending → a "X leaves the house" commit → week-2 roll; the player authored the goodbye TWICE — free-text (turn 19) AND a structured `[warm/respectful/cold]` tone card (turn 22) for the same goodbye. The model called `advanceGame` repeatedly while the engine sat at `phase=eviction,pending=None` (appeared stuck; an oracle advance found one queued beat that cleanly rolled — engine sound, choreography fragile). **Tuning rec:** request the goodbye ONCE (the structured card owns the binding commit per ADR 0003); make the "leaves the house" commit beat fire exactly once. **Confidence:** HIGH.

### LIVE-1 · `[POLISH]` (grounding/non-degradation) · both · CONFIRMED (lead-verified) · Each NPC carries two contradictory occupations in the prompt; the model voices the placeholder
- **Evidence (lead-verified):** `characterFactory.ts:575` `background = "a ${rng.pick(OCCUPATIONS)} who plays as a ${archetype}"` (a DIFFERENT pool from `pickVocation()`); `momentPrompts.ts:728` surfaces `h.background` AND `:731` `h.vocation` AND `:737` `h.biography` (which re-embeds the placeholder via `deepProfile.ts:249`) → the placeholder appears 2×, the real vocation 1×; the model weights the placeholder non-deterministically. Live: Lexi seeded "stand-up comedian" voiced "bartender"; flash flipped Tiffany postal-carrier→realtor within one comp. The `:571` comment admits `background` is "RETAINED (byte-stable)" — kept for RNG stability but should not be SURFACED.
- **Tuning rec:** make `generateBiography()` use the real `vocation`; drop `h.background` from the momentPrompts roster line (keep the rng pick for byte-stability, stop surfacing its value). **Confidence:** HIGH.

### LIVE-6 · `[POLISH]` (rules grounding) · both · VIEWED · The 1st evictee is narrated as a juror
- **Evidence:** on the 1st eviction (of 15) the GM said "the jury of one … starts tonight" / "She's the first juror now" — but the first ~6 evictees are pre-jury (jury of 9 forms from the final 9); engine `jury:None`. Misleads jury-management strategy. **Rec:** surface a `juryStarted`/`isJuror` flag or the jury-threshold number in the prompt. **Confidence:** HIGH.

### LIVE-10 · `[POLISH]` (social legibility; **confirms SOC-1/SOC-4 LIVE**) · VIEWED · `socialRead` says "Nothing feels out of place" while the player is nominated
- **Evidence:** after the HOH put the player on the block, `socialRead(HOH)` returned "…you've witnessed 68 moments and know 12 things for certain. **Nothing feels out of place right now.**" `socialInitiatives` DOES model NPC scheming (the layer exists) — it just never surfaces a "you're a target" read. Combined with LIVE-4 (nomination not narrated), the player is **doubly blindsided with no readable warning** — the brief's flagged concern, now empirically confirmed. **Rec:** let the affect line reflect observable danger cues; suspense from readable uncertainty, not the surface asserting all is well. **Confidence:** MED.

### LIVE-9 · `[NIT]` (B1 re-confirmed) · pro · VIEWED · Residual "Let me check…" operator-aside in a visible bubble
- **Evidence:** 1/55 messages: "…four to go. **Let me check where the stragglers are** before you hunt them down." (about to call `whereabouts`) — not a hard leak, ~1.8% frequency. **Rec:** the FE leading-meta-sentence strip floated for B1.

### A-S3 single-tab repro (strengthens FEPY-4 / R-BND-1) — NOT a new id
9/4742 tool calls failed `StaleBeatError` (409) in **single-tab** play (no peer): within one multi-round turn the model carries a stale `expectedBeatSeq` after its OWN earlier advance. The FE reconciles (no visible break), but a 409 on a back-fill `recordInteraction`/`moveTo` can drop a scene's consequence fold **without concurrency** — a stronger version of the documented A-S3 risk. **Gate rec:** refresh `expectedBeatSeq` after each of the model's own advances within a turn.

---

## Roast complete — consolidated launch triage
**[BLOCK] (fix before launch):** LIVE-4 (ceremonies skipped) · LIVE-7 (eviction fabricated ahead of engine, BLOCK-candidate).
**[POLISH·high] (top quick wins / clusters):** the **0066 time/sleep cluster** ENG-1+LIVE-2/3/5 (ships on, mistuned, invisible to narrator) · TRANS-1 (orphaned 20fps timer, 1 line) · UX-1 (slug in finale composer, 1 line) · LIVE-8 (goodbye double-surface) · LIVE-1 (dual occupation) · FEPY-1 (casting error as GM narration) · SOC-1+LIVE-10 (coalition illegibility) · R-BND-1/FEPY-4/A-S3 (stale-beat drops folds, single-tab).
**[DOC]:** DOC-1..8 ceiling-freeze drift (CLAUDE.md @0069 vs features @0074; phantom FE port 7000).
**Everything else:** LATENT/NIT tracked above.

---

## R-ARCH-1 · Design question (owner-asked): "Is there any point in leveraging LLM context?"
**Short answer: as a STORE/source-of-truth, no — and a 1M-token window doesn't change the structural reasons. As a per-turn NARRATION working set, yes — but the lever is PRECISION, not VOLUME, and none of the live grounding bugs are context-SIZE problems.** Reasoned by mechanism across four lenses:

- **Vault Wall (the decisive one).** "Leveraging context" as memory means putting the season's history into the prompt. But the full history *contains the Vault* — hidden NPC↔NPC scenes, confessionals, hidden attributes. The architecture's whole guarantee is "the model cannot leak what it never receives" (mandate #2): the engine projects only the **Vault-free, witness-scoped** view (`getVisibleStateFor`, `renderGameContext`). Dumping history into a big window = feeding the Vault to the model = breaking the Wall *by construction*. A larger window only "helps memory" if you breach the Wall, so it can't be the mechanism. **Confirmed clean live:** 0 `npc:N`/0 hidden leaks in 55 messages precisely because the projection is small and curated.
- **Non-degradation (mandate #4 / ADR 0003).** "Long-term memory is the store *recalled*, never the chat *remembered*." The old version degraded *because* it held state in the context window. A 1M window is still a non-durable, non-authoritative, non-queryable, lossy cache with no schema and no consistency guarantee — a bigger cache, not a database. The store + permissioned semantic recall (`KnowledgeService`/embeddings) is strictly better: durable, Vault-safe, deterministically queryable, monotonic. Replacing recall with "stuff it all in context" *re-introduces* the exact degradation the rebuild exists to fix.
- **Faithfulness / DeepSeek V4 attention (frontier-AI lens).** Bigger context does **not** improve grounding and can degrade it: lost-in-the-middle + attention dilution mean effective recall over a packed 1M window is non-uniform, and V4's hybrid **Compressed/Heavily-Compressed Attention** makes long-context recall *lossy by design* — worse on the cheaper Flash tier (where this audit already found the most drift). "Feed it everything" is empirically fragile exactly where fidelity matters most.
- **Game design (ADR 0003: "prefer removing context to adding it; hand the model facts to voice, never scripts to recite").** **The live findings prove the lever is precision, not volume:** LIVE-1 (model voices a *placeholder* occupation because the prompt surfaces TWO jobs), LIVE-3 (sleep state *absent* from `whereabouts`/prompt), LIVE-4 (ceremony beats not narrated before advancing), LIVE-6 (no jury-threshold fact). **Not one** is a "context too small / needs more memory" problem — every one is "the engine projected the *wrong/missing* fact or the *wrong pacing*." Adding context would make LIVE-1/3 *worse* (more surface to contradict); fixing the projection's precision + the advance choreography fixes them.

**Where a large window legitimately earns its keep here (bounded):** carrying more *recent verbatim conversation* per turn so the model holds the thread across a long scene — but that's already the working set, the marginal value past the recent window is low (a season's Vault-free projection is small), and it trades against lost-in-the-middle. **Net recommendation:** do **not** invest in "leverage the LLM context window" as a memory/grounding strategy. Invest the same effort in (a) tightening what the engine *projects* (drop the LIVE-1 placeholder; add the LIVE-3 time/asleep fields — both Vault-free, both in `/status` already) and (b) the LIVE-4 advance/ceremony pacing. The 1M window is a red herring for every bug this audit found; the store-backed, permissioned, recall-on-demand design is the correct one and the live run validated it (clean Vault, non-amnesic recall, stable personas). Keep the context *small and exact*, not large.

---

# Wave 3 — Second-auditor session (consolidated 2026-06-22)

> Folded in from the parallel `claude/focused-turing-7d710o` session (was `ROAST-LOG-2.md`). All ~33 findings below are NEW — cross-checked absent from the Wave 1–2 findings above and from `AUDIT-LOG.md`. Lanes: A social mechanics · B distributed consistency · C narration · D UX/a11y · E deterministic-browser telemetry (VIEWED) · F test gates (all green) · G security/ops · H transient/animation · I interaction/cognitive-load.

## Wave-3 remediation status (2026-06-22, on main)
**FIXED + merged to main** (full FE suite 2260 passed; engine gates green):
- **F-NEW-1** (`cfe60c1`) — `replacement` + `tie-break` added to `HIGH_STAKES_KINDS` (risk skin now applies).
- **A11Y-7** (`cfe60c1`) — decision chips `.odec-opt` → 44px floor.
- **A11Y-8 / UX-10** (`cfe60c1`, test `8f0c95d`) — finale `.ofin-btn` + new-season `.ons-btn` → 44px; `test_j5_finale_buttons_tap_target` re-pinned 36→44.
- **SEC-1** (`18010f0`) — public-profile boot guard now refuses `ALLOWED_ORIGINS` unset/`*`/non-https under `ORWELL_PUBLIC` (+5 test cases).
- **SEC-2** (`18010f0`) — opt-in gateway webhook verification: `PlatformAdapter.verify_webhook()` + Telegram `X-Telegram-Bot-Api-Secret-Token` constant-time check + route 403 (default-off = unchanged local use).
- **A11Y-2 / A11Y-4 / A11Y-5** (`7950672`) — SR live-region batch 1: new-season transition error now announced (assertive); Diary-Room failure announced assertively (success resets polite); status collapse-toggle aria-label/title track state instead of a stale "Collapse". (Full FE suite 2260 passed.)
- **A11Y-1** (batch 2) — presence + night gadgets converted to the delta-announce pattern (hidden `aria-live` child written only on change) so screen readers no longer re-announce the unchanged room/nightfall every 25s poll. (Full FE suite 2260 passed.)
- **F-NEW-7 / A11Y-10** (batch 3, `1631829`) — Diary-Room exit button → 44px (fixes the mobile mode-lock where every send routed to the DR); finale statement/answer/vote buttons get a glyph-stripped accessible name ("Vote for X", not "ballot box… Vote for X"). (Full FE suite 2260 passed.)

**Still OPEN** (logged, not yet remediated): NARR-7 (BLOCK-candidate, finale persona) · SOC-NEW-2..4 · SYNC-FOCUS-1/RING-1 · NARR-8..11 · RESP-NEW-1 · A11Y-3/6/9/11 · CONT-1..3 · TX-1..6 · SEC-3/4 · F-NEW-2..6/8..13 · SET-NEW-1..3 · ENG-NEW-2/3 · PERS-NEW-1/2. **A11Y-6 deferred** to a visual session (window-kit titlebar geometry, not verifiable here). *(LIVE-4/LIVE-7 BLOCKs are PR #519's, for the fresh live-LLM session.)*

> **✅ REMEDIATED 2026-06-22 (owner-ruled, branch `claude/focused-turing-7d710o`):** the four owner-decision
> items are fixed and green (full unit 1319 + juryReach + calibration-gradient + UAT-5seed + BDD 390 + arch):
> - **ADM-NEW-1** (ruling: sanction + fix docstring) — `admin_transcript_routes.py` docstring corrected to
>   record the sanctioned post-season `seasonRetrospective` unseal exception (a finished game, story-not-
>   numbers, ruling #14); never a LIVE-game Vault breach.
> - **IMG-NEW-1** (ruling: enforce in `recordImageBeat`) — per-turn/-week `IMAGE_BUDGET` caps now enforced;
>   the FIRST image per houseguest (move-in shoot) is exempt, every re-generation is metered + refused past
>   the cap. Boundary test through `McpServer.callTool` (`tests/unit/imageBudgetBoundary.test.ts`).
> - **SOC-NEW-1/5** (ruling: dynamic on game numbers/dynamics/relationships) — the eviction-manner jury term
>   is now graded + precedence-based (betrayal/blindside severity graded off the edge; respect earned by
>   threat; the goodbye softens-never-launders). Baseline twin mirrored; both calibration bands held.
> - **ENG-NEW-1** (ruling: keep clock ON, re-tune + new gate) — `night=0` (matches its comment) and the NPC
>   rest deficit re-keyed off the ACTUAL night (min(bedtime, how-far-the-night-ran)), killing the archetype
>   tax. New clock-ON `tests/unit/sleepEconomyFairness.test.ts` gate (the clock-ON path no gate measured).

## Wave-4 surfacing (loop, 2026-06-22) — settings / persistence
### SET-NEW-1 · `[LATENT]` · CONFIRMED · Custom-theme deletion never propagates and silently resurrects — the cross-device theme merge is additive-only
- **Evidence:** `theme.js:147-153` `deleteCustomTheme` removes locally + PUTs the reduced dict; `theme.js:2368-2378` boot merge only ADDS server entries (`if(!local[name]) local[name]=colors`), never removes; `theme.js:125-145` any save re-PUTs the device's full local set.
- **Mechanism:** device A deletes theme X (A + server lose it); device B still has X locally, and B's next custom-theme save re-PUTs X to the server; A's next boot additively re-adds X. No tombstone/version/LWW — only union ⇒ a deleted theme reappears across devices. **Differential:** not FEJS-1 (that's the one-browser keyspace collapse; this is the server pref's merge semantics). **Falsifier:** delete X on A; save any theme on B (which holds X); reboot A → X returns.
### SET-NEW-2 · `[NIT]` · CONFIRMED · `text-emojis` in `UI_VIS_DEFAULT_OFF` is dead (the set isn't consulted for it)
- **Evidence:** `app.js:2559` set includes `text-emojis`, but it's absent from `UI_VIS_MAP` (`:2521-2556`) where `UI_VIS_DEFAULT_OFF.has` is checked (`:2576`); it's applied out-of-band via `applyTextEmojis(state==='true')` (`:2589`). Two sources of truth for one default that could drift. **Falsifier:** removing it from the set changes nothing.
### SET-NEW-3 · `[NIT]` · CONFIRMED · Keybind default tables disagree on `toggle_sidebar` (F5 drift survived the F1 fix)
- **Evidence:** `keyboard-shortcuts.js:8` `_defaultKeybinds.toggle_sidebar='ctrl+alt+b'` vs `settings.js:1821` `SHORTCUT_DEFAULTS.toggle_sidebar='ctrl+b'`. On a fresh store the Shortcuts tab shows `Ctrl B` while the live keymap binds `Ctrl+Alt+B`; the server-merged default usually masks it. **Falsifier:** a single shared defaults table / assert the two are equal.
*(Agent also re-confirmed prior settings audit F1/F2/F3 are FIXED; Token-Economy + time-of-day controls wired/persisted/applied; logout client-wipe thorough.)*

## Wave-4 surfacing (loop, 2026-06-22) — engine domain / competition math
> **⚠ Owner-decision flagged:** ENG-NEW-1/2/3 touch the **clock-on sleep economy (ADR 0006, owner-pending)** and **calibration-shape constants**. Per the remediation discipline they are **logged, NOT auto-tuned** — changing them shifts seeded outcomes and needs a heavy-sim re-verify + an owner call (ties ENG-1).
### ENG-NEW-1 · `[POLISH]` (clock-on) · ✅ RESOLVED 2026-06-22 (owner: keep clock ON, re-tune + new gate) · Sleep-deficit table contradicts its own comment AND is miswired against mental/social comp aptitude
- **Evidence:** `timeOfDay.ts:67-73` `deficitByLatestPhase = {evening:0, night:0.25, "late-night":1}` — but the comments `:56-58` and `:66` say a bed-by-`night` houseguest "carries none" / "only late-night costs real sharpness" (says night ⇒ **0**, table says **0.25**). Bedtime keyed `:103-108` `bedtimeFor = social − physical`. Live fold `competitionOutcome.ts:118` `rest = −restPenalty × 0.15`; band `temperature=0.36`.
- **Mechanism:** deficit ∝ `social − physical` ⇒ across the 12 shipped archetypes **5 carry the max 1.0** (mastermind, social-butterfly, flirt, loyalist, peacemaker → late-night), **4 carry 0.25**, **3 carry 0** (comp-beast, wildcard, hothead). A `mastermind` (mental 0.85, the puzzle/quiz favorite) eats the full `−0.15` malus (~42% of the ±0.36 band) **in the mental comps it should win**, while the comp-beast pays nothing — the deploy path runs clock-ON but no gate measures it (juryReach runs clock-OFF). **Falsifier:** `restDeficitFor("night")===0` (fails, returns 0.25); `npcRestDeficit({physical:0.4,social:0.85})===1.0` (mental favorite carries max).
### ENG-NEW-2 · `[NIT]` · CONFIRMED · `politicalTemperature` median uses the upper-middle element (no even-length average)
- **Evidence:** `season.ts:73-77` `median = reads[Math.floor(reads.length/2)]`; for an even active house it picks the upper central value, biasing `spread` down ⇒ the `runaway` flag (forces `direct` noms) trips slightly less often than a true median. **Falsifier:** `reads=[0,0,0.4,0.4]` true median 0.2 vs code 0.4.
### ENG-NEW-3 · `[NIT/LATENT]` · CONFIRMED · `detectBlocs` defection mutates the cluster Set during the snapshot pass → order-dependent cascade
- **Evidence:** `blocs.ts:118-132` — `[...cluster]` snapshots members once but each test re-reads the live Set (`inside`/`outside`) and `cluster.delete(m)` in place, so A's peel shrinks B's `inside`/grows B's `outside` and can cascade B out in the same pass; deterministic (insertion order) but order-sensitive. Feeds vote/nom load-bearing blocs. **Falsifier:** a fixed graph where each member alone would stay, but peeling the first cascades the second — differs from a two-phase decide-then-apply.
*(Engine agent steelmanned CLEAN: all hard eligibility/legality rules; `resolveCompetition` bounds + NaN-refusal; staged-comp single-roll byte-identity; competition-library stat mapping; jury-of-9 + tie-breaks; self-eviction folds. One watch-item: `runCompetition` peek vs crown read souls at different times — a latent pre-narration desync if peek is ever used to pre-narrate.)*

## Wave-4 surfacing (loop, 2026-06-22) — casting / OOBE / image (0051)
### IMG-NEW-1 · `[LATENT·high]` · ✅ RESOLVED 2026-06-22 · The image budget (`IMAGE_BUDGET.perTurnCap`/`perWeekCap`) is a DEAD constant — generation, "the most expensive lever," is bounded by nothing
- **Evidence:** `imageConstants.ts:12-19` defines `{perTurnCap:3, perWeekCap:10, moveInPortraitExempt:true}` ("these constants bound it"); repo-wide grep for those names outside the def/registry/tests ⇒ **zero enforcement**. `EngineCommandsAdapter.recordImageBeat:321-336` records + persists with no tally/rejection. The FE `orwell_portraits.py` budget is per-houseguest *retry* backoff, not generation volume — never consults the caps.
- **Mechanism:** only "generate-once-per-season" + provider availability bound generation today; the in-game re-shoot paths (L17 distinctness, 0065 facet-change re-shoot, manual `kickoff_backfill(force=True)`, the studio's "3 options, regenerate indefinitely") all pay provider cost with NO per-turn/week ceiling. "Typechecks, passes arch, dead at runtime" — on the COST axis. A looping model / button-masher / public-exposure abuser has no engine-side spend ceiling. **Falsifier:** any non-test runtime ref to `perTurnCap`/`perWeekCap` that throttles a generation — none found. **Fix (focused):** wire a per-(turn/week) counter into `recordImageBeat` that rejects past the cap (engine change + boundary test).
### CAST-NEW-1 · ~~`[LATENT]`~~ · **REJECTED (lead-traced)** · The prewarm "TOCTOU" does not fire — the check-and-set is synchronous
- **Why rejected:** `orwell_prewarm.py:prewarm_cast` has its only `await` at line 137 (`pre_seed_cast`); lines 144-175 (the `author_started` check → set → `kickoff_authoring`) contain **no `await`**, so Python's cooperative run-to-completion serializes the critical section: whichever concurrent call resumes first sets `author_started` before it can yield, and the second hits `:145` `alreadyWarmed`. No double-author. (Same class as the JSON-RPC-batch finding cut in Lane B.) The surfacing agent missed the synchronous critical section. **Falsifier that would re-open it:** an `await` introduced between `:144` and `:153`.

### CAST-NEW-1-orig (superseded) · Concurrent `prewarm-cast` TOCTOU — see REJECTED above
- **Evidence:** `orwell_prewarm.py:122-175` — `await pre_seed_cast` (`:137`), THEN checks `st.author_started` (`:145`) and sets it (`:153`) + `kickoff_authoring` (`:174`); no lock spans the await. `orwellOnboarding.js:604` POSTs `/api/orwell/prewarm-cast` on EVERY pre-game onboarding load, ungated by 0064 canonical-session ownership.
- **Mechanism:** two tabs/devices pre-game both `await pre_seed_cast` (idempotent) → both reach the `author_started==False` check → both set it true + both `kickoff_authoring` (15 authoring calls ×3 concurrency) twice ⇒ doubled token spend (ledgered twice) + `_on_authored` fires twice → double portrait shoot (compounds IMG-NEW-1). Engine truth unharmed (per-HG idempotent). **Differential:** distinct from the AUDIT §2.11 cold-start two-*interview* window; this is the prewarm path, fired from any device regardless of binding. **Falsifier:** two concurrent `prewarm_cast(user)` with a slow fake `pre_seed_cast` → `kickoff_authoring` called twice (currently). **Fix:** per-user in-flight guard around the pre_seed→author_started window.
### CAST-NEW-2 · `[NIT]` · CONFIRMED (corrected) · `get_portrait_prompt` + `record_image_beat` each defined TWICE at module scope in `orwell_engine.py` — the FIRST is dead (shadowed)
- **Evidence:** module-level defs at `orwell_engine.py:397`+`:743` (`get_portrait_prompt`) and `:454`+`:750` (`record_image_beat`). **Correction to the surfacing agent:** AST shows the two copies are NOT identical, so Python's last-wins means the **second** copies (`:743/:750`) are LIVE and the first (`:397/:454`) are dead/shadowed — an edit to the first is silently ignored. **Fix:** delete the dead first copies after diffing to confirm no intended-but-shadowed logic is lost (deferred — FE-critical module, needs the diff understood; NIT).
*(Casting/image agent steelmanned CLEAN: portrait-prompt Vault Wall holds — private orientation never read by the prompt builder; casting state machine robust against wedge/double-finalize; write-back fail-soft/idempotency careful; ADR-0013 no-photo-without-authoring gate correct.)*

## Wave-4 surfacing (loop, 2026-06-22) — admin / God-Mode / Vault boundary
### ADM-NEW-1 · `[LATENT]` · ✅ RESOLVED 2026-06-22 (owner: sanction + fix docstring) · Admin transcript export forwards `seasonRetrospective` tool output verbatim — the engine's ONE sanctioned Vault unseal — for any user
- **Evidence:** `agent_tools.py:65,107` `seasonRetrospective` is in the GM tool set; `orwell_engine.py:681` calls it on the player channel (output = the post-season UNSEALED hidden story — off-screen scheming, confessionals, twists; `registry.ts:35`); `agent_loop.py:4538-4557,1353-1354` persists every tool result verbatim into message `tool_events`; `admin_transcript_routes.py:124-140,246-281` exports stored messages + tool outputs verbatim for any `session_id` with `require_admin` and NO owner check (`:206-217` lists all owners). The route docstring (`:11-14`) asserts "Transcripts hold only player-visible content — NO Vault risk by construction."
- **Mechanism:** player opens the retrospective → GM calls `seasonRetrospective` → unsealed-story prose lands in `chat_messages` as a tool node → admin `GET /api/admin/transcripts/{sid}` reads another user's unsealed hidden-society narrative. The retrospective is the Vault's contents *made into prose*, routed to the admin through a route whose safety proof assumes the opposite.
- **Differential (why LATENT + owner-ruling, not BLOCK):** story-not-numbers (S4-VAULT-RETRO: 0 soul/relationship/stat numbers cross); the player already has it for their OWN game; **ruling #14 explicitly accepts the admin reading other users' transcripts incl. Diary Room** — so this is the *intersection* of an accepted operator power and the God-Mode-Vault wall (mandate #2 "the human has never read it"), a genuine tension requiring an owner call, not a clean defect. **Falsifier:** finish a game, drive `seasonRetrospective`, `GET …?format=json` → unsealed off-screen prose under a tool node `output`. **Fix options:** (a) persist only the retrospective's *occurrence*, not its body; (b) scrub retrospective bodies from the export; (c) owner sanctions it + correct the contradictory docstring.
### ADM-NEW-2 · `[LATENT]` · CONFIRMED · `owner_filter` defaults `include_shared=True` — a NULL-owner row in a user-scoped game table would be readable by every user
- **Evidence:** `auth_helpers.py:140-148` `owner_filter(...,include_shared=True)` ⇒ `filter(owner==user | owner==None)`. Intended only for shared `ModelEndpoint` (live callers `chat_routes.py:94,157,196`); the owner-backfill migrations (`database.py:1070,1105,1207`) prove NULL-owner rows are a real historical state. **Mechanism:** the dangerous "shared = visible to all" is the DEFAULT on a generic helper keyed on any `model_cls`; a future user-scoped game read reaching for `owner_filter` inherits it silently → a NULL-owner row leaks cross-user. Session-content reads correctly use strict `owner==user` today (`session_routes.py:113-119`), so latent, not live. **Fix:** flip the default to `include_shared=False`; make the endpoint call sites opt IN. **Lead note — DEFER (large blast radius):** ~30 call sites, the vast majority `ModelEndpoint` relying on the `True` default; flipping it means touching ~25 sites with silent shared-config-breakage risk for a latent issue. Safer as an owner-scheduled refactor (or just harden the one non-`ModelEndpoint` default caller, `builtin_actions.py:1350`), not an autonomous batch.
### ADM-NEW-3 · `[NIT/LATENT]` · CONFIRMED · AdminPort + player share one `McpDeps`; the God-Mode wall is one prose allowlist deep, no structural partition
- **Evidence:** `registry.ts:265,291` — same `deps` to `new McpServer("player",deps)` and `("admin/God Mode",deps)`; only `allows()→toolsFor→ADMIN_TOOLS` (7-entry list) stops the admin channel from dispatching `getVisibleStateFor`/`seasonRetrospective`/etc. (all physically reachable from the shared `deps.session`/`deps.player`). `readsVault:false` doesn't catch it (those player-content tools are also `readsVault:false`). Correct as written today; a future mis-registered admin tool sourcing player content would typecheck + pass arch. **Fix:** a boundary test — admin channel refuses `seasonRetrospective`, and every `ADMIN_TOOLS` case reads only `deps.admin`.
*(Admin agent steelmanned CLEAN, hard: engine admin channel content Vault-free by construction (AdminPort = roles-only `AdminVisibleState`, `advanceToFinale` returns only 4 fields); `VisibleStateService` witness-filtered + roster-scrubbed; FE admin health redacts secrets/`api_key`/`e.message`; cross-user session boundary strict `owner==user` before any read/export; no admin route crosses into another user's engine sandbox.)*

> **Filename is deliberately `ROAST-LOG-2.md`** to avoid a cross-branch write collision with the
> first auditor's `ROAST-LOG.md` (PR #519, 64 findings, branch `claude/inspiring-archimedes-aq6hsl`;
> its two `[BLOCK]`s are LIVE-4 staged-comp cascade skips noms+veto ceremonies, LIVE-7 eviction
> fabricated ahead of the engine — both confirmed there, not re-roasted here).
> **Companion to** that file (Waves 1–2 + the live `-pro`/`-flash` run) and to `AUDIT-LOG.md`.
> This file is a **parallel second auditor** on branch `claude/focused-turing-7d710o`. Every entry
> here is **NEW** — re-confirmed in current source (file:line) and cross-checked absent from both
> prior ledgers. Single writer = the lead; read-only specialists fan out and return findings.

## Environment constraint (recorded, 2026-06-22)
**The live-LLM lane could not run in this sandbox.** Outbound egress to `openrouter.ai` is refused
at the environment network-egress layer (`HTTP 403`, `x-deny-reason: host_not_allowed`,
"Host not in allowlist") — confirmed sandboxed, with the API key, and with the Bash sandbox
disabled (all identical). Playwright browser CDNs are likewise blocked, but a Chromium build is
**pre-installed** at `/opt/pw-browsers/chromium-1194`, so deterministic browser telemetry (local
`fake_model_server.mjs` + `EchoNarrativePort`) is feasible; live narration-fidelity is not.
**To unblock live play:** add `openrouter.ai` to the environment's egress allowlist and restart the
session so the policy propagates. The prior PR #519 session already ran a real `-pro`/`-flash`
season (findings LIVE-1..10 there) — so the live lane is not unexplored, only un-rerunnable here.

## Severity legend
`[BLOCK]` launch-blocking · `[POLISH]` high-priority polish · `[LATENT]` latent/potential · `[NIT]`
small/cosmetic · `[DOC]` doc drift. Status: `PROPOSED` (specialist) · `CONFIRMED` (lead-verified in
source) · `VIEWED` (telemetry) · `ROOT-CAUSED`.

---

## Lane A — Engine social mechanics (`src/engine`, `src/domain`)

### SOC-NEW-1 · `[POLISH]` · ✅ RESOLVED 2026-06-22 (owner: dynamic on game numbers/relationships) · A warm goodbye partially CANCELS the jury betrayal penalty — manner signals are summed, not prioritized
- **Evidence:** `liveSeason.ts:1103` `recordEvictionManner(...)` sets `{betrayed:true}` via `mannerToward` (`:770-775`, when evictee trust>0.5); then the goodbye stage `liveSeason.ts:1079-1080` spread-merges `goodbyeMannerFor(tone)` → a warm/respectful tone adds `{respected:true}` (`:1000-1003`) ON TOP. `jury.ts:60-63` sums each flag: `MANNER_LEAN.respected(0.4) + betrayed(-0.6) = -0.2` (`juryConstants.ts:38-43`) instead of -0.6.
- **Mechanism:** `goodbyeTone` reads the **affinity** edge (`:992-996`); `mannerToward` keys on **trust/threat** (`:770-775`). Every finalist sends every juror a goodbye (`selectGoodbyeSenders` = all remaining, `:1011-1013`), so a high-affinity, high-trust ally who got cut reads `{betrayed, respected}` and the betrayal lean is more than halved. Same additive bug for `blindsided(-0.5)+respected(0.4)=-0.1`. The "a goodbye is the last word" comment (`:1078`) implies *precedence*; the math does *summation*.
- **Why it matters:** inverts the player's jury-management incentive at the emotional peak — a costless warm-tone goodbye launders ~40% of a betrayal's finale cost. Mandate: jury management is a real mechanic; anti-sycophancy.
- **Confidence:** high (literal additive sum of co-set flags). **Falsifier:** unit test — evictee trusts R (0.7), R votes them out + sends warm goodbye → assert juror lean toward R = `betrayed` (-0.6), not -0.2. Currently returns -0.2.

### SOC-NEW-2 · `[LATENT]` · CONFIRMED · Bloc defection triggers on UNREQUITED outside attraction (one-way outside bond vs mutual inside bond)
- **Evidence:** `blocs.ts:124` `weakestInside = min(mutualBond(rel,m,x))` (both directions, `:69-70`); `:126` `bestOutside = max(bondOf(rel,m,x))` (one-directional m→outsider, `:63-66`); peel-off when `bestOutside > weakestInside + BLOC.defectionMargin(0.1)`.
- **Mechanism:** a member defects when their *one-way* affection for an outsider beats their *weakest mutual* inside tie — so they leave a tight bloc chasing an unrequited crush; the inside bar is stricter (mutual) than the outside temptation, biasing toward defection. Feeds `blocTerm` in live `voteChoice` (`liveSeason.ts:739`), noms (`season.ts:109`), replacement ranking (`:1376`) — a spurious defection silently re-targets the bloc.
- **Differential:** distinct from SOC-1 (blocs never *surfaced*); this is the detection math. No comment defends the asymmetry ⇒ reads as oversight. **Falsifier:** tight 3-mutual bloc + one low-loyalty member with high one-way bond to a cold outsider → currently peels off; with `mutualBond` outside it would not.

### SOC-NEW-3 · `[LATENT]` · CONFIRMED · Player structurally excluded from the gossip graph until their OWN outbound affinity > 0.35 — dramatic irony runs backwards
- **Evidence:** `orchestrator.ts:563-569` builds diffusion edges only if `relationships.edge(everyone[i],everyone[j]).affinity > GOSSIP.affinityEdge(0.35)` (`gossip.ts:49`); player is `everyone[0]` (`:561`), so only the *player→NPC* direction is ever tested for player edges. Baseline affinity 0.25 (`relationshipConstants.ts:108`); one bonding fold +0.15.
- **Mechanism:** until the player builds ≥0.35 outbound affinity, they have **zero** edges in the rumor graph and can never terminate a diffusion chain — regardless of how warmly NPCs feel about them or how much NPCs gossip about them. In the critical early weeks the rumor mill moves NPC votes (`GOSSIP_HEARD` folds) while the player is deaf by construction; the strategically-detached player is the most blind — the asymmetry backwards.
- **Differential:** upstream of SOC-4 (which is the content-free `socialRead`); here the *belief never lands*. **Falsifier:** seed heavy NPC gossip + player makes no high-affinity bonds → assert no `fact:` belief ever enters player `knownTo`. Bidirectional edge test (`max(edge(a,b),edge(b,a))`) fixes it.

### SOC-NEW-4 · `[LATENT]` · CONFIRMED · An unanswered finale appeal is scored as the OPTIMAL appeal (player-favoring)
- **Evidence:** `liveSeason.ts:1148` `appealMade = f.appeals[finalist]?.[juror] ?? bestAppeal(...)` (argmax-optimal, `jury.ts:124-132`).
- **Mechanism:** if a player-finalist's `finale-answer` pending is never resolved for a juror, the tally scores that pair as the best possible appeal, not neutral/null — not answering == answering perfectly. Comment calls it a "NEVER-HIT safety guard," but FE escape hatches (decision auto-resolve, ADR-0011 forced advance, resume/skip) could plausibly advance past an unanswered pending. **Falsifier:** drive finale to vote with a player-finalist missing a juror appeal entry → juror `perfFor(player)` returns `bestAppeal`, not 0.5/0.

### SOC-NEW-5 · `[NIT/LATENT]` · ✅ RESOLVED 2026-06-22 (with SOC-NEW-1: respect now graded by threat) · `mannerToward` `respected` bucket is over-broad — inflates positive jury lean for unremarkable cuts
- **Evidence:** `liveSeason.ts:770-775` — `betrayed` if trust>0.5; else `blindsided` if threat<0.4; **else `respected`**. No branch for low-trust+high-threat (the classic respected-rival); an ignored floater (low trust, low threat) also falls into `respected` (+0.4 lean).
- **Mechanism:** cutting people nobody feared nets positive jury equity, and (compounding SOC-NEW-1) a warm goodbye keeps it `respected`. **Falsifier:** evictee trust 0.3/threat 0.5 toward R → currently `respected`(+0.4); faithful read = neutral.

---

## Lane B — Distributed consistency (FE transport / SSE / cross-device)

### SYNC-FOCUS-1 · `[POLISH·high]` · CONFIRMED · A backgrounded tab misses every cross-device `game-updated` push (non-durable) AND never reconciles on re-focus → HUD stale 20–120s
- **Evidence:** `orwellStatusPanel.js:418` `if(!document.hidden) await refresh()` (poll skipped while hidden); `:19` POLL_MS=20000; `:383` backoff 120000 — same hidden-gate, no `visibilitychange` reconcile in `orwellFinale.js:268`, `orwellDeals.js:191`, `orwellCast.js:490`, `orwellSeasonProgress.js:287`, `orwellPresence.js:204`, `orwellNightStatus.js:125`, `orwellNewSeason.js:275`, `orwellCastPin.js:166`. `session_events.py:45` `_RING_REPLAY_EVENTS=("run-started","message-added")` — **`game-updated` excluded from the durable ring.** `sessionSync.js:32-34,58,105` reconcile only on a *live* SSE delivery; `connected` re-hello only resets retry. `chat.js:4300-4302` the sole `visibilitychange` handler bails unless `isStreaming`. No `Last-Event-ID` honored (grep 0).
- **Mechanism:** a 2nd device's mutation → `_publish_game_updated` (`orwell_routes.py:113-125`) → `publish(sid,"game-updated")` skips the ring (not in replay set) → live fan-out only. A backgrounded tab (mobile suspend / screen lock drops EventSource) receives nothing; on reconnect the replay carries only run-started/message-added. On re-focus nothing fires a reconcile for an idle (non-streaming) tab → HUD waits its own ≤20s (≤120s post-backoff) tick. Intended: cross-device convergence ~3s via 0064 push with polling as the floor. Violated: push is at-most-once-while-connected (no durability), and the poll floor is *suspended* while hidden and *not re-armed on focus*.
- **Differential:** not S3-RACE (chat-log render); not SYNC-STALE (that = write-backs fire no SSE at all; here SSE fires but is non-durable + no catch-up); the decision card self-recovers (`orwellDecision.js:573` polls every 15s with NO hidden-gate) — the defect is the read-only HUD panels. Mobile is a first-class CI-gated surface.
- **Confidence:** high mechanism, med severity. **Falsifier:** two SSE clients on one session; drop B; `publish(game-updated)`; reconnect B → replay lacks the event (ring excludes it). Fix: add `game-updated` to the ring; one app-level `visibilitychange→orwellGameChanged('refocus')` (G15-safe).

### SYNC-RING-1 · `[LATENT]` · CONFIRMED · The §3.4b durable reconnect ring is destroyed on a single-viewer disconnect — defeats its own purpose for the common single-device case
- **Evidence:** `session_events.py:100-108` — last subscriber leaving runs `_SUBS.pop(...)` AND `_RING.pop(session_id, None)`. Native EventSource reconnect re-subscribes to an empty ring (`:92`); no `Last-Event-ID`.
- **Mechanism:** for the dominant one-tab topology, any transient SSE drop empties `_SUBS[sid]` → `_RING.pop`. An event published in the disconnect→reconnect gap is dropped from fan-out (no subscribers) AND from the now-gone ring → reconnect replay is empty. The ring (built `:29-37` so a late window can catch up) becomes at-most-once exactly when there's one viewer who just blipped. Contrast `agent_runs._EVICT_GRACE_S` (`agent_runs.py:42`) which keeps a run buffer 180s after the last subscriber — the session-events ring has no grace.
- **Differential:** not the ≥2-subscriber cross-device case the ring was built for; the single-viewer self-reconnect path. **Falsifier:** subscribe one client; let `subscribe()` exit; `publish(run-started)`; resubscribe → replay lacks it. Fix: keep the ring on disconnect with a short grace timer (mirror `_schedule_evict`).

### CUT (steelmanned, ruled out)
JSON-RPC batch concurrent dispatch (`jsonRpc.ts:163` `Promise.all`) — ruled out: the engine mutation path is fully synchronous (no `await` through `advanceGame`/`submitDecision`/`persist`/`commit`/`bumpBeatSeq`), so JS run-to-completion serializes batch entries in array order over the shared adapter. Becomes a defect only if an async narrator is ever wired into the commit path — worth a guard comment, not a finding today.

---

---

## Lane C — Narration fidelity (static structural; live model unreachable here)

### NARR-7 · `[BLOCK-candidate]` · CONFIRMED · Jurors are structurally voice-anchorless at the finale — every persona facet vanishes the moment a houseguest is evicted
- **Evidence:** three projection paths strip a non-active HG to a bare name: roster weave `momentPrompts.ts:725` (`if status!=="active"... return \`- ${name} (${status})\``); `GameSessionAdapter.npcVoice:809` (`if seatOf(id)!=="active" return null // only the living are voiced`); `finaleView:3871-3879` returns juror/finalist as `{id,name}` only. Yet `jury-finale` (`momentPrompts.ts:571-583`) requires staging "each juror questioning both finalists" — up to 9 distinct voices.
- **Mechanism:** the season-long voice anchor (`npcVoice.persona` + roster `vibe`) is gated on `seat==="active"`. At the finale every juror is non-active by definition ⇒ the only structural grounding returns `null`/name; the model must reconstruct 9 personas from chat memory — the "store recalled, never chat remembered" failure (ADR 0003, mandate #4). A **re-entry/fresh-session finale** has an empty chat ⇒ jurors have *nothing*, flattening both tiers.
- **Differential:** not SOC-1 (bloc structure); not B61 (holds while active); not Vault (public facets). **Falsifier:** a `-pro` finale where each juror keeps seeded demeanor with no chat history present. **Related:** `evicted`/`self-evicted`/player-juror recaps also lose all evictee persona.

### NARR-8 · `[POLISH·high]` · CONFIRMED · Pre-emission outcome guard covers eviction/winner/HOH/tally but NOT nominations or veto-winner — the two most frequent ceremony claims are unguarded
- **Evidence:** `_beat_signature` captures `noms` (`chat_helpers.py:753-756`), `vetoHolder` (`:777`), `vetoUsed` (`:778`); but `_narration_claims_outcome` has only four branches — evicted/winner/tally/new-HOH (`:839-864`) — and `_sentence_has_closed_set_claim` unions only those four (`:946-951`). No branch compares narrated noms vs `before.noms!=after.noms`, none for veto winner vs `vetoHolder`. The signature carries data the guard never reads.
- **Mechanism:** both the same-turn `screen_streamed_outcome` (`:954`) and next-turn `record_post_turn_desync_check` (`:891`) route through `_narration_claims_outcome`; with no nom/veto branch, "X and Y are nominated" / "Griffin pulls out the veto" streams before the engine commits — the LIVE-7 phantom class, but for the two ceremonies the prompt itself flags closed-set (`momentPrompts.ts:518-535`).
- **Differential:** structural twin of LIVE-7 (eviction, guarded) / LIVE-4 (skip); the nom/veto phantom shares the mechanism but sits in the blind spot. **Related:** `vetoUsed` ("she does NOT use the veto") same gap.

### NARR-9 · `[POLISH]` · CONFIRMED · OOC `((…))` producer asides render as LITERAL double-parens in the LIVE stream — only reclassified on reload
- **Evidence:** base prompt wraps OOC/HUD answers in `((double parens))` (`momentPrompts.ts:149-154`). `detectOocAside` (strips markers, styles `.msg-ooc-producer`) is imported/called ONLY in `chatRenderer.js` (reload path, `:14,2187`). Live `chat.js` renders body via `processWithThinking(squashOutsideCode(roundReplyText))` (`:1337/1350/2225`) with NO OOC detection (grep `detectOoc|msg-ooc` in chat.js ⇒ empty); neither `processWithThinking` nor `mdToHtml` strips `((…))`. Python stream passes `((` verbatim.
- **Mechanism:** the A-render duplicate-engine smell drifted on the OOC seam — reclassification lives in one render engine only. During the live turn the player reads literal `((It's day 12; Maya is HOH…))` inside a "Big Brother" GM bubble; reload silently fixes it. Flickers exactly on meta/logistics/admin/self-evict answers routed through this channel.
- **Differential:** not FEPY-1 (stream error) nor NARR-2 (reasoning split) — a correctly-formed OOC answer with markers exposed. **VIEWABLE** in the deterministic browser (render-layer). **Related:** partial-wrap (`_DOUBLE_PARENS` needs whole-message wrap, `orwellOocAside.js:40`) ⇒ half-literal-paren bubble even on reload.

### NARR-10 · `[LATENT]` · CONFIRMED · Mid-body operator asides & raw `npc:<id>` survive the scrub — `scrubReasoningPreamble` only drops a CONTIGUOUS LEADING run
- **Evidence:** `markdown.js:174-182` walks from the top, `break`s at the first line that isn't blank/`_REASONING_LINE_RE`/`_RAW_NPC_ID_RE`; `processWithThinking` applies it once to the leading reply (`:534`). An aside or `npc:3` appearing AFTER narration starts is never reached; `mdToHtml` does no `npc:\d+` redaction. Only the model not emitting one prevents a mid-body leak.
- **Mechanism:** L6b is a *preamble* stripper by design; no whole-body pass. Engine `humanize`s ids in projections (rare emission), but the model can echo an id from a tool result mid-sentence → survives verbatim. **Differential:** distinct from NARR-1 (gateway) / FEPY-2 (reasoning channel); this is the content channel, mid-body. LIVE-9's leading "Let me check…" is the catchable cousin.

### NARR-11 · `[LATENT]` · CONFIRMED · `social`/`diary-room` (player-present) moments inject the OFF-SCREEN zeitgeist framing into a player-facing prompt
- **Evidence:** `GameSessionAdapter.ts:4025` sets `channel="offscreen"` whenever `moment==="social"||"diary-room"`; the offscreen branch `zeitgeist.ts:314-318` appends "This colors OFF-SCREEN life too… someone makes a dated joke mid-scheme." But social/diary-room are player-present beats, not NPC-to-NPC sim.
- **Mechanism:** the player's witnessed/OOC beat is tagged with the hidden-society framing ⇒ nudges the narrator to write "mid-scheme" off-screen texture into a scene the player is in, blurring the witnessed/off-screen line. **Differential:** not a Vault leak (public flavor); a framing-precision issue. **Falsifier:** channel should be `"player"` for these moments.

**Lane-C CLEAN (re-confirmed):** engine prompt assembly is Vault-free by construction (no stats/souls/hidden/orientation enter a prompt); casting intake neutralized before echo (C8); ceremony status + whereabouts hard-grounded; transport error handling degrades cleanly (A-S5 fields carried); finalist names exact-to-engine in `renderStoryFacts`.

---

## Lane F — Engine truth & build gates (RUN here — all GREEN)
- **`npm run test:unit:fast` → PASS (exit 0)** (typecheck + build + unit/property + dependency-cruiser Vault-wall).
- **`cd frontend && pytest tests/` → PASS (exit 0)** (the full FE gate incl. g15/reasoning-scrub/render-contract convention checks).
- **`npm run test:heavy` → PASS (exit 0)** (full-game UAT 12+5 seed + decisions, jury-reach `EARNED_WINS` calibration, gradient band). The static social/sync/narration findings above are **un-gated behaviors**, not test failures — the gates assert completion/leak-freedom/calibration bands, not the manner-merge / gossip-edge / finale-persona gaps. No regression on this branch HEAD.

## Lane G — Deploy / ops / security & boundary (static)

### SEC-1 · `[BLOCK]` (guard-completeness; LATENT-in-practice via Lax cookies) · CONFIRMED · Public-profile boot guard validates `ALLOWED_HOSTS` but NOT `ALLOWED_ORIGINS`, while CORS runs `allow_credentials=True` → a wildcard origin reflects credentials
- **Evidence:** `frontend/app.py:102-106` `CORSMiddleware(allow_origins=ALLOWED_ORIGINS.split(","), allow_credentials=True)` — credentials unconditional. `core/middleware.py:199-216` `assert_public_profile_safe` unsafe-set = `{AUTH_ENABLED, LOCALHOST_BYPASS, SECURE_COOKIES, ALLOWED_HOSTS}` — **`ALLOWED_ORIGINS` never inspected**. `admin_public_deployment_routes.py:173-204` takes free-form `allowedOrigins`, validates via the guard (which ignores it), persists verbatim; `orwell-ops-public-deployment.sh:184-192` writes it to `data/.env`. Starlette 1.2.1 with `"*"` + credentials reflects the request `Origin` + `Access-Control-Allow-Credentials: true`. No test covers it (grep `allow_credentials`/`Access-Control` in tests ⇒ 0).
- **Mechanism:** an operator/wizard entering `*` (or a stray `*`/non-https value) boots a public authenticated instance whose CORS reflects ANY origin with credentials → a malicious page issues credentialed cross-origin fetch and reads responses. The 0067 guard's whole job is fail-closed on an unsafe public posture; it passes the single most dangerous CORS combo.
- **Differential:** distinct from EXPOSE-1 (engine bind-host; this is the FE CORS var + middleware). Softened by `SameSite=Lax` cookies (suppresses the cookie cross-site) BUT the app also accepts `Authorization: Bearer ody_` and CORS allow-lists `Authorization` (`app.py:110`), so non-cookie flows stay reflectable. **Falsifier:** `assert_public_profile_safe({ORWELL_PUBLIC:1,...safe...,ALLOWED_ORIGINS:"*"})` does NOT raise today. **Fix:** add `ALLOWED_ORIGINS` to the unsafe-set (reject `*`/empty/non-https); sanitize the wizard input.

### SEC-2 · `[BLOCK]` (mandate: cross-user isolation) · CONFIRMED · Gateway webhook is fully spoofable — `platform_identity` from the request BODY is treated as the credential, no platform signature/secret-token check
- **Evidence:** `gateway_routes.py:42-90` `/gateway/webhook/{platform_id}` is auth-exempt (`app.py:219`); derives `(platform_identity,text)` from the body (`:66`) and routes to `handle_platform_turn`. `telegram.py:81-101` `chat_id = str(msg["chat"]["id"])` straight from the body — **no `X-Telegram-Bot-Api-Secret-Token` check** (grep `secret|signature|verify` in gateway/ ⇒ docstrings only). `handler.py:64-76` `get_paired_user(platform_identity)` → mutates that user's engine sandbox + `adapter.send`s to the real victim's chat.
- **Mechanism:** the "credential" is a guessable numeric `chat_id` the attacker supplies in their own POST. Anyone reaching the public webhook can inject turns into a victim's game (engine mutation, consequence folds, advances) AND make the bot message the real victim — a cross-user write + impersonation vector on a public endpoint. **Mandate veto applies** (no call for user A may mutate user B's game).
- **Differential:** the FE→engine seam derives the user server-side (clean); `/pair/verify` is authed+rate-limited (clean). The break is the webhook *turn* trusting client identity with no transport auth. Currently blunted by NARR-1 (dead gateway narrator ⇒ no LLM narration) but the engine-mutating calls still fire and the full path opens the moment NARR-1 is fixed. **Falsifier:** POST a hand-crafted `{"message":{"chat":{"id":<victim>},"text":...}}` with no secret header → turn applied to the victim's sandbox + `sendMessage` to the victim. **Fix:** require + verify the platform secret-token/signature before `parse_inbound`.

### SEC-3 · `[POLISH]` · CONFIRMED · Gateway turn path bypasses the daily message cap AND has no rate limiter — an unauthenticated cost/DoS surface
- **Evidence:** `gateway_routes.py:84-90` webhook turn has no rate-limit guard (the only gateway limiter is on `/pair/verify`, `:122`); `handler.py:76,82-146` `_call_player_turn` never calls `enforce_daily_cap` (web-only, `chat_helpers.py:1818,1859`). **Mechanism:** combined with SEC-2, unlimited turns into any paired user's game with no per-turn rate limit or daily-cap accounting — burns token budget (once NARR-1 fixed) and hammers the engine. **Fix:** per-identity rate limit + route gateway turns through the daily cap.

### SEC-4 · `[NIT/LATENT]` · CONFIRMED · `Permissions-Policy` grants `microphone=(self)` app-wide with no mic feature in the game build
- **Evidence:** `core/middleware.py:106` `Permissions-Policy: camera=(), microphone=(self), geolocation=()`; no `getUserMedia` in the game keep-set. **Mechanism:** a same-origin XSS / compromised inherited module could `getUserMedia({audio})` where `microphone=()` would deny it; narrow (CSP keeps `'unsafe-inline'` styles only). **Fix:** `microphone=()` gated on `ORWELL_GAME_BUILD`.

## Lane H — Transient / animation lifecycle (static; VIEWED confirmation deferred to a model-wired session)

### TX-1 · `[LATENT]` · CONFIRMED · OrwellWindow `close()` 190ms fade race — a re-`open()` during the fade short-circuits on `isConnected`, leaving `.ow-anim-close` latched AND the pending `finish` tears down the re-opened window
- **Evidence:** `orwellWindow.js:854-864` non-reduced `close()` adds `.ow-anim-close` + `setTimeout(finish,190)`; `this.el` nulled only when `finish→_teardown` runs (`:866-874`); keyframe `ow-close .18s forwards` (`:161`). A re-`open()` in that 190ms hits `if(this.el&&this.el.isConnected){this.restore();return}` (`:667-668`) — `restore()` is a no-op for a non-docked window ⇒ (a) `.ow-anim-close` stays (stuck invisible at the forwards end-state) AND (b) the original timer still fires `_teardown()`, removing the just-reopened window.
- **Mechanism/Differential:** reduced-motion is safe (synchronous `finish` branch, `:860`). Currently unreached — poll panels re-show via `style.display`, `toggleDock` uses synchronous `_teardown` (no animation) — hence LATENT, a pre-armed trap for any future close→reopen on a fast signal (gamechanged/SSE). **Fix dir:** store + clear the close timer in `open()`; strip `.ow-anim-close` before re-show, or null `this.el` synchronously at close-start.

### TX-2 · `[LATENT]` · CONFIRMED · A background-completed stream can leave `isStreaming` true; the never-cleared `_textPauseTimer` then mounts an orphan "Thinking" spinner into the now-FOREGROUND session
- **Evidence:** `chat.js:1285-1292` `_textPauseTimer=setTimeout(…,400)` mounts the spinner guarded by `isStreaming`; the stream-end `finally` (`:3307+`) never calls `_cancelThinkingTimer()` (grep ⇒ 0), relying on the guard. But `updateSubmitButton('idle')` (flips `isStreaming` false) is gated behind `if(!_isBgFinally)` (`:3388-3390`); on a session-switch-mid-stream `isStreaming` stays true ⇒ a `_textPauseTimer` armed in the last ~400ms fires, finds `isStreaming` true, and appends `.agent-thinking-dots` into the foreground `#chat-history` for a stream that ended in the background.
- **Differential:** distinct from TRANS-1 (`_elapsedTicker`); this is the text-pause timer. Window = backgrounded-stream completion before the next foreground stream resets `isStreaming`. **Fix dir:** unconditional `_cancelThinkingTimer()`+`_removeThinkingSpinner()` in the finally, or reset the stream's own-session `isStreaming` at finally-top regardless of background.

### TX-3 · `[NIT]` · CONFIRMED · New-season `nudge()` WAAPI box-shadow pulse ignores reduced-motion — the code comment claims "reduced-motion safe" but `Element.animate()` runs regardless
- **Evidence:** `orwellNewSeason.js:256-260` `_win.el.animate([...],{duration:1400})`; comment `:252` falsely asserts no-op under reduce; no `matchMedia` guard (grep). One-shot (so 2.3.3 honor-reduce gap + a false comment, not a 2.2.2 >5s loop). **Fix dir:** gate behind `matchMedia('(prefers-reduced-motion: reduce)').matches`.

### TX-4 · `[NIT]` · CONFIRMED · Toast success-checkmark animates under reduced-motion (descendant selector not in the reduce block)
- **Evidence:** `.toast .toast-checkmark` `animation: toastCheckPop 360ms forwards` + `polyline toastCheckDraw` (`style.css:4263-4279`); reduce block (`:22182-22191`) sets `.toast{animation:none}` but `animation` doesn't inherit, and there's no `*{animation:none}`. Steelman: the `opacity:0→1 forwards` still completes ⇒ NOT stuck-hidden (dangerous mode absent) — it merely pops when it should be static. **Fix dir:** add the descendant selectors to the reduce block with the opacity end-state forced.

### TX-5 · `[NIT]` · CONFIRMED · Gadget-rail `grail-focus-flash` doesn't re-fire on rapid repeat focus; the first timer cuts the second flash short
- **Evidence:** `orwellGadgetRail.js:114-128` add class + `setTimeout(remove,900)`; CSS `grail-focus-flash .9s` (`:430`). Re-adding a present class doesn't restart a CSS animation; the first click's timer removes the class mid-second-flash. No per-element timer handle / reflow restart. **Fix dir:** per-element timer cancel + force-restart (`void offsetWidth` or `getAnimations().cancel()`).

### TX-6 · `[NIT]` · CONFIRMED · Action-toast leaves `pointer-events:auto` on the `×`/action paths (only auto-hide resets it) → intercepts top-right clicks during its ~0.45s exit slide
- **Evidence:** `ui.js:395` sets `pointerEvents='auto'` (for the Undo btn); auto-hide resets at `:419` (with a comment that this was previously missed) but the `×` handler (`:386-392`) and action handler (`:357-362`) don't ⇒ during the `.exiting` slide (`transform .45s`) the toast still eats clicks in the top-right. Bounded (next `showToast` clears it; off-screen end-state is safe). **Fix dir:** reset `pointerEvents=''` in both handlers.

**Lane-H CLEAN (verified):** presence/night (full rebuild, no anim, `finally` reschedules); retrospective `_lastSig` idempotent skip-render; decision-card `_doneTimer` guarded + 15s backstop + reduced-motion gated; finalizing indicator paired begin/end in the `finally`; sessionSync reconcile debounce idempotent + EventSource reconnect capped; spinner `stop()` clears interval+raf; headshot teardown (R5/R6); gadget-rail `syncStrip` signature-guarded. *(TX-1/TX-2 graded LATENT — pre-armed traps not exercised by current consumers; the four NITs are reduced-motion/repeat-event edges.)*

## Lane I — Interaction / feedback / cognitive-load (static)

### F-NEW-1 · `[POLISH]` · CONFIRMED · `replacement` & `tie-break` decision kinds absent from `HIGH_STAKES_KINDS` — no risk skin despite ending a houseguest's game
- **Evidence:** `orwellDecision.js:39-44` `HIGH_STAKES_KINDS = {eviction-vote, final-eviction, juror-vote, nominations}` — omits `replacement` (veto replacement nominee, permanent) and `tie-break` (HOH breaks a tied vote, evicts outright). `isHighStakes()` drives the red-wash + "Irreversible" badge, so these render identical to a non-binding `comp-intent` card. **Fix:** add the two kinds (one-line). Error-prevention (Nielsen H5); cost borne by a third party, permanent.

### F-NEW-2 · `[POLISH]` · CONFIRMED · "Recast from scratch" fires the irreversible new-game POST with no confirmation
- **Evidence:** `orwellNewSeason.js:131-133` click → `startNextSeason(keep=false)` → POST `{keep:false,confirm:true}` immediately; no `styledConfirm` (which IS used for factory-reset in settings.js). Discards the player's entire houseguest identity. The `confirm:true` body key implies a client confirm the client never performs.

### F-NEW-3 · `[POLISH]` · CONFIRMED · "See how it ends" fast-forward commits `conclude-season` on single click, no confirm
- **Evidence:** `orwellNewSeason.js:196-213` `#ons-conclude` → `fetch(/api/orwell/conclude-season)` immediately; one-way (skips all remaining weeks). Steelman: evicted player has no remaining agency (partly neutralizes) — but the hint is `opacity:.6; 11.5px` below the button.

### F-NEW-6 · `[POLISH]` · CONFIRMED · Decision-card error message conflates network failure with game-rule rejection
- **Evidence:** `orwellDecision.js:500` one string for `!r.ok` (incl. 409 stale-beat, 400 illegal-move) AND network exceptions. Correct recovery differs (resubmit-after-refresh vs change-selection vs wait); the player can't tell. Error-recovery (Nielsen H9).

### F-NEW-7 · `[POLISH]` · CONFIRMED · DR-mode exit `×` ~12-18px (below touch floor) → mobile MODE-LOCK
- **Evidence:** `orwellDiaryRoom.js:77-79` `font-size:1em; padding:0 2px` at pill `--fs-xs`(12px). Exit paths = this `×`, Escape (no touch keyboard), or sending an entry. The capture-phase interception (`:131-133`) swallows normal sends in DR mode ⇒ if a mobile player can't hit `×`, EVERY message goes to the Diary Room until reload. The most blocking-adjacent of this lane.

### F-NEW-9 · `[POLISH]` · CONFIRMED · Gadget-rail resize handle `role="separator"` (non-interactive) while keyboard-operated; no `aria-valuenow/min/max`
- **Evidence:** `orwellGadgetRail.js:509-512,567-584` — arrow keys nudge width but role is structural ⇒ AT announces "separator", no operability/value feedback; should be `role="slider"`. The handle is the only non-pointer resize path (drag needs a pointer).

### F-NEW-11 · `[LATENT]` · CONFIRMED · Season winner not announced via `aria-live` (done-state branch bypasses `announceDeltas`)
- **Evidence:** `orwellStatusPanel.js:276-291` — done branch resets `_last` + `return`s before `announceDeltas`; winner injected via `.innerHTML` into `#os-done-winner` (no `aria-live`). The highest-stakes info event gives SR users no announcement.

### F-NEW-12 · `[LATENT]` · CONFIRMED · Deals panel distinguishes `open` vs `kept` by border-left-color alone (WCAG 1.4.1)
- **Evidence:** `orwellDeals.js:89-91` green vs blue border-mix; `.odl-tag` text-label is `.62rem opacity:.65` (sub-readable). `broken` has line-through (accessible); open-vs-kept is color-only — protan/deutan confusion + a real strategic distinction (active commitment vs historical).

### F-NEW-4/5/8/10/13 · `[LATENT/NIT]` · CONFIRMED
- **F-NEW-4** decision-card 15s backstop uses a blanket module-level `_userDismissed` with no per-sig binding (`orwellDecision.js:573-586`) ⇒ dismissing a low-stakes pending can suppress a later `nominations` card (cross-device/under-call path). **F-NEW-5** post-confirm prefill is identical for all kinds (`:481-485`) — generic cue loses dramatic context. **F-NEW-8** DR submit has no in-flight loading state (`orwellDiaryRoom.js:131-149`) → Doherty >400ms reads as hang, double-submit risk. **F-NEW-10** engine-down banner dismiss below touch floor + fixed-top banner occludes chat with no `padding-top` compensation (`orwellEngineStatus.js:36-50`) — worst exactly when connectivity is degraded. **F-NEW-13** new-season window `closable:false` (`:234`) with no tooltip explaining why / that it auto-dismisses (minimizable is the escape valve).

**Consequential-act safety table (lead summary):** confirmation+risk-skin present for eviction-vote / nominations / juror-vote / factory-reset / progress-reset; MISSING for replacement & tie-break (F-NEW-1), recast (F-NEW-2), conclude-season (F-NEW-3). **Cognitive-load hotspots:** simultaneous panel proliferation at game start (no progressive disclosure); DR-mode has no persistent global indicator beyond the pill; decision card injected mid-stream may scroll past unnoticed on mobile.

**Lane-I CLEAN (steelman):** factory/progress reset use `styledConfirm` with specific consequence text; decision-card done-state self-removal guard (J5-06) correct; live-game ceremony `announceDeltas` correct; presence name-disambiguation sound; DR capture-phase interception architecture correct (the gaps are interaction-layer); `comp-intent`/`comp-round` `binding`-flag differentiation correct.

---

**Lane-G CLEAN (steelman):** the MCP HTTP edge is solid — constant-time secret compare, separate admin token strictly enforced, multiuser header rejection, anti-spray `knownUser` + tight `SANDBOX_CREATING_TOOLS` allowlist on `/call` AND `/rpc`, body cap + timeout + per-user serialization, sanitized `/health` (no message/arg leak), precise typed-error→status (409 carries only `{code,beatSeq,board}`). `FileSaveStore.userDir` hex-encodes the user id (path-traversal structurally impossible) + 64-char cap. TLS scripts pass the DNS token by env (not argv) + shred + allow-list names; the engine port is never named in a generated site. Auth cookies `HttpOnly`+`SameSite=Lax`+`Secure`-under-flag; `_is_trusted_loopback` excludes proxy/tunnel-forwarded so `LOCALHOST_BYPASS` can't be inherited over cloudflared. 0071 redaction installed before first log emit.

---

## Lane E — Deterministic browser telemetry (VIEWED; Chromium 141 + fake model, no egress)
Stack: real engine :8765 + real FE :7000 + local `fake_model_server.mjs`; season seed 51000 (15 NPCs, premiere). Artifacts: `.audit-telemetry/shots/{home-desktop,home-mobile,parity-A,parity-B}.png` + `report.json` (gitignored).

### RESP-NEW-1 · `[POLISH·high]` · VIEWED · The "The House" status panel does NOT reflow on mobile — it renders ~290px off-screen-right, its close `×` and drag handle unreachable, no horizontal scroll
- **Evidence (VIEWED):** in-page `getBoundingClientRect` scan at iPhone-13 (vw=390, `document.scrollWidth==vw`, no horiz scroll): the status window's children sit at **right≈678** — `Week 1 / Premiere / ▾`, `HOH —`, `Noms —`, `Veto —` (each width 262 ⇒ left≈416), the drag handle `⠿` at right 637, the close `×` at right **687**. The desktop shot (`home-desktop.png`) shows this exact panel correctly docked on the RIGHT rail ("The House": Week/HOH/Noms/Veto + 16/16 cast + room occupancy); the mobile shot (`home-mobile.png`) shows it is **not in the viewport at all** — only the in-chat welcome strip is visible.
- **Mechanism:** the right-rail status panel keeps ~desktop placement on a 390px viewport instead of reflowing into a mobile representation (drawer / docked row / full-width). Because the body doesn't scroll horizontally, the panel's content and its only close affordance (`×` at x687, ~300px past the right edge) are **clipped and unreachable** — a WCAG 1.4.10 (reflow) + 2.5.5 (target size, and here target *reachability*) failure on a first-class CI-gated surface.
- **Differential:** distinct from the prior RESP-1 (minimized-dock-row `×` size), RESP-2 (cast-panel buttons), RESP-3 (copy-btn hover), RESP-4 (gate blind spot) — this is the **entire status panel mounting off-screen on mobile**, not a sub-control size. Not a legitimate reflow (content is lost/unreachable, not rearranged). Steelman considered: "it's meant to be drawer-hidden on mobile" — but it is rendered visible (not `display:none`) at off-screen coords, taking layout, so it's mis-placed, not intentionally stowed.
- **Confidence:** high (rect scan + paired desktop/mobile shots). **Falsifier:** the panel's bounding-rect right (678) ≤ viewport (390) on mobile, or a horizontal-scroll/drawer path reaches it — neither is present. **Latent siblings VIEWED in the same scan:** `Close guide` (premiere tutorial) 102×36 on mobile (h<44, corroborates prior UX-3/RESP); `export-dl-btn` 36×44 (w<44); composer "Message input" 24px tall at empty state (grows on input — likely benign).

### PARITY-AT-REST · PASS (VIEWED)
Two same-identity desktop windows on one season: engine truth identical (`phase=premiere, week=1, beatSeq=1, hoh=null`) and HUD identical across both windows — no render garbage / state bleed at rest. (A concurrent-write LOOP + the SYNC-FOCUS-1 backgrounded-tab repro need an engine-mutation driver the fake model can't emit; deferred to the live lane.) **0 console/page errors** on desktop and mobile load.

---

## Lane D — UX content & accessibility (static)
*Lead severity note: the specialist rated A11Y-1/2/3 `[BLOCK]`; for a single-player launch I recalibrate the SR-experience items to `[POLISH·high]` (real WCAG failures, not progression-blockers) — keeping the agent's evidence verbatim. All cross-checked NEW vs both prior ledgers.*

### A11Y-1 · `[POLISH·high]` (agent `[BLOCK]`) · CONFIRMED · Presence & night gadgets re-announce the FULL string to screen readers every 25s poll
- **Evidence:** `orwellPresence.js:148-149` sets `role="status"`+`aria-live="polite"` on the section ROOT; `render()` (`:183-198`) writes `textContent`/`innerHTML` into children every 25s poll unconditionally. Identical in `orwellNightStatus.js:71-72,103-119`. The correct counter-pattern is documented + implemented one file over (`orwellStatusPanel.js:99-101` `#os-announce` delta-only child).
- **Mechanism:** any mutation inside a live-region root fires a polite announcement; writing children every poll re-announces "Kitchen — Keith, John, Joe" 2–3×/min even on no-change. During lingering play (the core ADR-0003 mode) an SR user is interrupted constantly and may disable the SR, missing game-relevant announcements. **Falsifier:** `render()` diffs and skips no-op writes (it doesn't). Fix: adopt the `#os-announce` delta pattern; drop `aria-live` from the root.

### A11Y-2 · `[POLISH·high]` (agent `[BLOCK]`) · CONFIRMED · New-season transition errors are NEVER announced to SR
- **Evidence:** `orwellNewSeason.js:97` `.ons-msg` is a plain `<div>` (no role/aria-live); `setMsg(err,true)` (`:127,149-150`) sets `textContent` → zero SR announcement. Buttons re-enable on failure with no audible signal.
- **Mechanism:** season transition is irreversible (keep vs recast the character); a silent failure leaves the SR user unaware → repeated POSTs to a broken endpoint. **Fix:** `role="status"` + escalate to `aria-live="assertive"` on error.

### A11Y-3 · `[POLISH·high]` (agent `[BLOCK]`) · CONFIRMED · Finale `#ofin-stage` carries its OWN `aria-live` next to the correct hidden announcer → re-announces stage every 5s
- **Evidence:** `orwellFinale.js:109` visible `#ofin-stage` has `aria-live="polite"`; a correct hidden `#ofin-announce` already exists (`:114`). Both announce; the visible div fires on every 5s `render()`.
- **Mechanism:** during extended jury questioning the SR is interrupted every 5s with the unchanged stage name, drowning out the actual chat-streamed questions/answers/vote reveals at the game's climax. **Fix:** remove `aria-live` from `#ofin-stage`; route deltas through `#ofin-announce`.

### A11Y-4 · `[POLISH]` · CONFIRMED · Diary-Room error uses polite `role="status"` for an actionable failure → may never surface
- **Evidence:** `orwellDiaryRoom.js:72` pill `role="status"`; error written to it (`:147`) is polite ⇒ deferred behind the always-active chat stream. A failed confessional (no in-game pathway, a real game-state write) silently doesn't record. **Fix:** assertive on error only.

### A11Y-5 · `[POLISH]` · CONFIRMED · Status-panel collapse toggle: static `title="Collapse"` never updates; accessible name lacks state + section context
- **Evidence:** `orwellStatusPanel.js:150` `role="button" title="Collapse"` set once in innerHTML; `aria-expanded` toggles but `title`/name never do ⇒ SR hears "Collapse" even when collapsed (inverted affordance, WCAG 4.1.2). **Fix:** sync `aria-label` to "Expand/Collapse game status" on toggle.

### A11Y-6 · `[POLISH·high]` · CONFIRMED · Kit-window controls (minimize/close) 24×24px — below the project's own 44px coarse floor, systemic across EVERY floating panel
- **Evidence:** `orwellWindow.js:132-133` `.ow-controls button,.ow-dismiss {min-width:24px;min-height:24px;padding:0}`, `gap:2px` (`:128`). Affects Finale/Cast/Retrospective/all dockable windows. The project floor is known (`orwellFinale.js:91-93` comment lifts `.ofin-btn` ~27→36). **Differential:** distinct from prior RESP-1 (dock-row × 16px) — this is the titlebar controls. **Fix:** 44px with negative-margin footprint preservation.

### A11Y-7 · `[POLISH·high]` · CONFIRMED · Decision option chips `.odec-opt` 36px on the one BINDING-decision surface
- **Evidence:** `orwellDecision.js:120` `min-height:36px`; nomination/veto chips, `gap:.4rem` (8px). **Differential:** distinct from prior UX-10 (the Confirm *button*); these are the *selection* chips. A fat-finger between chips on mobile selects the wrong houseguest (recoverable via `aria-pressed` but reads as a glitch). **Fix:** 44px.

### A11Y-8/9/10/11 · `[POLISH/NIT]` · CONFIRMED
- **A11Y-8** new-season/finale buttons 36px (`orwellNewSeason.js:88`, `orwellFinale.js:93`) — below floor on consequential actions.
- **A11Y-9** section headers "The House" (`orwellStatusPanel.js:162`) + "🤝 Your deals" (`orwellDeals.js:106`) are plain `<div>` ⇒ invisible to heading navigation (WCAG 1.3.1); landmarks work, heading outline doesn't.
- **A11Y-10** finale prefill buttons put emoji/`→` in `textContent` with no `aria-label` ⇒ "ballot box with ballot Vote for…"/"rightwards arrow [appeal]" (distinct from prior UX-8 = window title).
- **A11Y-11** engine-status banner dismiss `aria-label="Dismiss"` context-free across all banner variants.

### CONT-1/2/3 · `[NIT]` · CONFIRMED · Voice breaks
- **CONT-1** `orwellOnboarding.js:185` "Continue anyway" — OOC system-speak on the first in-fiction holding card a fresh player sees. **CONT-2** `orwellNewSeason.js:149` "Couldn't start the next season" uses meta "season" vocabulary (contrast the in-fiction "The Vault would not open"). **CONT-3** `orwellRetrospective.js:196` hardcodes `color:#fff` instead of `var(--on-accent,#fff)` ⇒ latent contrast fail on custom light `--accent`.

**Lane-D CLEAN (steelman, re-confirmed):** the `#os-announce`/`announceDeltas` delta pattern (`orwellStatusPanel.js:232-250`) is the correct reference impl; decision chips use `aria-pressed` correctly; DR success copy + engine-status banner ("Production is building the house…", "Reconnecting to Big Brother…") are model in-fiction technical-state copy; phase-enum→show-language translation never leaks engine vocab (`:209-215`); emoji `aria-hidden` on night status (`:104`); Escape handling across holding card / DR / window kit. **Note for future copy sweeps:** "feeds are down"/"camera glitched"/"the Vault would not open" are load-bearing *intentional* fiction — do not "standardize" them as customer-service text.

## Wave-5 surfacing (search lane, 2026-06-22) — persistence & consequence-loop integrity spine

*Read-only surfacing pass over `orchestrator.ts` / `registry.ts` / `gameWatcher.ts` / `FileSaveStore` /
`SoulStore` + the 0023 consequence-fold persistence. **Net: the spine is sound** — no BLOCK-severity Vault
leak, non-degradation drop, 200-then-rollback, or commit race. Two LATENTs below; 7 candidates steelmanned
CLEAN (beatSeq restore on a refused commit; atomic soul-fold+beat persist; `recordSceneMemory` includes-dedup;
the vault-leak fast-path prefix-trust; direct `engine.events.record` hooks vs the rev/events cache key; the
single-threaded watcher/commit ordering; `FileSaveStore` fsync+rename durability).*

### PERS-NEW-1 · `[LATENT]` · CONFIRMED (engine-clean, FE-only) · A stale-409 drops a scene's only consequence fold (the roadmap A-S3, now traced)
- **Evidence:** `EngineCommandsAdapter.recordInteraction` calls `guardBeatSeq(expectedBeatSeq)` FIRST → `GameSessionAdapter.guardBeatSeq` throws `StaleBeatError` **before any mutation/fold** (correct fail-closed; at-most-once). The loss is FE-side: `docs/REFACTOR-ROADMAP.md` R1c — the FE reconciles `beatSeq` and **skips** the refused `recordInteraction`/`makeDeal`/`moveTo` rather than re-attempting it against the refreshed board.
- **Mechanism:** if a player↔NPC scene's `recordInteraction` is the SOLE record of that moment and 409s (a 0064 queued cross-device turn moved the board mid-scene), the fold silently evaporates — mandate #4 / ADR-0005 #4 ("a novel move must never evaporate"). **Extends the roadmap item:** the engine half is provably correct (the throw precedes the write), so a FE re-attempt against the refreshed `beatSeq` is SAFE and cannot double-apply — the fix is purely additive on the FE.
- **Falsifier:** force a stale `expectedBeatSeq` on a turn's sole `recordInteraction` and assert the fold still lands exactly once after reconcile. Today no such retry path exists in `agent_loop.py`/`chat_helpers.py`. **Confidence:** high.

### PERS-NEW-2 · `[LATENT/NIT]` · CONFIRMED · A future-version (parse-OK) save can be aged out of retention after a rejected resume
- **Evidence:** `registry.ts` — a resume that throws in `importSnapshot` (incl. a `snapshotVersion` mismatch) falls back to a FRESH sandbox. Unlike a JSON-parse failure, a future-version save parses fine, so `FileSaveStore.loadLatest` does NOT quarantine it (`.corrupt` rename is parse-throw only). The fresh game's saves then write `vN+1…`, and `prune` keeps only `RETAIN_RECENT=5` + periodic checkpoints.
- **Mechanism:** ~5 fresh saves push the original (recoverable-on-downgrade) save out of retention permanently. Narrow — a schema-downgrade-only edge, bounded by retention; the original is the user's own higher-schema save. **Fix:** a quarantine-on-incompatible-version belt parallel to the corrupt-quarantine, so a rejected resume can never age the original out. **Falsifier:** write a `snapshotVersion:999` save, open a fresh registry, make 6+ mutations, confirm the `v999` file was pruned (`snapshotCompleteness.test.ts:77-94` only asserts "no crash → fresh sandbox", not survival). **Confidence:** medium.
