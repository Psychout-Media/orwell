# 2026-06-10 — Full product audit (round 5): architecture, wiring, FE/UI, game design & player experience

> 📋 **Audit record** · 2026-06-10 · Full product audit (round 5) · **Status:** **ACTIVE — authoritative open-items ledger** (product-owner rulings #1–#21 + the campaign close-out + the 2026-06-19 reconciliation + the 2026-07-05 audit-closure fan-out)

**Scope.** A complete sweep of the repo at `main` (87687c0): the engine's ports/composition/
adapters/surfaces, the pure core and every `src/engine` system against the canonical mechanics
(CLAUDE.md, `bb-sim-spec.md`, ADRs 0001–0004, the legacy Bible rulings), the vendored front-end
(routes, services, all `orwell*.js` panels, the agent loop), the spec/queue/docs record against
the code, and the test/ops/security posture. Seven parallel audit streams; findings merged and
deduplicated. PR #200 (the round-4 UI & runtime audit, D1–D11) is **incorporated by reference**
— its findings are not re-numbered here; where a finding below deepens or extends a D-item, it
says so.

**Baseline.** `npm test` green end-to-end (typecheck → build → 500 unit/property/arch → 315 BDD
scenarios, exit 0); FE pytest + smokes green. As with round 4, **nothing below is a failing
test** — every finding is unasserted behavior, which is itself the recurring meta-finding: the
gates are excellent on the seams they measure and blind on the seams players live on (season 2,
the late game, the social loop's consequences).

**The one-paragraph verdict.** The deterministic skeleton is faithful and well-tested:
eligibility, comp math, the endgame ladder, the finale choreography, persistence, and the Vault
structure all verify clean, and no code path protects the player. The product gap is
concentrated in three places: (1) a **restart/persistence-integrity family** that makes starting
a second season structurally impossible in production (E1–E8, deepening D1); (2) the **social
simulation not mattering** — deals, gossip, blocs, and the emotional arc are built but
disconnected from decisions, so three shipped systems are flavor instead of consequence
(E42–E58); and (3) a **player-experience integrity-and-calibration set** — the player never
reaches the jury (D4), the engine speaks for the player at goodbyes (E34), and the UI has the
D-batch's layout/lifecycle defects plus the panel/sidebar ruling below (E64).

---

## Product-owner decisions PENDING (PO list)

Items surfaced by the audits and deliberately **NOT auto-fixed** because they are product-owner
**judgment calls** (taste / tradeoffs), not defects. Full context for each lives in the LW log
(live-walkthrough section below). When decided, record the call in the rulings list under this and
strike the item.

- **PO-1 — Eviction-night length (LW11).** The eviction night runs long: the staged secret-ballot
  reveal (vote by vote) plus the player's goodbye-message authoring. It could be batched/trimmed like
  the staged competitions (#420), or kept as-is. *Tradeoff:* the comp rounds were repetitive filler
  (rightly batched), but the eviction reveal + goodbyes are a **core dramatic beat** — the vote-by-vote
  tension is the week's payoff, so trimming risks flattening the most dramatic moment. *Implementer's
  lean:* keep it, unless live play shows it dragging. If trimmed, it's presentation-only engine work
  (the eviction sub-loop in `liveSeason.ts`), mirroring the comp-batching pattern.

---

## Product-owner rulings recorded this session (2026-06-10)

1. **NPC names must be realistic** — "determined based on what could be a real name." The
   phoneme-mash generator is replaced by seeded sampling from vendored real-name corpora
   (full spec at E38). The 0004 "no hard-coded name list" do-not is amended to "**no fixed
   cast**: name corpora are raw material; no full-name+persona pairing may be hard-coded; the
   legacy Bible's names stay banned."
   **Amended again — ruling #1 (amended), owner-ratified 2026-07-12 (feature 0116 §5):** names (and
   the whole cast skeleton) are now **model-generated + engine-validated** rather than corpus-sampled.
   The validators keep every guarantee ruling #1 protects — per-house + cross-season uniqueness, the
   **legacy-Bible deny-list**, plausible shape, **no player-name collision** — and **per-season
   generation makes a fixed cast structurally impossible** (a strictly stronger guarantee than
   sampling from a fixed pool: there is no static pairing *to* hard-code). The vendored corpora survive
   as the **deterministic floor** (stubbed / keyless-CI / golden lanes), so 0004's `isCorpusName`
   inverse-realism gate becomes **floor-scoped** rather than universal; the deny-list is enforced on
   **both** paths; the **roles-only test rule is unchanged**. See `docs/features/0116-model-authored-cast-genesis.md` §5.
2. **A game-only reset script must exist and run from the Proxmox host** like the other
   scripts. **Shipped with this audit**: `deploy/orwell-game-reset.sh` — clears every per-user
   engine sandbox (saves, souls, Vault, casting intake), preserves `data/.env` **and** the
   entire front-end store (accounts, sessions, LLM config); same host→LXC bridge, flags, and
   path-sanity guards as `orwell-factory-reset.sh`.
3. **The status HUD lives in the sidebar, always** — the "You / HOH / Noms / Veto / The house ·
   16/16" surface is not a floating window (full spec at E64).
4. **The Diary Room is not a window** — it becomes a **persistent sidebar button** alongside the
   app's other standing buttons (chat, theme, …); no floating dialog (full spec at E88).
5. **"___ wants a word with you" must not spawn at the beginning of the game.** The approach
   surface may remain a window, but no approach fires before the house has actually started
   playing (full spec at E89).
6. **All host-aware deploy/update/reset scripts must also target containers literally named
   `bbai`.** **Shipped with this audit**: `orwell-update.sh`, `orwell-doctor.sh`,
   `orwell-factory-reset.sh`, and the new `orwell-game-reset.sh` now fall back to an LXC named
   `bbai` when no `orwell` container exists (an explicit `CT_HOSTNAME` override disables the
   fallback; error messages name both).
7. **The theme button moves to the bottom of the sidebar, beside the settings icon — icon-only**
   ("non-intrusive but intuitive… it doesn't need to be spelled out"; full spec at E90).
8. **Window positions must persist across refresh** — today a refresh resets floating panels to
   "wrong looking and random" placements (full spec at E91).
9. **Image attach must be streamlined and actually work in-character** — attaching an image
   (or file) is the one analysis input the game wants ("an image to chat about with a
   houseguest"), and today it's one icon hidden behind another; it must be first-class and
   wired so the model analyzes the attachment and responds **in character for the moment**
   (full spec at E94). *Image generation by the model is a future spec, not an audit finding —
   see "Future specs" below.*
10. **Minimized windows must not park at the top of the chatbox.** The chip dock there doesn't
    stay centered as sidebar/viewport width changes — and the placement itself is rejected;
    minimized windows go somewhere sensible (the sidebar) instead (full spec at E95).
11. **The "Save to Documents" export item is removed** under the game build (full spec at E96).
12. **Windows animate on open, close, and minimize** (full spec at E97).
13. **The theme picker leads with 3–6 house themes** — Big Brother / creepy / Orwellian palettes
    on par with the game's identity, placed as the *first* entries in the picker. Specced as a
    feature, not a finding (see "Future specs" — 0052).
14. **Admins can retrieve old chat transcripts for debugging** — quiet, not loudly exposed:
    an admin-gated API plus a small entry in the existing admin section of Settings (shape
    chosen 2026-06-10; specced as "Future specs" — 0053).
15. **The UI enhancements track is prioritized** (2026-06-10, reaffirmed same day:
    "high-impact UI changes should be prioritized first whenever possible"): the
    chrome/windows and transcript-surface lanes are first in dispatch order — and when any
    scheduling trade-off arises between a UI lane and a non-CRIT lane, the UI lane wins.
    The S-stream's responsive-mechanism spec (ruling #16) slots at the top of the track,
    since every other window change builds on it. See the priority note in the parallel
    execution plan.
16. **Responsiveness is a system, not a per-panel fix** (2026-06-10): the settings window
    must work at normal desktop scaling (text currently crowds on a standard PC); **all**
    windows need one coherent mechanism for internal responsiveness across devices and
    viewport widths; and the product is held to the bar of **a mobile web app that functions
    as if it's an installed app — integration and perfection with every placement**. A
    dedicated responsiveness & installed-app audit stream (S) is commissioned under this
    ruling; its system-level mechanism spec becomes the spine of the prioritized UI track
    (ruling #15).

**Live-transcript corroboration.** A real premiere-night session transcript supplied during this
audit independently confirms, on screen: the gibberish cast names (E38), approaches firing at
the premiere with the canned "wants a word with you" pretext (E60/E89), raw expandable JSON for
`renderScene`/`socialRead`/`socialInitiatives` tool nodes (E11/D5), the visible composer model
picker with raw model ids (E72), the Agent|Chat mode toggle on game turns (D7), the persona/
preset modal reachable mid-game (E16), the GM breaking the fourth wall to ask "Record this
interaction? Or keep it breezy?" (the E22 enforcement gap surfacing as prompt-level
uncertainty), and message edit/delete controls active on game turns (new — E93).

---

## The E-batch findings

Severity: **CRIT** (breaks play or a mandate) · **HIGH** (mandate-adjacent or player-visible
every game) · **MED** · **LOW**. Category: Bug / Change / Improvement / UX / Test / Ops / Drift.
File references are to `main` @ 87687c0.

### Theme 1 — Restart & persistence integrity (the season-2 family)

- **E1 [CRIT · Bug] ✅ PR #215 — Even the *admin* reset resurrects the old season — the orchestrator baseline
  is never invalidated.** `orchestrator.ts:89` (`baselines` map, never cleared), `:209–229`
  (fault ⇒ `registry.restore(user, baseline!)`); `registry.ts:271–277` (`resetUser` builds a
  fresh sandbox, never notifies the orchestrator). After any reset, the next mutation reads as a
  count regression vs. the dead season's snapshot ⇒ degradation fault ⇒ the old game is
  reimported; after 3 faults the circuit opens. This **deepens D1** (the FE using the
  `createCharacter` door is only half the bug — the sanctioned door is broken too).
  *Fix:* `Orchestrator.resetUser(user)` clearing baselines/faults/rngs/health, called via an
  `onReset` hook from `registry.resetUser` (and from a fixed `confirmRestart` path, see E4);
  restart faults must surface as 4xx, never 200-then-rollback (D1). *Test:* compose the real
  runtime, play, reset, play season 2, simulate engine restart ⇒ season 2 persists
  (`lastIntegrity:"ok"`). (Today `opsHardening.test.ts:70` tests reset without `setCommit`
  wired — the production spine is exactly what's untested.)
- **E2 [HIGH · Bug] ✅ PR #215 — Pre-game off-screen ticks fabricate hidden history with synthetic NPCs.**
  `orchestrator.ts:233–235` ticks on every commit; `:332` falls back to `npc(1..4)` when no
  house exists; `:162` returns `Infinity` pool size pre-game — so each casting-interview answer
  records hidden scenes + Vault confessionals **before the season exists**, later humanized into
  the real cast's names by `seasonRetrospective` (scheming dated before move-in; non-degradation
  forbids deleting it). *Fix:* no-op the tick when `!session.snapshot().started` (as
  `gameWatcher.ts:56` already does); delete the synthetic pool from `defaultApply`. *Test:*
  two `updateCasting` calls ⇒ zero hidden events pre-`createCharacter`.
- **E3 [HIGH · Bug] ✅ PR #215 — A faulted commit returns 200 with a view of rolled-back state.**
  `orchestrator.ts:222–229` (fault path returns void), `registry.ts:183–188` (fire-and-forget),
  `GameSessionAdapter.ts:853` (mid-method `onPersist`). The sandbox is swapped while the old
  one's method is still executing; the FE narrates a beat that officially never happened — the
  literal "narrated but never recorded" failure at the engine seam. *Fix:* propagate the commit
  result; on fault throw a typed "turn refused, state unchanged" error (HTTP 409/500); single
  `onPersist` at end of `commit(ev)`. *Test:* inject a faulting checkpoint, call `advanceGame`
  over HTTP ⇒ error response, `getGameState` unchanged.
- **E4 [MED · Bug] `confirmRestart` is honored on the player channel and leaves the old season's
  events/knowledge/Vault in the sandbox.** `GameSessionAdapter.ts:499` (arg honored though not
  in the documented player schema, `GameSession.ts:162–167`); the path replaces only
  `house/live/deals` — EventStore, KnowledgeService, Vault, relationship edges, souls persist ⇒
  cross-season bleed in recap/retrospective/NPC knowledge (and Vault twist-id collisions,
  `registry.ts:80–84` + `InMemoryVaultStore.ts:15–17` accepting duplicate ids silently).
  *Fix:* strip `confirmRestart` at the MCP boundary for the player channel; restarts route only
  through the (E1-fixed) reset delegate; dedupe `writeHidden` by id. *Test:* player-channel
  `createCharacter` twice with `confirmRestart:true` ⇒ second call no-op; post-reset recap empty.
- **E5 [MED · Bug] An incompatible (future-version) save silently becomes a fresh game and is
  then destroyed by pruning; rollback strands forward-migrated saves.** `registry.ts:203–211`
  (catch ⇒ fresh sandbox "bad save left on disk"), but `FileSaveStore.prune` (`:74–89`) unlinks
  it after ~5 saves; `orwell-update.sh --rollback` then yields contained 500s with no path back.
  *Fix:* quarantine the user dir (`<dir>.incompatible-<ts>`) or refuse service with a clean
  "save needs a newer engine" health fault; never prune what you couldn't validate; document
  rollback-vs-saves. *Test:* `snapshotVersion+1` save → boot → 6 saves ⇒ original still on disk.
- **E6 [MED · Improvement] ✅ PR #215 — The first commit after an engine restart is checkpoint-blind.**
  `orchestrator.ts:210–212` accepts the no-baseline commit; boot preload (`runtime.ts:97–99`)
  never seeds baselines — the non-degradation guard has a hole exactly at resume-from-disk,
  where the historical thinning bug lived. *Fix:* `Orchestrator.seedBaseline(user)` from the
  loaded snapshot during preload. *Test:* resumed sandbox dropping a fact ⇒ first commit faults.
- **E7 [MED · Bug] ✅ PR #215 — Save failures are fail-open and misclassified.** `registry.ts:238–241` +
  `orchestrator.ts:179/216` (uncaught ⇒ turn proceeds unsaved, no health fault);
  `HttpMcpServer.ts:173–175` classifies any plain `Error` as deliberate ⇒ an `ENOSPC` returns
  **400** and leaks the data-dir path. *Fix:* catch around `saveUser` ⇒ `persist-failure` fault
  + rollback + typed error; classify refusals by an `EngineRefusal` type, not
  `constructor === Error`. *Test:* throwing `saveFor` ⇒ HTTP 500, health fault, state rolled back.
- **E8 [LOW · Ops] ✅ PR #218 — `FileSaveStore` durability + user-id length.** `FileSaveStore.ts:66–70` (no
  fsync of file/dir before rename — power loss ⇒ `.corrupt` latest, silent multi-turn step-back);
  `:39` (hex-doubling ⇒ >127-byte user header = `ENAMETOOLONG` 500s). *Fix:* fsync before
  rename; cap `x-orwell-user` ≤64 chars at the HTTP edge (400).

### Theme 2 — Vault Wall & knowledge integrity

- **E9 [HIGH · Bug] ✅ PR #212 — `surfaceInformationTo` launders invented facts into full-confidence
  knowledge.** `InMemoryKnowledgeService.ts:110–111` — `overheard:<id>` anchoring checks only
  that *some* event with that id exists; the fact's content is never compared. Any caller with
  one legitimate event id can mint arbitrary "anchored" player knowledge with clean provenance.
  *Fix:* require content derivation from the referenced event (normalized fragment check, as
  `rollOverhears` at `presence.ts:96–101` already produces), or reserve `overheard:` minting to
  the engine and downgrade caller-supplied overhears to suspicion. *Test:* invented content vs.
  a real id ⇒ `surfaced:false`, suspicion only.
- **E10 [MED · Bug] Goodbye-message tones broadcast the hidden affinity matrix weekly.**
  `registry.ts:89–97` witnesses every BeatEvent to the player, incl. `eviction-goodbye` whose
  tone is a threshold read of the hidden edge (`liveSeason.ts:528–533, 597–603`) — three
  calibrated samples of hidden sentiment per eviction, for scenes the player couldn't witness.
  *Fix:* witness goodbyes to `[sender, evictee]` only (the evicted player still gets theirs,
  0046 intact). *Test:* third-party goodbye is hidden and absent from `getVisibleStateFor(player)`.
- **E11 [MED · Change] `npcVoice` is the widest sanctioned aperture and its raw output renders
  in the transcript.** Engine: `GameSessionAdapter.ts:224–261` hands any caller every NPC's
  last-20 known facts + suspicions + full stance matrix on demand, ungated. FE: `npcVoice` (and
  `updateCasting`/`whereabouts`/`seasonRecap`/`seasonRetrospective`) miss `_orwellToolBeats`
  (`chat.js:1117–1136`) so their JSON renders one click away (extends **D5**). *Fix:* FE — the
  five diegetic labels + C13 drift test iterating `ORWELL_GAME_TOOLS`; engine — gate
  `knows/suspects` to co-present/adjacent NPCs via the 0049 model, and cap stances to top-k
  polarized edges (see E59). *Test:* non-adjacent NPC returns persona+stances, no `knows`.
- **E12 [MED · Change] ✅ PR #217 — Per-voter eviction attribution kills vote secrecy.** `liveSeason.ts:582`
  reveals `voter → votedFor` pairs to the player beat-by-beat; real-BB ballot secrecy (rogue
  votes, scapegoating, paranoia) is impossible and blocs/deal-breaks are perfectly legible.
  *Fix:* anonymized running tally outward ("a vote to evict X…"); `voteOf` stays engine-internal
  for manner/deal reconciliation; attributions unseal in the 0048 retrospective. *Test:*
  `EvictionView`/reveal events carry no voter identity pre-finish; the retrospective does.
- **E13 [LOW · Change] `voteChoice` mind-reads.** `liveSeason.ts:399` consumes the *nominee's*
  private trust toward the voter inside the voter's decision — decisions must run on the
  holder's own beliefs (ADR 0003 §8). *Fix:* use the voter's own edge (or E54's reliability).
- **E14 [LOW · Improvement] Raw `npc:N` ids leak into visible text on the
  `PlayerSurface.renderLog`/gossip path.** `gossip.ts:64–66`; only adapter-mediated views
  humanize. *Fix:* humanize at the projection (inject a name resolver).
- **E15 [MED · Change] ✅ PR #214 — `GET /api/orwell/moment` hands any player the full GM system prompt**
  (lever manifest, casting status, per-moment instruction) — no JS consumes it
  (`orwell_routes.py:67–73`); pure meta-knowledge + prompt-extraction shortcut. *Fix:* delete
  or admin-gate the route.
- **E16 [MED · Change] ✅ PR #214 — Player-authored preset system prompts ride the GM stack on game turns.**
  `chat_helpers.py:142–145` prepends the GM prompt onto `preface[0]` = the preset persona; the
  custom-preset modal survives the game build (`index.html:1129–1206`). A player can steer
  narration tone/recording discipline ("always portray the house as adoring me"). *Fix:* drop
  `preset.system_prompt` from the preface when `game_active` (ADR 0003: prefer removing
  context). *Test:* pytest asserting the preface on a game turn contains only the GM prompt.
- **E17 [MED · Change] ✅ PR #211 — `search_chats` is in the game-build keep-set** (`agent_tools.py:112`) —
  the GM can "remember" prior seasons and OOC chats, a parallel memory rivaling the stores
  ("memory is the store *recalled*, never the chat *remembered*"). *Fix:* move to
  `GAME_TOOL_OPTIONAL`.
- **E18 [MED · Test] ✅ PR #221 — The dependency-cruiser Vault rule is an enumerated denylist.**
  `.dependency-cruiser.cjs:19–25` misses `characterFactory.ts` (generates `hiddenElements`),
  `emotionalArc`, `consequence`, `deals`, `decisions`, `jury`, `blocs`, `presence`,
  `competitionLibrary`. *Fix:* default-deny `OUTWARD → ^src/engine/` (+ engine/inmemory/
  embedding adapters, non-outward composition) with a narrow allowlist; lands green today.
- **E19 [MED · Test] ✅ PR #221 — The live sentinel sweep covers most tools only at week 1.**
  `liveSentinel.property.test.ts:94/:103` — per-beat re-sweep is 7 tools; `npcVoice`,
  `whereabouts`, `socialRead`, `seasonRecap`, goodbye/juror surfaces are never swept after the
  house evolves. *Fix:* add cheap reads to the per-beat list + one full post-finish sweep
  (excluding the sanctioned `seasonRetrospective`).

### Theme 3 — Anti-sycophancy & "recorded or it didn't happen"

- **E20 [MED · Bug] ✅ PR #212 — `resolveCompetition` is a seed-shopping oracle on the player channel.**
  `surfaces/tools/registry.ts:36` + `EngineCommandsAdapter.ts:112–117` — caller supplies
  participants **with stats** and the seed; nothing recorded, no folds. *Fix:* remove from
  `PLAYER_TOOLS` (keep the pure fn for tests) or delegate to the live loop's already-resolved
  result (remediation principle #1). *Test:* absent from `listTools()`, refused by `callTool`.
- **E21 [MED · Bug] ✅ PR #212 — `recordInteraction` can mint hidden (Vault-layer) events and steer hidden
  edges without bound.** `EngineCommandsAdapter.ts:88–92` (player-channel witness set excluding
  the player ⇒ off-screen "ground truth" indistinguishable from engine scenes), `:105–107`
  (caller picks kind/direction; `MAX_FOLDS_PER_INTERACTION` caps per call, not per beat).
  *Fix:* player channel requires `PLAYER ∈ witnessSet`; per-beat/per-pair fold budget. *Test:*
  witness set without player throws; N identical calls move an edge ≤ budget.
- **E22 [HIGH · Improvement] ✅ PR #214 — The cardinal sin is enforced only by prompt wording FE-side.**
  `agent_loop.py:68–84` is the entire enforcement; nothing in the agent-stream completion
  (`chat_routes.py:1198–1221`) checks that a narrated `game_active` turn made ≥1 engine write.
  *Fix:* on `[DONE]`, if narration is non-trivial and `_agent_tool_calls` holds zero engine
  writes, fire a server-side fallback `recordInteraction` (bounded digest) + counter. *Test:*
  pytest asserting the guard.
- **E23 [MED · Bug] ✅ PR #214 — Instructed retry of `advanceGame` with no idempotency key can
  double-advance a beat.** `agent_loop.py:76–78` ("try the call once more") + 30s client
  timeout where the engine may have committed. *Fix:* on transport failure re-read
  `gameStatus`/pending and report "may already be resolved" (or add an idempotency token).
- **E24 [MED · Bug] ✅ PR #214 — Incognito ("Nobody") bypasses all game framing under the game build.**
  `chat_helpers.py:105–106` early-returns; reachable via `/incognito` + hidden checkbox —
  unframed, unrecorded imitation play. *Fix:* under `game_build_enabled()` disable the toggle
  or apply game framing regardless.
- **E25 [MED · Bug] ✅ PR #214 — Sync `/api/chat` persists the user message *before* the 409 game-turn
  refusal** (`chat_routes.py:322–342`) ⇒ orphaned/duplicated transcript messages. *Fix:* hoist
  the check before `add_user_message` (or pop on raise).
- **E26 [LOW · Improvement] Idempotent no-op answers look like acceptance.**
  `GameSessionAdapter.ts:805` (stale `kind` ⇒ silent `advanceView(null)`), `:570` (post-start
  `updateCasting` returns an empty "ready" status). *Fix:* explicit `accepted:boolean`/`reason`
  on the views.

### Theme 4 — Cross-user isolation & edge security

- **E27 [HIGH · Security] ✅ PR #221 — One shared token grants any-user impersonation *and* God Mode.**
  `HttpMcpServer.ts:112–119` — the same bearer authorizes `/player/call` and `/admin/call` for
  any `x-orwell-user`; the installer writes a single `ORWELL_ENGINE_TOKEN`. *Fix:* separate
  `ORWELL_ENGINE_ADMIN_TOKEN` required on `/admin/*`; optionally HMAC the user id under the
  secret; `crypto.timingSafeEqual` for compares. *Test:* player token on `/admin/call` ⇒ 401.
- **E28 [MED · Security] ✅ PR #221 — The B34 anti-spray gate is bypassable and sandbox-minting is
  unbounded.** `GET /:channel/tools` resolves a sandbox for any asserted user
  (`HttpMcpServer.ts:122–124` → `registry.sandboxFor`), making them "known" for later POSTs;
  `SANDBOX_CREATING_TOOLS` lets `updateCasting` mint sandbox + durable disk file per sprayed id.
  *Fix:* serve the static per-channel tool list without resolving; apply `knownUser` to GET;
  LRU-cap un-started intake sandboxes. *Test:* unknown-user `GET /player/tools` ⇒
  `userCount()` unchanged, follow-up POST still 404.
- **E29 [MED · Security] ✅ PR #214 — All FE bearer-token (`ody_`) callers collapse into one engine user
  `"api"`.** `app.py:349` + `orwell_routes.py:28–30` (uses `current_user`, not
  `effective_user`) — two tokens from different owners share one game: a direct cross-user
  isolation break. *Fix:* resolve `api_token_owner` in game routes (or 403 bearer callers on
  `/api/orwell/*`). *Test:* two owners' tokens ⇒ two distinct `X-Orwell-User` values.
- **E30 [MED · Bug] ✅ PR #221 — Unhandled-rejection crash window in the per-user HTTP queue.**
  `HttpMcpServer.ts:86–92` — a rejecting job on a drained queue (e.g. `send` on a
  timeout-destroyed socket) has no `.catch` ⇒ process exit on modern Node. *Fix:* wrap job
  bodies; `tail.catch(()=>{})` before `finally`.
- **E31 [MED · Bug] ✅ PR #221 — Malformed tool args are 500s** (= **D10**, endorsed) — plus
  `McpServer.ts:43–101` casts blindly; add per-tool required-field/shape checks returning
  deliberate 400s with field names.
- **E32 [LOW · Ops] ✅ PR #218 — Edge hygiene cluster.** Installer never sets `ORWELL_ENGINE_MULTIUSER=1`
  though FE auth defaults on; `SECURE_COOKIES` defaults off and is never written by the
  installer (document for TLS deploys); reads shouldn't mint sandboxes
  (`orchestrator.ts:307–321` `freshHealth` — add `peekSandbox`).

### Theme 5 — Game design: calibration & player agency

- **E33 [CRIT · Bug] ✅ PR #220 — The player never reaches the jury** (= **D4**, endorsed with the round-4
  evidence: 62/62 passive seeded seasons evicted pre-jury; p ≈ (5/14)⁶² under fair play).
  Anti-sycophancy ("never protect the player") cannot mean "the player always loses pre-jury" —
  jury, finale, juror's seat, and eviction night are unreachable content. *Fix:* calibration
  investigation (move-in threat priors; threat-primary noms vs. NPC↔NPC off-screen bond
  deepening while a passive player's edges idle — E45/E57 are co-causes) + a permanent property
  gate ("across N passive seeds the player reaches jury in ≥X%"); re-measure social play after
  D1/E1.
- **E34 [HIGH · Bug] ✅ PR #217 — The engine authors the player's goodbye messages.**
  `liveSeason.ts:542–545` samples senders from `s.active` (player included) and `:597–603`
  asserts a tone computed from the hidden player→NPC edge — the engine deciding and narrating
  the player's own feelings, on jury management's signature lever. *Fix:* exclude `PLAYER` from
  `selectGoodbyeSenders`; add an optional `goodbye-message` pending decision (tone +
  model-voiced text) folded via `goodbyeMannerFor` exactly as NPC tones. *Test:* no
  player-sent goodbye beat without a resolved player decision.
- **E35 [MED · Bug] ✅ PR #217 — A player drawn into the veto by chip never declares intent, and the chip
  draw isn't a ceremony.** `liveSeason.ts:795–798` pauses for intent only pre-draw-resolution
  for pullers; the draw emits no witnessed BeatEvent (the field appears only on the winner
  event), so the player misses the canonical compete/throw/play-safe declaration and never
  experiences who held Houseguest's Choice. *Fix:* split into `veto-draw` (witnessed event
  naming the six + HC holder/pick; pause for `comp-intent` whenever the player is in the field)
  then `veto-competition`. *Test:* chip-drawn player gets a `comp-intent` pending; a
  `veto-draw` event precedes any winner.
- **E36 [MED · Bug] ✅ PR #217 — The F4 veto decision offers "use" then silently inverts it.**
  `liveSeason.ts:851–857/:960–963` — submitting `{use:true}` with no legal replacement resets
  `vetoUsed=false` and narrates "does not use the veto," contradicting the submitted choice and
  the 0034 legal-options contract. *Fix:* surface the F4 rule in the pending's legal set (or
  refuse with the decision standing). 
- **E37 [LOW · Improvement] ✅ PR #217 — The player-juror has no question beat at the finale.**
  `liveSeason.ts:710–712` pauses only for a player *finalist*; a juror watches their own
  question auto-answered. *Fix:* a scoreless `juror-question` pending (free text; NPC answer
  still engine-chosen) — the finale-statement precedent shows this is cheap.
- **E38 [HIGH · Bug] ✅ PR #217 — NPC names are gobbledygook ("Sheehoaika Peokakith") — product ruling: real
  names.** `characterFactory.ts:134–147` glues random ONSET+NUCLEUS+CODA syllables; the only
  filter is a capitalization regex (`:152`). Violates 0004's own "plausible BB contestant"
  bound and ADR 0003 §8 on the game's first screen. *Fix:* vendored corpora (~300+ given names,
  mixed gender/origin, weighted to the show's 20–40 casting demographic; ~400+ surnames) as
  data modules; seeded sampling without replacement per season; uniqueness as today; RNG draw
  order preserved or re-baselined (appearance/hidden side-streams hash off the name and
  re-derive). Amend the 0004/CLAUDE.md do-not per ruling #1 above. *Tests:* retarget
  `characterCreation.test.ts:50–53` from zero-name-overlap to no-*identity*-carryover; add the
  inverse realism gate (every generated part ∈ corpus — the check `0004:63–64` asked for and
  never got); roles-only rule untouched.
- **E39 [MED · Change] ✅ PR #217 — Same name ⇒ byte-identical season** (= **D8**, endorsed; engine evidence
  `GameSessionAdapter.ts:513` `seed = req.seed ?? hashSeed(playerName)`). Entropy default
  (per-creation nonce persisted in the snapshot); explicit seeds remain for tests/replays.
- **E40 [LOW · Change] Final 3 is a single comp** — the canonical three-part HOH
  (endurance → skill → jury-quiz, parts 1&2 winners meet in part 3) is specced away in 0045.
  Optional fidelity upgrade: three `final-hoh-part-N` beats via the comp library with player
  intent per part.
- **E41 [LOW · Improvement] Every season fields all 12 archetypes** —
  `characterFactory.ts:172–177` round-robins full coverage; ensemble *shape* never varies.
  *Fix:* sample with replacement under `ENSEMBLE` constraints (≥6 distinct, ≤3 dupes); widen
  the ±0.05 stat jitter modestly. *Test:* archetype-set varies across seeds; minima hold.

### Theme 6 — The social simulation must matter (behavioral fidelity)

*The highest fidelity-per-line cluster: deals, gossip, and the emotional arc are all built and
all disconnected from decisions. E42+E43+E44 convert three shipped systems from flavor into
consequence.*

- **E42 [HIGH · Bug] ✅ PR #216 — NPC eviction votes are never reconciled against deals.** Reconciliation
  runs only for the player's vote and nominate/replace beats (`GameSessionAdapter.ts:808–809`,
  `:857–868`); NPC votes (`liveSeason.ts:404–418`) and NPC HOH tie-breaks (`:591`) bypass
  `DealLedger.reconcile` — though `voteChoice`'s own docstring (`:384–386`) promises the
  betrayal "reconciles with full consequence." *Fix:* reconcile
  `{actor: voter, kind:"vote-evict", targets:[evictee]}` for every voter in `commitStagedEviction`.
  *Test:* an NPC with an open safety deal voting the player out ⇒ deal `broken`,
  `mannerByEvictee` betrayed, witnessed betrayal reveal.
- **E43 [HIGH · Bug] ✅ PR #216 — Deals self-extinguish after one ceremony and keeping one never builds
  trust.** `deals.ts:101–104` (first adverse-action-missing-partner ⇒ terminal `kept` — a
  week-2 final-two deal stops binding at the week-3 noms); no positive fold exists for honoring
  (`:89–121`), contradicting the lever manifest ("keeping it builds trust",
  `momentPrompts.ts:74–75`). *Fix:* horizon-aware resolution (safety/vote ⇒ that week's
  eviction; final-two ⇒ F2 or break) + a bounded positive fold per honoring action
  (constants-module magnitude). *Test:* final-two deal still `open()` after an unrelated week-3
  nom; honored safety deal raises trust.
- **E44 [HIGH · Improvement] ✅ PR #216 (mechanism + receipt folds + tests; the 3-line tick wiring rides Lane 1's orchestrator merge) — Gossip never changes anyone's mind.** Diffusion writes
  `KnowledgeService` beliefs (`orchestrator.ts:372–395`, model correct in `gossip.ts:81–135`)
  but noms/votes/saves/blocs/confessionals read only relationship edges — a rumor never moves
  any third party's threat read; the only fold is the tellers bonding. *Fix:* on receipt, a
  small directed fold toward the rumor's subjects keyed by scene type × belief confidence
  (new `GOSSIP_HEARD` constants). *Test:* a betrayal-rumor chain to a future HOH raises the
  subject's nomination ranking vs. the no-rumor control at the same seed.
- **E45 [HIGH · Improvement] ✅ PR #216 (motivated/co-present draw + tests behind `edgeOf`/`occupancy` deps; same tick-wiring note) — Off-screen society is socially incoherent.** `offscreen.ts:88–94`
  — uniform-random partner and nature (allies draw `betrayal` as often as `bonding`); scenes
  ignore the presence model (witness in a different room than the scene,
  `orchestrator.ts:357–364`). *Fix:* weight partner by edges (affinity→bonding,
  alignment→strategy, threat→conflict); gate `betrayal` on an existing bond + incentive;
  require co-presence. *Tests:* betrayal only over above-threshold prior bonds; every
  off-screen witness set co-located in `occupancy`.
- **E46 [MED · Improvement] ✅ PR #216 (minted at the nomination ceremony, Vault-held, fully reconciled) — NPC↔NPC deals don't exist** though comments claim they live in the
  Vault (`GameSessionAdapter.ts:111, 819–820`; `DealLedger.npcOnly()` dead). *Fix:* off-screen
  high-mutual-trust scenes occasionally mint Vault-held NPC deals; reconcile against NPC
  actions (free with E42); breaks drive folds + rumor seeds. *Test:* seeded season produces ≥1
  NPC deal; nothing crosses outward (extend the sentinel).
- **E47 [MED · Change] ✅ PR #216 — Winning a comp makes the whole house dislike you.**
  `CEREMONY_IMPACTS["comp-won"] = "conflict"` (affinity −0.16/trust −0.13 from *everyone*,
  `relationshipConstants.ts:120–126`) — allies cool on their own winner. *Fix:* dedicated
  `comp-won` impact `{threat:+0.14}` only (small affinity gain from bloc-mates optional).
- **E48 [MED · Change] ✅ PR #216 — A fully-expected, "respected" eviction still folds full betrayal-shock**
  toward every responsible voter (`relationshipConstants.ts:124` + `GameSessionAdapter.ts:767–769`),
  disagreeing with the recorded manner. *Fix:* scale the fold by manner
  (betrayed/blindsided/respected).
- **E49 [MED · Bug] ✅ PR #216 — The "departing HOH" eviction fold targets the wrong week's HOH.**
  `GameSessionAdapter.ts:770–771` reads `s.outgoingHoh` before `rollWeek` runs ⇒ the previous
  week's HOH gets the proven-threat fold twice, the current one a week late. *Fix:* fold toward
  `s.hoh`.
- **E50 [MED · Bug] ✅ PR #216 (initiator-side live; both-souls seam `recordOffscreenScene` awaits the same tick wiring) — Betrayal scenes give the *betrayer* the betrayed emotion; the victim's soul
  never moves.** `emotionalArc.ts:50–58` + `orchestrator.ts:354` (initiator-only evolution).
  *Fix:* per-role mapping (initiator→`scheme`, partner→`betrayed`); evolve both participants.
- **E51 [MED · Bug] ✅ PR #216 (adapter-side — no liveSeason edit; comp-loss scoped to contested fields) — Half the arc vocabulary is dead.** `survived-vote`/`comp-loss` exist only
  inside `emotionalArc.ts` — the emboldened-survivor beat 0041 defines never fires. *Fix:*
  `inflect(survivingNominee,"survived-vote")` on eviction; `comp-loss` for contested losers.
- **E52 [MED · Change] ✅ PR #216 (delegates to `emotionalModifier`; also retires C16's dead parallel) — The live emotional swing omits ADR 0001's temperature roll, and the
  canonical `emotionalModifier()` has no production caller** (`emotionalArc.ts:82–87`
  deterministic; `temperatureConstants.ts:79–87` dead) — two parallel formulas, one dead.
  *Fix:* seeded temperature into `evolveEmotion`; delete or delegate to `emotionalModifier`.
- **E53 [MED · Bug] ✅ PR #216 (initiative + allianceShift wired; the four consumer-less fields deleted) — `variableWeights` — the "temperature is per-moment, per-variable" config —
  is decorative** (zero consumers; subsystems roll ad-hoc variance:
  `conversation.ts:50`, `TEMPERATURE_JITTER`, `chooseStrongestBond` default). *Fix:* wire each
  weight to its subsystem or delete the struct. *Test:* changing `variableWeights.initiative`
  changes approach-ordering variance.
- **E54 [MED · Change] ✅ PR #216 (signal + feeds + `bondStrength`) · ✅ PR #224 (the vetoSave + juryLean consumption tail: `chooseVetoSave` ranks the save by demonstrated loyalty, and a centered reliability term weighted by `JURY_WEIGHTS.reliability` shifts the juror's lean) — ADR 0002's `reliability` signal was never built** — trust is pure
  sentiment, never evidence; with E43, demonstrated loyalty has no representation. *Fix:* add
  `reliability` fed by protective votes/honored deals/veto saves; consume in `vetoSave`,
  `bondStrength`, `juryLean`.
- **E55 [MED · Improvement] ✅ PR #216 — Confessionals are one canned template, never reach soul recall.**
  `confessionals.ts:53–55` (identical line all season — also the 0048 unsealing payoff);
  ceremony confessionals fire only at noms; `recordConfessionalToSoul` has zero callers (0040's
  recall half unwired). *Fix:* structured confessionals (trigger/target/mood/surfaced element)
  composed from the beat; record at eviction/veto too; wire soul recording. *Tests:* content
  references its trigger; `soul.recall(npc,"confessional")` post-restore.
- **E56 [MED · Improvement] NPCs never throw or sandbag a competition.**
  `liveSeason.ts:337–340` ("NPCs stay compete for now") — the engine models throw penalties no
  NPC ever uses. *Fix:* derive NPC intent from disposition/strategy-style + state,
  constants-gated (nominees never throw their own veto). *Test:* bounded nonzero NPC throw rate
  respecting gates.
- **E57 [MED · Bug] ✅ PR #215 — "One bounded off-screen tick per turn" actually fires per *mutation*.**
  `registry.ts:183–188` + `orchestrator.ts:219,233–235` — a 4-tool-call turn runs 4 ticks
  (12 hidden scenes, 4 reshuffles, 4 rumors/confessionals), force-marching the house and
  flooding the record. *Fix:* debounce to the turn boundary. *Test:*
  `recordInteraction+diaryRoom+advanceGame` ⇒ exactly one `offscreen-tick`.
- **E58 [MED · Improvement] ✅ PR #213 (varied state-derived house events) · ✅ PR #224 (the day index: `PublicGameStatus.day = dayOfWeek(phase)`, hoh=1…eviction=5, surfaced on `gameStatus`) — The daily-event invariant is satisfied by a verbatim filler event,
  and in-game days don't exist in the live game.** `orchestrator.ts:405–416` ("A house meeting
  shifts the week.", repeated, player-witnessed, pollutes THE RECORD re-entry facts);
  `schedule.ts` has no production callers; no day index on any view. *Fix:* derive day from the
  beat (hoh=1…eviction=5), expose on `gameStatus`; replace filler with a varied, state-derived
  seeded library, ≤1/day. *Test:* no two consecutive house-events share content.
- **E59 [LOW · Change] `relationshipLabel` is a fixed 3-label taxonomy** (`relationships.ts:43–55`)
  vs. ADR 0002's organic vocabulary; `npcVoice` ships a stance for every living pair each call.
  *Fix:* disposition-framed phrase set; top-k stances (pairs with E11).
- **E60 [LOW · Change] ✅ PR #213 (engine ships the `bond | probe` motive) · ✅ PR #224 (FE: the approach chip varies copy + class + tooltip by the motive enum) — `socialInitiatives` ships the exact canned string ADR 0003 names as a
  smell** (`pretext: "wants a word with you"`, `GameSessionAdapter.ts:454`) while discarding the
  computed drive. *Fix:* coarse categorical motive (`bond | probe`), never the number.
- **E61 [LOW · Improvement] Exact ties resolve by array position, not seed** (`liveSeason.ts:400`,
  `:772` — the player is `active[0]` and loses final-eviction ties; `competitionOutcome.ts:91–92`).
  *Fix:* one rng draw on exact ties. *Test:* tie outcomes vary by seed, not slot.
- **E62 [LOW · Bug] An unimplemented twist kind would wedge the pure twist machine**
  (`rollWeek` runs only `double-eviction` but arms any kind, `liveSeason.ts:482,495–496`;
  only the adapter's `IMPLEMENTED_TWISTS` filter saves it); `battle-back` — the documented
  reason the jury tie-break exists — is unimplemented. *Fix:* drop unrunnable pendings in
  `rollWeek` (recorded as never-fired); implement `battle-back` later.
- **E63 [LOW · Improvement] Determinism & constants hygiene cluster.**
  `applyDecision` defaults `new SeededRandom(1)` (`liveSeason.ts:935` — make rng required);
  `beatRng` reuses one stream per (week,beat) across subsystems (namespace by purpose,
  `GameSessionAdapter.ts:778–788`); `diffuseGossip` default `transmitProb=0.8` vs. the tunable
  `0.25` (`gossip.ts:92` vs `:38`); inline magic numbers (`relationships.ts:163`, `jury.ts:42`,
  `conversation.ts:50`, `GOODBYE_MESSAGE_COUNT`, `ALLY_TRUST_FLOOR`) hoisted to constants
  modules + B59 grep gate; legacy `recordVoteAgainstPlayer` folds the wrong direction
  (`consequence.ts:96–100` — retire or fix); production off-screen ids embed wall-clock time
  breaking the orchestrator's own reproducibility contract (`orchestrator.ts:406–408`);
  hard casts to in-memory adapters in the durable path (`registry.ts:148,162,164` — add
  `serialize/restore` to the engine-only ports before the SQLite adapter lands); dead/drifting
  modules (`ConsequenceEngine`/`restoreMemory`, `SaveStore`+`InMemorySaveStore`,
  `LlmNarrativePort` never composed and `setNarrator` typed against the *sync* port so the
  documented seam doesn't type-check, `PlayerSurface.renderScene(fidelity)` unreachable via
  MCP) — delete or annotate.

### Theme 7 — Front-end UI/UX & immersion (beyond the D-batch)

- **E64 [HIGH · UX · ruling] ✅ PR #206 — The status HUD moves into the sidebar, permanently.** Today
  `#orwell-status` is `position:fixed; top:64px; right:14px; z-index:9000`, draggable
  (`orwellStatusPanel.js:21–30, 93–94`) with minimize-to-dock — and it's one of the R2/R4
  colliders. *Ruling:* it is not a window. *Fix spec:* mount the panel as a docked section
  inside `#sidebar` (below the session list), full sidebar width, no drag, no `POS_KEY`, no
  z-index/collision surface; keep the poll/render logic and aria-live announcer untouched; on
  mobile it lives in the existing sidebar drawer (hamburger), removing the C26 park-on-mobile
  special case for this panel. Collapsible within the sidebar is fine; floating is not.
  *Tests:* pytest/browser-smoke assert `#orwell-status` is a descendant of `#sidebar`, never
  `position:fixed`, and the composer/Diary-trigger overlap checks (D2) pass trivially for it.
  *Note:* this shrinks D2's scope to the presence strip + retrospective panel and removes a
  whole colliding window from R4.
- **E65 [HIGH · Bug] ✅ PR #208 — `orwell:gamechanged` has four listeners and zero dispatchers.**
  Listeners at `orwellSocial.js:446`, `orwellStatusPanel.js:357`, `orwellFinale.js:225`,
  `orwellEngineStatus.js:99`; no `dispatchEvent` anywhere — so panels never refresh on a new
  game and dismissed approaches (`localStorage orwell-social-dismissed`, keyed by recurring
  `npc:N` ids) suppress season-2 approaches forever. *Fix:* dispatch from `chat.js`
  `tool_output` on successful `createCharacter`/`manageSandbox`, and from onboarding; test for
  a dispatcher, not just listeners. Pair with the in-chat restart needing a fresh session
  (F7 currently runs only at page load) — on restart success, reuse `takeASeat` so a dead
  season's transcript never rides as narrator context.
- **E66 [MED · UX] ✅ PR #208 — Pending decisions must survive reload** (= **D3**, endorsed) — concretely:
  expose `pending` on `GET /api/orwell/status` (Vault-free legal-options view) and have
  `orwellDecision.js` render from it on load/poll, rather than only the live
  `orwell:pending` event.
- **E67 [MED · UX] ✅ PR #206 — Finale panel parity.** It misses every sibling convention: 5s poll forever
  with no hidden-tab gate or backoff (`orwellFinale.js:19, 218–222`; C18), no mobile
  treatment (`:70–77`; C26/M1), no `role`/`aria-label` and a silent vote reveal (the game's
  most dramatic incremental update; the status HUD's polite announcer is the model). *Fix:*
  slow poll until finale-adjacent phase; sheet/dock-park on ≤768px; `role="complementary"` +
  `aria-live="polite"` reveal announcements.
- **E68 [LOW · Bug] ✅ PR #206 — Status-panel poll backoff never recovers while a game is live**
  (`orwellStatusPanel.js:324–340`; success path never resets `_failures` — HUD degrades to
  2-minute refresh after one blip). *Fix:* reset on success like `orwellSocial.js:408`.
- **E69 [LOW · Bug] ✅ PR #206 — "11st out / 12nd out / 13rd out"** — `orwellStatusPanel.js:298` ordinal
  logic; reachable every endgame. *Fix:* standard ordinal helper (11–13 ⇒ "th").
- **E70 [LOW · Change] ✅ PR #215 — `POST /api/orwell/new-game` bypasses the 0050 casting interview**
  (`orwell_routes.py:205–232` — a soul-shallow character one curl away; no UI consumes it).
  *Fix:* admin-gate or delete in favor of the chat tools (folds into D1's one-door work).
- **E71 [LOW · UX] ✅ PR #206 — Panel client state isn't keyed per user/game** (bare `localStorage` keys —
  dismissals/positions shared across accounts and seasons). *Fix:* suffix with username +
  game/seed id.
- **E72 [LOW · UX] ✅ PR #208 — The composer model picker shows raw model ids to every player under the
  game build** (`index.html:813`). *Fix:* hide `#model-select` for non-admins (per-user default
  model resolution already exists, `settings.py:388–401`).
- **E73 [LOW · Improvement] Deals are write-only from the player's seat** — no read lever
  (`orwell_engine.py:342–344` is `make_deal` only), so the GM cannot *recall* standing deals
  from the store (and must not from chat). *Fix:* a Vault-free `myDeals` read on the player
  channel (terms/status/week only — the player's own deals, no hidden state); chat-voiced, no
  panel (ADR 0003).
- **E74 [LOW · Improvement] Six independent pollers, four fetching `/api/orwell/state`
  separately.** *Fix:* one shared `orwellState.js` poller broadcasting via the existing
  CustomEvent pattern (halves steady-state volume); also satisfies D11's cache-bust-on-new-game.
- **E75 [LOW · UX] Up to ~9.4s of silent serial framing waits when the engine hangs**
  (`chat_helpers.py:66–78`: 3s + retry 0.4+3s + 3s before the LLM streams). *Fix:* early SSE
  keepalive ("checking the feeds…") or shorten the retry budget.
- **E88 [HIGH · UX · ruling] ✅ PR #206 — The Diary Room becomes a persistent sidebar button — no floating
  dialog.** Today the DR is a button inside the social HUD that opens a draggable
  `aria-modal` dialog (`orwellSocial.js:176, 185–186, 236+`). *Ruling:* the entry point is a
  standing sidebar button like chat/theme — always present while a game is active — and the DR
  is not a window. *Fix spec:* move the `📔 Diary Room` trigger into `#sidebar` as a permanent
  nav button; clicking it enters a **Diary Room composer mode** in the chat itself (visible
  in-composer indicator + the existing `POST /api/orwell/diary-room` send path, exit on
  send/escape) — chat-first per ADR 0003, no floating box, no drag handler, no modal focus
  trap to maintain. The social HUD keeps only approaches. *Tests:* browser smoke asserts the
  DR trigger is a `#sidebar` descendant and no `osoc-box` dialog node is created;
  `window._orwellOpenDiaryRoom` seam re-pointed at the composer mode. *Note:* with E64 (status
  HUD) and this, R4's Diary-trigger occlusion becomes unreachable and D2 shrinks to the
  presence strip + retrospective panel.
- **E89 [MED · UX · ruling] ✅ PR #214 (the engine gate) · ✅ PR #224 (the dedicated FE belt: `firstCeremonyResolved` suppresses every chip pre-first-ceremony, holding even if the engine fails open — browser-smoke proven) — NPC approaches must not fire at the very start of the game.**
  `orwellSocial.js` gates only on `st.started` (`:6, :409`), and engine-side `socialInitiatives`
  ranks approaches from move-in — so "___ wants a word with you" can pop before the player has
  had a single unprompted beat in the house. *Ruling:* the approach surface may stay a window,
  but it stays silent at the beginning. *Fix spec:* engine-side gate (preferred, structural):
  `socialInitiatives` returns empty until the first ceremony beat has resolved (e.g. the
  week-1 HOH result is committed) — giving move-in/first-scene space to breathe; FE keeps its
  existing started-gate as the belt. Threshold lives in a constants module, not inline.
  *Test:* a fresh game pre-first-HOH ⇒ `socialInitiatives` empty across seeds; post-HOH ⇒
  approaches resume.
- **E90 [LOW · UX · ruling] ✅ PR #206 — The theme button docks at the sidebar bottom, beside settings,
  icon-only.** The theme entry (opens `#theme-modal`, `index.html:444+`) currently sits in the
  main sidebar nav with a text label. *Fix spec:* move it into the sidebar's bottom cluster
  next to the settings icon as an icon-only button (the existing palette SVG from the modal
  header), `title`/`aria-label="Theme"` for tooltip + a11y — no visible text. Same treatment
  under the game build and the full workspace. *Test:* browser smoke asserts the trigger is in
  the bottom cluster, has an accessible name, and renders no text node.
- **E91 [MED · Bug · ruling] ✅ PR #206 — Floating-panel positions don't survive a refresh.** Each panel
  saves `{left, top}` on drag-end (`orwellStatusPanel.js:188`, `orwellSocial.js:226`) and has a
  `restorePosition` (`:66/:64`) — yet a refresh observably resets windows to wrong-looking,
  pseudo-random placements. Likely causes to verify: restore running before layout settles
  (clamping against a 0-height viewport), saves firing with stale/parked rects (minimized-to-
  dock state writing the dock position), or `ensureUI` re-creating nodes without re-running
  restore on the poll path. *Fix spec:* restore after first layout (rAF), never save while
  parked/minimized, clamp restored positions to the viewport *and* the D2 collision rule, and
  key positions per user+game (E71). For panels the rulings move out of windows (E64 status,
  E88 Diary Room) this becomes moot; it must work for the survivors (social, presence,
  finale, retrospective, "wants a word"). *Test:* browser smoke drags a panel, reloads,
  asserts the rect is restored within tolerance and passes the overlap checks.
- **E92 [MED · UX/Bug] ✅ PR #206 — The chat container is missing bottom padding — the composer touches the
  viewport bottom edge** at any width (user-reported on desktop; `style.css:1931–1946` gives
  `.chat-input-bar` a bottom margin only in `welcome-active` mode, `margin-bottom:30vh`, and
  none in normal chat). *Fix spec:* a small constant bottom inset on the normal state (e.g.
  `padding-bottom: max(10px, env(safe-area-inset-bottom))` on the container or
  `margin-bottom` on `.chat-input-bar`), all viewports; verify the chat-history scroll
  bottom-anchor compensates. *Test:* browser smoke asserts the composer's bounding rect bottom
  sits ≥8px above `window.innerHeight` at 390/820/1440 widths.
- **E93 [MED · Bug] ✅ PR #208 — Message edit/delete controls are active on game turns — the player can
  rewrite recorded history.** The live transcript shows `✎ Edit` / `✕ Delete` actions on both
  player messages and GM narration (`msg-action-btn` footers). The chat transcript is the
  *played record* of events the engine has already recorded and folded; editing or deleting it
  desyncs the visible story from the EventStore (and edit-then-regenerate is a re-roll lever —
  an anti-sycophancy hole at the UI layer; the v1 player's own ruling was "I don't want to
  recreate things after the results were shared. That seems like cheating."). *Fix spec:*
  under the game build, on `game_active` sessions: hide edit/delete/regenerate on all
  messages after game start (keep copy); pre-game OOC sessions unaffected. *Test:* pytest/
  browser smoke asserts no edit/delete affordances render on a started game's transcript.
- **E94 [MED · UX/Bug · ruling] ✅ PR #208 (FE half: first-class paperclip + the framing/attachment coexistence gate) + ✅ PR #214 (the one-line scene framing: the player is SHOWING something to whoever is present) — Image attach: promote it out of the overflow menu and make it
  work in character.** Today "Attach files" is an overflow-menu item behind the `+` button
  (`index.html` `#overflow-attach-btn`) — one icon hidden behind another — and nothing
  guarantees an attached image reaches the model with game framing intact. *Fix spec:* (a) a
  first-class paperclip button directly in the composer row under the game build (the
  drag-and-drop path stays); (b) verify/wire the attachment pipeline on **game turns**: the
  image rides the agent-stream request to a vision-capable model alongside the GM moment
  prompt, with a one-line framing addition (the player is *showing something* to whoever is
  present in the scene — a photo from home, a found object) so the model analyzes it and
  responds **in character for the moment**, and the beat is recorded via `recordInteraction`
  like any scene (the E22 guard applies); (c) graceful in-fiction refusal when the configured
  model has no vision capability ("the feeds can't read that"). *Tests:* pytest asserting a
  game-turn payload with an attachment keeps the GM framing and the attachment; browser smoke
  asserts the composer-level attach button exists under the game build.
- **E95 [MED · UX · ruling] ✅ PR #206 — Relocate the minimized-window dock to the sidebar.** Minimized
  panels currently park as chips at the top of the chatbox; the chip strip doesn't re-center
  when the sidebar toggles or the viewport resizes (stale absolute centering), and the
  placement itself is rejected by ruling. *Fix spec:* dock minimized panels as compact rows in
  a "Windows" cluster at the bottom of `#sidebar` (icon + name, click restores; consistent
  with E64/E88/E90 making the sidebar the game's chrome home); kill the chatbox chip strip;
  the existing `.hidden modal-minimized` pointer-events leak (R2/R4/D2) dies with it. On
  mobile the dock rows live in the sidebar drawer. *Tests:* browser smoke minimizes each
  surviving floating panel and asserts the chip renders inside `#sidebar`, restores on click,
  and no dock element overlaps the composer at any width.
- **E96 [LOW · UX · ruling] ✅ PR #208 — Remove "Save to Documents" from the export menu.** The export
  dropdown (`#export-doc-btn`, `index.html` chat top bar) carries the inherited workspace's
  "Save to Documents" — pointing at a Documents feature the game build doesn't surface.
  *Fix spec:* remove/hide the item under the game build (keep Copy/PDF/Rename); if Documents
  is off in the full build config too, delete the dead handler. *Test:* pytest asserts the
  game-build DOM contains no `#export-doc-btn`.
- **E97 [LOW · UX · ruling] ✅ PR #206 — Windows animate on open, close, and minimize.** Floating panels
  currently appear/disappear instantly (display toggles; only incidental transitions exist).
  *Fix spec:* one shared animation contract for all game panels — open: fade+scale-in from the
  trigger (~150–200ms ease-out); close: the reverse; minimize: a translate+scale toward the
  E95 sidebar dock row (so the motion *teaches* where the window went); honor
  `prefers-reduced-motion: reduce` by disabling all three. Implement once in the shared panel
  scaffolding rather than per-panel CSS. *Test:* browser smoke asserts the panel root carries
  the transition class and that reduced-motion disables it.

### Theme 8 — Tests & gate integrity

- **E76 [MED · Test] Feature 0023's BDD gate tests the quarantined fixture, not the live
  consequence loop.** `consequence_memory.steps.ts:4` imports `ConsequenceEngine`/`restoreMemory`
  (zero production callers); and the "opinion change is invisible" scenario records the shift
  into a throwaway `freshEngine(1)` then sweeps surfaces the shift never touched
  (`:59–72` — cannot fail by construction). Violates remediation principle #7 on the flagship
  feature. *Fix:* re-point the steps at a registry-built sandbox (the
  `live_progression.steps.ts:151–168` restart pattern is reusable); fold through the sandbox's
  own session before sweeping.
- **E77 [MED · Test] ✅ PR #221 — The `no-circular` dep-cruiser rule is enforced nowhere**
  (`tests/support/architecture.ts:43` filters to the Vault rule; `npm test` and CI never run
  `test:arch`). *Fix:* assert all forbidden rules empty, or add the CLI step to CI.
- **E78 [MED · Test] ✅ PR #221 — The "no secrets committed" guard scans almost nothing**
  (`secrets.test.ts:18–23`: `deploy/` + root configs only — not `src/`, not the vendored
  `frontend/`). *Fix:* scan all `git ls-files` minus lockfiles/binaries.
- **E79 [LOW · Test] `transportHardening.test.ts` vacuous/racy spots.** `:42` passes with zero
  assertions when the fetch rejects; `:92` real-timer race on the E10 ordering test. *Fix:*
  assert the disjunction + no side effect; gate on entering `callTool` instead of wall time.
- **E80 [LOW · Test] ✅ PR #218 — `deploy/smoke.sh` refutes are textual and shallow.** `:88` grep-"proves"
  update never deletes data; `:75` stat-leak refute checks only `"physical":`/`"score` (not
  mental/social/trust/affinity/threat). *Fix:* behavioral sentinel-save check; extend the
  refute list. Also promote the round-4 Playwright harness into `frontend/scripts/` as a
  staged-state UI smoke (per PR #200's method note) once D1–D3 land.
- **E81 [LOW · Test] `src/main.ts` env parsing is untested and coverage-excluded**
  (`ORWELL_ENGINE_MULTIUSER` regex, host plumb). *Fix:* extract `parseEngineEnv(env)` into a
  tested module.
- **E82 [LOW · Test] The legacy-name deny-list is literally names-in-a-test**
  (`replayability.steps.ts:12`). Defensible, but convertible: compute the forbidden set from
  `docs/legacy/` at runtime, or assert corpus-membership once E38 lands (which subsumes it).

### Theme 9 — Ops, deploy & supply chain

- **E83 [MED · Ops] ✅ PR #218 — Frontend Python deps are 100% unpinned and reinstalled blind on every
  update** (`requirements.txt`: zero `==`; `orwell-update.sh` runs `pip install -r` each time;
  ADR 0004 claims fastembed is version-pinned — it is not, see E86). *Fix:* `pip-compile`
  lockfile + CI pin-check.
- **E84 [MED · Ops/Security] ✅ PR #218 — `curl | bash`-as-root self-update with no integrity check**
  (update/factory-reset host bridges fetch branch-tip from raw.githubusercontent; nodesource
  pipe; mutable CI action tags). *Fix:* execute the already-checked-out in-container copy after
  a pinned-ref fetch, or verify a published SHA-256; pin action SHAs. *(The new
  `orwell-game-reset.sh` inherits the same bridge pattern by consistency — fix all three
  together.)*
- **E85 [LOW · Ops] ✅ PR #218 — systemd hardening stops early + frontend unit crash-loops without `.env`.**
  Missing `CapabilityBoundingSet=`, `RestrictAddressFamilies`, `SystemCallFilter=@system-service`,
  `ProtectKernel*`, `RestrictSUIDSGID`, `LockPersonality`, `UMask=0077` (test
  `MemoryDenyWriteExecute` carefully — Node JIT); `orwell-frontend.service` needs a default
  `Environment=ORWELL_PORT=8080` since its EnvironmentFile is optional. Add a
  `systemd-analyze security` floor to `orwell-doctor.sh`.

### Theme 10 — Docs, specs & the queue record

- **E86 [HIGH · Drift] ✅ PR #219 (the amend path: ADR 0004 → "Accepted — adapter not yet built" + an honest Implementation-status section; CLAUDE.md/README/spec mirrors stop overclaiming and track the adapter as a deferral; building the fastembed adapter itself — E86(a) — remains its own engine lane) — ADR 0004 is accepted but unimplemented, and CLAUDE.md presents it as
  running.** No `fastembed` in `package.json`; the only adapter is `DeterministicEmbedding`
  (whose comment still says "open decision #4"); no deploy script fetches a model — production
  "semantic" recall (0024/0041) runs on a hash-vector fake, undetectable by the gate because
  the fake is the test adapter. *Fix:* build the fastembed adapter (lazy ONNX load, fallback to
  the deterministic embed, pinned lib+model, deploy-time model fetch) **or** amend ADR 0004 to
  "Accepted — adapter not yet built" and move it to the deferral list. Either way CLAUDE.md
  stops overclaiming.
- **E87 [MED · Drift] ✅ PR #219 (all of a–i: deviations recorded in spec headers/README rows; the queue's contradicting blocks stamped HISTORICAL/RESOLVED; DRAFT headers retired on every shipped `.feature`; the B70 floor + the not-yet-MCP/JSON-RPC caveat recorded; the cucumber.cjs change is the (i) cosmetic only — no path added or removed) — Doc-hygiene sweep (one B57-style PR).** (a) 0036 and 0033 say "add to
  cucumber.cjs when green" and never were — gate them or record the unit-gated deviation;
  (b) 0029's `.feature` needs the honest "validated by frontend pytest" header like 0010's;
  (c) CLAUDE.md wrongly groups 0035 as "unit-gated" (it's BDD-gated) and never mentions 0029;
  (d) the queue's "Still on the feature-maker" block (lines 874–909) and the "Reconciliation
  still owed" note (`:2076–2080`) contradict the drained banner — stamp HISTORICAL or resolve;
  (e) README indexes 0010 as plain "Done" vs. its own spec's "not done until host-validated";
  (f) B70's stated thresholds (90/90/90) vs. actual (90/88/82); (g) 49 of 50 `.feature` files
  still carry "# DRAFT executable spec" headers; (h) CLAUDE.md should parenthesize that the
  "HTTP MCP server" does not yet speak MCP/JSON-RPC; (i) `cucumber.cjs:44–45` ordering/indent
  cosmetics.

---

## Future specs (new features, not audit findings — start as new `NNNN` specs per the rule)

- **0051 (proposed) — In-character image generation.** The model can *produce* images as part
  of play (a houseguest's sketch, the memory-wall portrait, a "camera still" of a scene),
  rendered inline in the chat. Per the 2026-06-10 ruling this is a feature spec, not a defect:
  it needs its own design pass — which moments may generate (player-requested vs.
  producer-beat), how generation stays Vault-free (prompts built only from the player's
  visible state — the E11/E15 discipline applies to image prompts too), seed/style consistency
  per season so the house looks like itself, cost/latency gating, and graceful absence when no
  image-capable model is configured. Natural pairing: E94's attach flow (analyze in, generate
  out) and D9/E64's portrait surfaces (a generated cast portrait set at season start is the
  obvious first deliverable). Write as `docs/features/0051-in-character-images.{md,feature}`.

- **0052 (proposed) — House themes for the theme picker** *(ruling #13, 2026-06-10)*. Five
  built-in themes that carry the game's identity, defined **first** in the `THEMES` preset
  object so they render as the picker's opening row (`theme.js:617–633` renders
  `Object.entries(THEMES)` in insertion order); each is a full token set in the existing
  preset shape (`bg/fg/red/accent/…` — same keys the `orwell-theme` localStorage payload and
  swatch renderer already consume), body text at WCAG AA contrast, no animated textures (any
  scanline/noise effect is static or `prefers-reduced-motion`-gated):
  1. **The Feed** — night-vision surveillance: near-black green-cast background, phosphor-green
     foreground, desaturated mid-grays, a blinking-REC red reserved for `--red`/alerts.
  2. **Telescreen** — Orwell's CRT: deep charcoal with a faint cyan-white glow for text, pale
     blue panel tint, vignette-dark borders; accent the cold cyan of a screen that watches back.
  3. **Room 101** — institutional dread: gray-green walls, fluorescent off-white text,
     danger-red accent, hard borders (minimal radius via existing tokens where supported).
  4. **Memory Wall** — the gallery after an eviction: near-black blue-charcoal, backlit
     portrait-blue accents, warm tungsten highlight for active elements, dimmed gray for
     "evicted" muted text.
  5. **Sequester** — the jury house: low-contrast wine/maroon depths, brass-gold accent,
     velvet-dark panels; cozy with an undertone of waiting.
  **Frosted glass + delightful animation are critical to these themes** *(ruling addendum,
  2026-06-10)*: house themes ship with translucent, backdrop-blurred surfaces — sidebar,
  floating panels, modals, the minimize dock — (`backdrop-filter: blur(…)` + a translucent
  panel token over the theme background) so the house is always faintly visible through the
  chrome, and with delightful micro-motion as part of the theme identity: the E97 open/close/
  minimize animations tuned per-theme (e.g. The Feed's REC dot pulses; Telescreen powers
  panels on with a brief CRT bloom; Memory Wall backlights swatches on hover), plus soft
  eased hovers on swatches and buttons. Constraints: `prefers-reduced-motion` disables motion
  (never the frost); a no-`backdrop-filter` fallback (solid panel at higher opacity) keeps
  low-end/unsupported browsers legible; frost stays off the chat text column itself
  (readability first); contrast measured against the *effective* blurred composite, not the
  raw token.
  Placement/behavior: house themes appear before `dark/original` and all inherited presets;
  the default theme for fresh game-build installs may switch to **The Feed** (decide at
  implementation — record as its own mini-ruling); custom-theme machinery untouched.
  *Tests:* pytest/browser smoke assert the first five `themeGrid` swatches are the house set,
  each applies (body computed background matches token), frosted surfaces carry the
  backdrop-filter (or the fallback class when unsupported), reduced-motion strips the
  animation classes, and a contrast check on fg/bg pairs passes AA. Write as
  `docs/features/0052-house-themes.{md,feature}` (FE pytest-validated, honest 0029-style
  header — not cucumber-gated).

- **0053 — Admin transcript retrieval** *(ruling #14, 2026-06-10: "Admin API + settings entry")*.
  **✅ BUILT 2026-06-11 (Lane C, PR #223) — FE pytest-validated**
  (`frontend/routes/admin_transcript_routes.py` + the admin-only Settings "Transcripts" row in
  `static/index.html` / `static/js/admin.js`; gate `frontend/tests/test_0053_admin_transcripts.py`).
  Debug access to any user's chat transcripts, invisible to players:
  - **API** (all behind the existing `require_admin` middleware, same pattern as
    `admin_wipe_routes.py` / `api_token_routes.py`): `GET /api/admin/transcripts` — list
    sessions across all users (session id, owner, title, created/updated, message count,
    game-session marker), with `?user=` / `?since=` filters and pagination;
    `GET /api/admin/transcripts/{session_id}?format=json|md` — the full transcript export:
    messages with roles/timestamps **plus the agent-thread tool-call nodes (names, args,
    outputs)** — the tool nodes are where the debug value lives (what the GM actually called
    vs. what it narrated).
  - **UI:** one quiet "Transcripts" row inside the already-admin-only section of Settings
    (renders only for admins, nothing in the game chrome): session list with owner filter +
    per-session download. No new nav surface.
  - **Boundaries recorded:** transcripts contain only player-visible content, so there is no
    Vault risk by construction; they DO include the player's Diary-Room entries (player-level
    OOC — an accepted operator capability for a self-hosted box; note it in the admin UI
    copy). Retrieval is read-only — no edit/delete (E93's no-rewriting rule applies to admins
    too). Transcripts survive the game reset (by design) and die with the factory reset.
  - *Tests:* pytest — non-admin GET ⇒ 403/404; admin list + export shape (incl. tool nodes);
    the settings row absent for non-admin DOM. Write as
    `docs/features/0053-admin-transcripts.{md,feature}` (FE pytest-validated, 0029-style
    header).

## Deferral specs (unchanged status, now concretely scoped)

- **0022 MVP-2:** parked correctly; its §4/§8 "player read" cards violate ADR 0002's
  human-driven-reads ruling and must be redesigned (facts-known + observable behavior) before
  un-parking. Most of its plumbing (roster C21, recap C17, decision cards C20) already shipped.
- **0010 Proxmox host smoke:** run `deploy/orwell.sh` on a real host; verify
  install→play→update→data-survival; record it; fix the README status row.
- **Relational adapters:** `better-sqlite3` `SaveStore` + `sqlite-vec` `VectorIndex` behind the
  existing ports; the 0007 property suites are reusable as-is; E63's port-capability fix
  (`serialize/restore` on the engine-only interfaces) is the prerequisite.
- **Full MCP/JSON-RPC:** a JSON-RPC 2.0 envelope (`initialize`/`tools/list`/`tools/call` + SSE)
  over the existing `McpServer.toolsFor(channel)` allowlists, preserving B34/B60/B67; then point
  the FE's real MCP machinery at it.

## What verified sound (keep-list)

Eligibility/legality pure and temperature-proof; 16/9/2 math consistent everywhere; the
Houseguest's-Choice draw incl. player-defers; intent immutability; ~72% favorite calibration;
the endgame ladder topology (F4 sole vote, F3 final eviction); the staged finale (18 Q&A) and
ordered reveals (no pre-reveal winner anywhere); the 0048 unsealing genuinely code-gated on
terminal state; the casting card crossing tier words only; witness/hidden store-invariant;
no player protection anywhere in the engine; the live sentinel sweep's self-auditing coverage
assertion; the exchangeability fairness test on the production loop; B36/B47/B53/B56/B64/B73
status prose matching code; the amendments table fully implemented; zero undefined BDD steps;
the factory-reset script's three-generation path resolution (now shared by the game-reset
script); FE XSS discipline (`textContent`/`esc()`/fixpoint sanitizer) and the
browser-never-reaches-engine guarantee (B66 + loopback bind).

---

# Round 6 — the deep-seam streams (same day)

Five further streams over the seams round 5 read past: the **GM prompt content** itself (P),
the **inherited-workspace attack surface** under the game build (W), the **pure domain core +
soul pipeline** (C — two findings confirmed by executing the real modules), a **full
test-quality sweep** (T — every BDD step file classified production-path vs. fixture), and a
**live runtime & performance audit** (R — the real engine built, booted, and driven through
three full seasons over HTTP, with measurements). Native stream numbering is kept for
traceability; E-batch cross-references inline.

## Round-6 headlines

1. **Two execution-confirmed knowledge-fabrication channels on the player-facing allowlist**
   (C2/C3): `told-by:<npc>` anchors any invented content if the teller knows *anything about
   the same subject*, and `overheard:<id>` anchors any content against any unrelated event id
   (C3 confirms E9 live). The narrator model can mint fabricated full-confidence player
   knowledge with a clean provenance trail.
2. **A hard eligibility rule breaks in normal play** (C1, execution-confirmed): the player
   deferring Houseguest's Choice gets a candidate list snapshotted mid-draw; picking an
   already-drawn name yields a 6-slot veto field with a duplicate competitor.
3. **The model can drive the player out of the game** (W1): `ui_control` in the game-build
   keep-set honors `set_mode`, `switch_model`, and `toggle incognito` with no game-build guard
   — a prompt-injected NPC line can strip the GM framing mid-scene.
4. **Several flagship promises are guarded by tests that cannot fail** (T1/T2/T7/T13): vote
   secrecy's Then is a tautology; live deal reconciliation has zero coverage; the 0019 gate
   asserts a world slot nothing writes; the UAT never asserts its own header claims.
5. **The re-entry beat is engine-complete but never requested** (P2): a fresh context
   mid-season gets no recorded history — the direct ADR-0003 §6 violation — and the B61
   finality-language line marked DONE never landed (P1).
6. **E33 is corrected by live play** (R11): with an active compete-and-save-self policy the
   player reached jury (seed 2002) and Final 2 (seed 1001). E33 downgrades from "the player
   never reaches the jury" to "pre-jury eviction is near-certain under passive play" — D4
   becomes a calibration-and-gate task, not a broken-ladder fix.
7. **The engine scales O(n²) per season** (R3): per-call latency grows ~20× week 1 → week 14
   (6ms → 118ms) from ~4 full snapshot serializations per mutation; sandboxes are never
   evicted from memory (R4); the per-mutation off-screen tick is confirmed at 4 ticks / 22
   events / 8 save versions for 4 calls in 28ms (R5 = E57 measured).

## Stream P — GM prompt & narrative context (P1–P11)

- **P1 [HIGH · Bug]** ✅ PR #213 — The B61 "finality language" line never landed though B61 is ✅ in the
  queue (`IMPLEMENTATION_QUEUE.md:1755–1758`): nothing in `momentPrompts.ts` or
  `agent_loop.py` forbids voicing unresolved outcomes as settled ("X is going home") — the
  exact v1 §3.9 failure. *Fix:* one line in `BASE_GAME_MASTER_PROMPT` after AUTHORITY
  ("unresolved outcomes are READS… never results until the engine resolves and reveals") +
  a `leverManifest.test.ts` regex pin.
- **P2 [HIGH · Bug] ✅ PR #214 —** The re-entry moment is never requested: `storyFacts`/THE RECORD attach
  only to `re-entry`/`post-season` (`GameSessionAdapter.ts:1104–1105`), `view.moment` can
  never *be* `re-entry` (`:1195–1197`), and the FE always passes the phase moment
  (`chat_helpers.py:135,156`). A player resuming in a fresh session mid-season gets zero
  recorded history (ADR 0003 §6). C22's DONE note verified only the premiere slice. *Fix:*
  FE requests `re-entry` on the first game turn of a (re)opened session; pytest pins the
  requested moment.
- **P3 [HIGH · Change] ✅ PR #214 —** Casting-interview turns stack the producer persona ("never a generic
  assistant", `momentPrompts.ts:115–116`) on top of the full generic-assistant preamble +
  rulebook + skills index, because substitution keys on `game_active` (false pre-game)
  (`chat_routes.py:1142`, `agent_loop.py:86–135, 911`) — and `test_c14_immersion.py:56–59`
  pins the violation in place. *Fix:* key substitution on a `framed` flag from
  `apply_game_framing`; small casting-mode tool contract.
- **P4 [MED · Change]** ✅ PR #213 — The fourth-wall gap is prompt-compliant: nothing says levers are
  silent, and the generic `ask_user` description ("get a decision or clarification…",
  `tool_schemas.py:454`) invites "Record this interaction?". *Fix:* "levers are silent
  production machinery — never ask permission to use one; ask_user is ONLY for pending
  binding decisions" engine- and FE-side, both pinned.
- **P5 [MED · Improvement]** THE RECORD's blind `slice(-8)` degenerates exactly when re-entry
  matters: at the finale all eight slots are near-identical vote lines (measured). *Fix:*
  per-type fact selection (latest ceremony beat per kind + recent social/deal events).
- **P6 [MED · Bug]** ✅ PR #213 — `runCompetition`'s BASE manifest bullet says "resolve… you announce ONLY
  the winner" (`momentPrompts.ts:66–67`); the preview semantics live only in the HOH fragment
  — on other turns the model can announce a never-committed winner. *Fix:* reword BASE + FE
  schema to "previews… resolves only via advanceGame"; manifest test pin.
- **P7 [MED · Bug] ✅ PR #214 —** Incognito strips all game framing while the in-character transcript rides
  along — ungrounded, consequence-free continuation (mechanism behind E24). *Fix:* disable
  under the game build or substitute a FEED_DOWN-style non-narration frame.
- **P8 [LOW] ✅ PR #214 —** ~100 wasted tokens per game turn: double datetime header + the untrusted-content
  policy referencing memories/skills the game build disables (ADR 0003 §1).
- **P9 [LOW]** ✅ PR #213 — The casting-sheet *field* manifest isn't drift-pinned against
  `CASTING_COVERAGE` (the archetype table is; the nine field names aren't).
- **P10 [LOW]** ✅ PR #213 — `submitDecision`'s manifest line enumerates 4 of 11 pending kinds — say
  "answer the engine's pending decision (its kind + legal options)" instead.
- **P11 [LOW]** ✅ PR #213 — Two quoted example lines flirt with scripts-to-recite (`momentPrompts.ts:40–42,
  147–148`) — cut to descriptions.
- *Held up:* every woven block Vault-free under sentinels; lever manifest drift-pinned both
  directions; casting sheet generated + dually pinned; `npcVoice` genuinely knowledge-scoped
  with byte-stable personas; C14 substitution clean on started-game turns; fail-states honest;
  prompt flat at ~8–9 KB all season (P-measured and independently R10-measured).

## Stream W — inherited-workspace bleed & attack surface (W1–W8)

- **W1 [HIGH · Security] ✅ PR #211 —** `ui_control` is in `GAME_TOOL_KEEP` (`agent_tools.py:112`) and
  honors `set_mode`, `switch_model`, `set_theme`, `toggle <web|bash|rag|research|incognito|…>`,
  `open_panel` (`ai_interaction.py:1314–1515`) with no game-build guard (`chatStream.js:46–141`)
  — the model (or a prompt-injected houseguest line) can flip the player to Chat mode, swap
  the narrating LLM mid-scene, or toggle incognito (which strips all framing — P7/E24).
  *Fix:* game-build allowlist of safe actions (highlight only); reject
  mode/model/incognito/panel actions on game turns; pytest + JS guards.
- **W2 [MED · Security] ✅ PR #214 —** `GET /api/chat/events/{session_id}` is the only session endpoint
  missing `_verify_session_owner` (`chat_routes.py:1297–1303` vs `:1311+`) — any
  authenticated user can subscribe to another user's activity stream (metadata side-channel +
  unbounded subscriber slot). *Fix:* one line, same guard as `chat_resume`.
- **W3 [MED · Change] ✅ PR #211 —** The Bitwarden vault vertical mounts unconditionally
  (`app.py:739–740`, not in `GAME_DROP_SET`) — an admin-gated, password-handling,
  subprocess-spawning surface (`vault_routes.py:157–226`, env-inheriting `_run_bw`) the game
  build claims to remove. *Fix:* `mount_optional` + add to the drop set.
- **W4 [MED · Change] ✅ PR #211 —** Zero game-build gating on ~40 inherited slash commands: `/sh` (shell
  exec), `/toggle bash|web|research`, `/setup <provider> <api-key>`, `/email /gallery
  /cookbook /notes /memory /rag`, the `/tour-*` set (`slashCommands.js:5464–5842, 5960–6023`)
  — a parallel ungated UI into every dropped vertical. *Fix:* dispatch-time keep-set under the
  game build with a game-framed "not available" reply.
- **W5 [MED · Change] ✅ PR #211 —** The `ui_control` prompt manifest teaches the model to open
  email/gallery/cookbook/documents panels on game turns (`agent_loop.py:154–157, 368`) —
  lever-manifest bleed through a kept tool; calls silently no-op (narrated-but-dead). *Fix:*
  game-only `ui_control` description (pairs with W1's allowlist).
- **W6 [LOW · UX]** Beat-map omissions confirmed for `whereabouts`/`seasonRecap`/
  `seasonRetrospective`/`npcVoice` + `ui_control` renders an expandable raw-JSON node
  (extends E11/D5 with the kept-meta-tool case; the proving test should iterate
  `GAME_TOOL_KEEP`).
- **W7 [LOW · Security] ✅ PR #211 —** `/backgrounds` — a dev prototype page shipping in the game build
  (`app.py:787–790`). Gate or remove. *(Removed: its `static/backgrounds.html` was never
  vendored, so the route only 500'd — deleted outright, 404 in both builds.)*
- **W8 [LOW · Change]** The CSP still allowlists `cdn.jsdelivr.net` for script/style/font
  (`core/middleware.py:143–153`) — the policy half of D6 (vendor/drop KaTeX+Mermaid): drop
  the origin from the game-build CSP too.
- *Held up:* auth lifecycle (rate-limited login/signup, bcrypt'd bearer tokens), MCP admin
  routes, B66 (no browser→engine path; no arbitrary-tool passthrough), `/api/orwell/*` auth
  coverage, workspace browse, gallery ownership, fail-closed optional-tool computation,
  markdown/tool-output XSS discipline.

## Stream C — pure domain core + souls (C1–C17; C1–C3 execution-confirmed)

- **C1 [HIGH · Bug · confirmed] ✅ PR #217 —** Houseguest's-Choice deferral hands the player a stale
  candidate list: candidates snapshot mid-draw (`eligibility.ts:91–101`) while later pullers
  keep drawing; resume validates only membership in the stale list
  (`liveSeason.ts:976–978`) and appends blindly. Confirmed: field
  `[player, n1, n2, p1, p5, p1]` — six slots, five distinct, a duplicate competitor in the
  recorded beat and persisted `vetoField`. *Fix:* re-derive legality at resume
  (`candidates − vetoField`), reject already-drawn picks, snapshot deferred candidates after
  the full draw. *Test:* property over seeds × house sizes 5–16 + a live submit loop
  asserting no duplicates and correct field size.
- **C2 [HIGH · Bug · confirmed] ✅ PR #212 —** `pathwayAnchored`'s `told-by:` check passes on
  subject-match alone (`k.content === fact.content || k.subject === fact.subject`) —
  seeding an NPC with "npc:9 likes to cook breakfast" anchors the invented "npc:9 has a
  final-two deal against you and is throwing comps" as real player knowledge. On the
  player-channel allowlist. *Fix:* anchor on content lineage (`factId`/fuzzy content match);
  subject-only ⇒ suspicion with capped confidence. (Sister of E9; both close together.)
- **C3 [HIGH · confirmed] ✅ PR #212 —** E9's `overheard:` hole verified by execution ("totally fabricated
  secret" surfaced as knowledge against an unrelated event id). The legitimate engine caller
  always passes a strict content fragment — make the anchor require it.
- **C4 [MED · Bug]** ✅ PR #221 — `isSuperset` compares identity only (`saveState.ts:84–103`): events by id
  (content/witness truncation passes), knowledge by id, `emotionalHistory`/
  `relationshipBeliefs` by length, `characters` never compared, and `toGameState` drops
  suspicions + the Vault entirely — the fail-closed 0031 checkpoint cannot see whole classes
  of degradation. *Fix:* field-equality on shared ids, prefix-compare histories, byte-compare
  characters, add suspicion/vault terms to `counts()`. *Test:* property — any single
  mutated/dropped persisted item ⇒ `degradation` fault.
- **C5 [MED · Bug]** ✅ PR #221 — NaN handling: a NaN stat makes `resolveCompetition` silently crown
  `competitors[0]` (`competitionOutcome.ts:79–92`); empty field throws TypeError; `serialize`
  silently converts NaN → null ("lossless" becomes a type lie). *Fix:* finiteness asserts +
  empty-field throw; fast-check property.
- **C6 [MED · Bug] ✅ PR #217 —** A missing/typo'd archetype silently grants the player **comp-beast**
  stats — `SPEC_OF.get(...) || ARCHETYPES[0]` (`characterFactory.ts:314`), and the
  archetype/style steps aren't part of the casting `ready` gate, so early finalization is
  normal. Anti-sycophancy via fallback. *Fix:* default to a median spec (floater), surface
  "defaulted" on the casting card. *Test:* default-stats ≠ global max.
- **C7 [MED] ✅ PR #217 —** Same-name ⇒ identical season confirmed at the domain layer incl. hidden
  elements + twist schedule (= E39/D8; adds the spoiler-integrity angle: a restarting player
  replays a season whose secrets they know).
- **C8 [MED · Bug]** ✅ PR #213 (caps + echo neutralization) · ✅ PR #224 (the overwrite flag: `updateCasting` surfaces `overwrote: [...]` so the producer confirms a scalar replacement rather than silently clobbering) — Casting intake: no length caps, exact-string note dedupe only, scalars
  silently overwritable by any later `updateCasting`, and every captured value is echoed
  verbatim (JSON.stringify) into the system prompt (`castingIntake.ts:40–52`,
  `momentPrompts.ts:246–251`) — an unbounded, durable prompt-injection surface. *Fix:* caps
  (e.g. 500 chars/scalar, bounded notes), neutralize structure when echoing, overwrite flag.
- **C9 [MED-LOW] ✅ PR #216** — Hidden elements can contradict each other (multiple `secret-motive`s) and
  the character's stats ("hidden endurance machine" on a 0.45-physical floater — unbackable
  flavor; "sharper at puzzles" on a public mastermind — not concealed). *Fix:* one
  secret-motive max; gate `concealed-aptitude` on actual stat ≥ threshold with a non-matching
  public archetype (or grant a small hidden bonus so it's mechanically true). Property test.
- **C10 [LOW]** Diary-room privacy is one engine filter, not "impossible by data" as
  `house.ts:21–23` claims — `HOUSE_ADJACENCY` adjoins it to the living room; only
  `assignRooms`' exclusion protects it. Latent until a player-move lever lands (which ADR
  0003 promises). *Fix:* remove the adjacency or hard-exclude in `rollOverhears` + test.
- **C11 [LOW]** `tallyJury` evaluates `votesFor(j)` up to 3× per juror and silently drops
  votes for non-finalists (`season.ts:127,131`) — latent (live caller precomputes). *Fix:*
  evaluate once, throw on non-finalist.
- **C12 [LOW] ✅ PR #216** — `recordConfessionalToSoul` has no production caller — 0040's
  "live soul-recall" half is unwired: confessional content never reaches `SoulStore`, an NPC
  can't recall their own past confessionals. *Fix:* call it at both live record sites,
  mirrored into `hg.soul.memory` (see C13).
- **C13 [LOW]** Soul durability is an implicit contract: `SoulStore` is memory-only; restart
  fidelity exists solely because every current writer mirrors into `hg.soul.memory` and
  `rebuildSoulIndex` replays it — any future direct `recordToSoul` writer is silently lost on
  restart and invisible to the checkpoint (C4). *Fix:* make the durable mirror the API
  (`deepenSoul(id, note)`); property test through public seams.
- **C14 [LOW] ✅ PR #212 —** Knowledge `confidence` never clamped to [0,1] at the MCP seam — confidence 50
  or −3 persists and feeds prompts. `clamp01` at `pushKnown`.
- **C15 [LOW]** `vetoParticipants` doesn't validate the `choose` callback's return (could
  insert the HOH/a nominee/a duplicate); `chooseStrongestBond([])` returns `undefined`.
  Throw on both.
- **C16 [Info]** `emotionalModifier` (`temperatureConstants.ts:79–87`) applies mean reversion
  on every call (not "when things calm" as documented), never reaches the documented [0,1]
  extremes — and is dead in production (parallel formula to `evolveEmotion`; retuning one
  won't move the other; adjacent to E52).
- **C17 [Info]** Vault/Journal co-versioning is vestigial at runtime: `toGameState` hardcodes
  both versions to 1; only the unused `InMemorySaveStore` bumps them. Assert equality in the
  checkpoint or remove the fields.
- *Held up:* the witness/hidden store invariant is exhaustive; adjacency symmetric/connected;
  veto-field degrade at F5/F4/F3 correct; no matchup ever deterministic (stat gap < max
  swing); gossip/relationship math bounded and asymmetric with sane decay; jury math and the
  18-pair Q&A correct; vector recall genuinely content-ranked; casting resume exact.

## Stream T — test-quality sweep (T1–T20)

Production-vs-fixture: 17 step files drive the LIVE registry/adapter spine (strong); the
pure-core features legitimately test the pure core; the gaps are where a live promise is
proven only on a fixture:

- **T1 [HIGH · Fixture-gap] ✅ PR #216** (`tests/integration/liveDealReconciliation.test.ts`) — Live deal reconciliation has zero coverage — the 0039 BDD steps
  assert their own stubs (`deal_tracking.steps.ts:17–30, 122–127`); `reconcileDeals`,
  `bindingActionFor`, jury demerits, and the reveal event are untested on the production
  path. (The missing gate for E42/E43.) Full live-test spec recorded.
- **T2 [HIGH · Vacuous] ✅ PR #217 —** Vote secrecy's Then is `x ≤ max(xs)` — true by definition
  (`eviction_night.steps.ts:91–101`); the "no pre-reveal tally/unread vote" Then guards
  itself behind an `if` that can skip all assertions. Replacement: electorate-derived bounds
  + mid-stage surface sweeps. (The engine-side twin of E12.)
- **T3/T4 [MED] ✅ PR #225** `assert.ok(recalled.length >= 0)` (offscreen recall) and
  `assert.ok(true)` (CHARACTER-unchanged) — direct replacements specced. *Shipped:* T3 asserts
  recall RETURNS the specific recorded off-screen note; T4 captures a real generated houseguest's
  static Character bytes at premiere and asserts byte-stability across a season of soul-deepening.
  Both mutation-verified.
- **T5/T6 [MED] ✅ PR #225** "Narration can't change outcomes" proven against a pure local
  function called twice; "narrator cannot advance the game" proven against a hand-built constant —
  both re-pointed at live sandboxes (the house-presence lingering steps are the pattern).
  *Shipped:* T5 → a live `GameSessionAdapter` competition + hallucinating narrator (winner re-runs
  identical, whole live state byte-identical); T6 → a live season at its real nomination beat
  (live phase + pending unmoved by building the narrator prompt). Both mutation-verified.
- **T7 [MED] ✅ PR #225** The 0019 agent-play-loop gate asserts world slots nothing writes, accepts
  any winner (`typeof winner.name === "string"`), and its fixture omits the relationship model —
  the fold it "verifies" is impossible there. Re-point at the live seam (B55 pattern). *Shipped:*
  the engine winner is a real roster member that re-runs identical, and recording the result FOLDS
  a real hidden consequence with a relationship model wired in. Mutation-verified (disable the fold
  ⇒ red).
- **T8 [MED]** Reserve-twist scenarios pre-filter to exactly-one-fired seeds then assert
  ≤1 fired; the witnessed-reveal step records the event itself then asserts it. Un-filtered
  seed loops + a second live twist-kind trace specced.
- **T9 [MED]** Emergent-bloc steps re-write bloc edges to 0.95 every tick (overwriting live
  folds) and never compute the "more than chance" baseline; the temporal "sooner" claim is a
  single static call. Matched-seed lift test specced.
- **T10 [LOW] ✅ PR #225** `readsVault === false` asserts a literal type — decorative (dep-cruiser
  is the real proof). *Shipped (with PR #221's step hardening):* the decorative assert now carries
  a comment pointing at the dependency-cruiser proof AND a live-server behavioral assertion (the
  channel serves exactly its static allowlist by name). Verified + stamped.
- **T11 [MED] ✅ PR #225** Off-screen isolation Thens prove disjoint id-sets that are disjoint by
  construction (no content/knowledge cross-leak check); the per-wake cap hides a ×10 fudge;
  one Then ends `assert.ok(true)`. *Shipped:* the per-wake cap now asserts the TICK COUNT via an
  `advance` spy (the ×10 fudge is gone); the isolation Thens plant unique per-user sentinels and
  assert genuine content/knowledge cross-absence (record + knowledge + player surface); the
  `assert.ok(true)` watcher-stop step now asserts no-dangling-timer + idempotent stop. Cap and
  isolation both mutation-verified.
- **T12 [MED]** Live-progression determinism asserts only final week/phase after 60 advances
  — two diverged games typically still agree; compare full event trails (the
  strategic_decisions pattern).
- **T13 [MED]** The UAT's header claims are unasserted (no player-role coverage, no survival
  distribution — the vacuous claimer for E33), no restart leg, no pending double-advance
  check, the eviction reveal isn't in its result type, leak checks are shape-regexes with no
  sentinel, and "over the deployed HTTP transport" is true for 1 of 3 legs.
- **T14 [MED · Missing-gate] ✅ PR #215 —** The B71 restart→offscreen-tick duplicate-id kill (found live by
  a smoke) has no regression test — no test restores a save into a fresh registry and ticks.
  Spec: save mid-game → new registry on same dir → 5 ticks → integrity ok + unique ids.
- **T15 [MED]** The deal-rumor pathway Then surfaces canned fixture gossip unrelated to the
  broken deal and asserts `length > 0`.
- **T16/T17 [LOW]** Duplicate byte-identical sweeps in god_mode/moment_orchestration; the
  orchestrator "same clock ticks" When is an empty step.
- **T18 [LOW]** fast-check is used in 1 of 11 "property" files; the fixed-seed loops are
  mostly adequate — fix the lane description (CLAUDE.md overstates).
- **T19 [MED · FE] ✅ PR #225** `test_c12_finale_relay.py` hand-mirrors the engine decision kinds —
  the exact drift class C12 exists to kill; parse them from `GameSession.ts` like c13 does.
  *Shipped (with PR #221):* the FE decision-kind list is parsed live from `src/ports/GameSession.ts`
  via `_engine_decision_kinds()` (the c13 cross-language manifest-parser pattern) with a sanity
  floor + duplicate guard. Verified + stamped.
- **T20 [MED · FE] ✅ PR #225** Source-grep tests (`"modalManager.register(" in src`) counted as
  behavior coverage. *Shipped:* `scripts/browser_smoke.py` gains a real social-HUD minimize-to-dock
  BEHAVIOR check (minimize hides the panel + parks a dock chip; restoring from the chip re-opens
  it); `tests/test_orwell_huds.py` source-greps are explicitly re-labeled as SOURCE-PINS
  (`test_sourcepin_*`, docstring + per-test pointers to the browser-smoke behavior coverage) so
  they read as wiring-present pins, not behavior coverage. *(The broader untested-FE-behaviors set
  — identity propagation / `user=` deletion etc. — belongs to the FE waves, not this T-item.)*
- *Patterns to preserve:* liveSentinel's self-auditing sweep, liveFairness' exchangeability
  band, jury_choreography's manner-share A/B, the B53 live twist trace, house_presence's
  per-tick invariants, the c13 cross-language manifest parser, the UAT's anomaly-model design.

## Stream R — live runtime & performance (R1–R12, measured on the real engine)

- **R1/R2 [HIGH · Confirmed-live] ✅ PR #215 —** E1 reproduced end-to-end: reset → new game → `integrity
  fault kinds=degradation` → the old game zombie-resurrects; reset never scrubs disk, so
  process restart resurrects the pre-reset season too. (Durable resume itself: verified-pass
  — season 2 resumed exactly at week 14/finale.) Fix spec confirmed: `Orchestrator.forgetUser`
  + save-dir rotation on reset.
- **R3 [MED · Perf] ✅ PR #215 —** Per-call latency grows ~20× over a season (6.1ms wk1 → 118.5ms wk14,
  identical curve across seeds): every mutation runs ~4 full O(events) snapshot
  serializations + 2 save versions (`orchestrator.ts:204–236`) — O(n²) per season (~460KB
  snapshots at endgame). *Fix:* reuse the just-exported snapshot between checkpoint/save/tick;
  incremental counts.
- **R4 [MED · Perf] ✅ PR #215 —** No idle-sandbox eviction, ever (`registry.ts:169`): +1.6MB RSS per
  sandbox, permanent (60MB boot → 123MB after 3 seasons; ~250–450MB at 100 users). Sandboxes
  provably rebuild from disk — add an idle LRU unload using the existing touch timestamps.
- **R5 [Confirmed-live] ✅ PR #215 (with E57) —** E57 measured: 4 `recordInteraction` calls in 28ms ⇒ 4 ticks, 22 new
  events (16 hidden), 8 save versions — 4.5× amplification per mutation.
- **R6 [Confirmed-live]** E31/D10 exact behavior: malformed `recordInteraction`/
  `resolveCompetition` ⇒ 500 "internal error"; everything else clean 400/404/413; **no path
  or stack leakage anywhere** (verified-pass). Bonus: a string `witnessSet` is iterated
  char-by-char ("non-living houseguest: p").
- **R7 [LOW · Perf]** Single Node thread: cross-user requests serialize (135 req/s early-game
  ⇒ ~8 req/s when any user is at endgame per R3). Capacity-planning note.
- **R8/R9/R10 [Verified-pass]** Same-user concurrency serializes with zero corruption;
  pruning works exactly per policy (3.2–3.5MB/user retained, ~350MB @ 100 users; transient
  write amplification ~120MB/season — R3's fix shrinks it); moment prompt flat 7.8–9.2KB all
  season.
- **R11 [Correction to E33]** Player reached **Final 2** (seed 1001: statement + 6 jury
  answers) and **jury** (seed 2002) under a trivial active policy; pre-jury eviction only on
  seed 33333. All terminal states reachable; E33/D4 is recalibrated as "passive play is
  near-certain pre-jury eviction" — keep the property gate, reframe the target.
- **R12 [Verified-pass]** The finale/retrospective seam: recap contains no hidden content;
  the retrospective unseals only post-finish (null at week 2); no relationship-number keys in
  any player-facing payload; `finaleView` null outside staging.

## Round-6 amendments to the E-batch & wave order

- **E33/D4 reframed** per R11 (calibration + property gate, not a broken ladder).
- **E9 closes together with C2/C3** (two anchoring loopholes, one fix site:
  `pathwayAnchored`).
- **E31/D10 closes with R6's exact repro list** + the McpServer shape-validation spec.
- **Wave 1 (E-CRIT)** gains C1 (veto-field duplicate) and adopts R1's confirmed fix shape.
- **Wave 2 (E-SEC)** gains W1, W2, C2/C3, C8 (intake injection), C14; W3–W5 join the
  game-build trim work.
- **Wave 3 (E-SOCIAL)** gains C6, C9, C12 (and T1's live deal gate ships *with* E42/E43 as
  its proof).
- **Wave 4 (E-PLAYER)** gains P1, P2, P3, P4 (the prompt-integrity set) and P5–P7.
- **Wave 5** gains the T-batch test repairs (T2 ships with E12's vote-secrecy change), R3/R4
  perf work, C4/C5 checkpoint hardening, and the P8–P11/W6–W8/C10–C17 polish.

## Parallel execution plan (multi-agent)

The findings parallelize well, but the limit is **file contention and a handful of semantic
dependencies — not finding count**. Run each lane as a worktree-isolated agent with exclusive
ownership of its hot files; merge lanes in the integration order given below. With the roster
as drawn, **11–13 lanes can run concurrently from day one**.

**Priority (ruling #15): the UI enhancements track dispatches first.** The track is
**Lane 9 (chrome & windows)** — the sidebar status HUD (E64), sidebar Diary Room (E88), the
sidebar minimize dock (E95), icon-only theme button (E90), position persistence (E91), window
animations (E97), bottom padding (E92), finale-panel parity (E67), the panel polish set
(E68–E71), the D2 collision rule, and the 0052 house themes with their frosted/animated
identity — plus **Lane 7 (transcript surface)**: diegetic beat labels (D5/W6/E11-FE), no
edit/delete on the played record (E93), decision-card boot re-arm (D3/E66), the dead
`orwell:gamechanged` dispatcher (E65), and the first-class in-character image attach (E94).
The UI-visible game-build trims (E72 model picker, E96 Save-to-Documents, D7 holding copy +
mode toggle, D9 portraits, D6 CDN vendoring) ride with this track from Lane 8. Staff these
lanes first and fullest; they contend with no engine files, so **Lane 1 (the restart spine)
runs concurrently at full speed** — prioritizing UI costs the CRIT engine work nothing.
Within the track, Lane 9's internal sequence below still governs; Lane 7 and the Lane 8 trims
are unordered with respect to it.

### The contention map (one owner per hot file — never two agents in these)

| Hot file | Findings that touch it | Owner lane |
|---|---|---|
| `src/composition/orchestrator.ts` + `registry.ts` | E1–E3, E6, E7, E57/R5, R3, R4, E2, T14's fixture | **Lane 1** |
| `src/adapters/engine/GameSessionAdapter.ts` | E4, E21, E34, E42/E43 folds, E49, C6, C12, E39/C7, npcVoice gating (E11) | **Lanes 1, 3, 4 — split by function, sequenced at merge** (Lane 1 owns commit/restart paths; Lane 3 owns fold/deal/confessional methods; Lane 4 owns createCharacter/views) |
| `src/engine/liveSeason.ts` | E34, E35, E36, E12, E51, C1, E62 | **Lane 4** |
| `src/adapters/inmemory/InMemoryKnowledgeService.ts` | E9, C2, C3, C14 | **Lane 2** |
| `src/engine/momentPrompts.ts` | P1, P4, P6, P9–P11, C8's echo fix | **Lane 5** |
| `frontend/routes/chat_helpers.py` + `src/agent_loop.py` | P2, P3, P7, P8, E16, E22, E23, E24 | **Lane 6** |
| `frontend/static/js/chat.js` | E65, E93, D5/W6/E11 labels, E94's composer hook | **Lane 7** |
| `frontend/src/settings.py` + `agent_tools.py` + `slashCommands.js` | W1, W3, W4, W5, E17, E72, E96 | **Lane 8** |
| Sidebar/panel JS + CSS (`orwell*.js`, `style.css`, `index.html`) | E64, E88, E89(FE), E90, E91, E95, E97, E92, E67–E71, D2, 0052 | **Lane 9** |
| `deploy/*` + systemd + CI | E83–E85, E80, E32's installer bits | **Lane 10** |
| Docs (`CLAUDE.md`, queue, features, ADRs) | E86(b), E87, T18, status amendments | **Lane 11** |

### The lanes (start all concurrently except where noted)

- **Lane 1 — Restart & spine (CRIT, engine):** E1+D1+R1 (orchestrator `forgetUser`, one
  restart door, 4xx on fault), E2 (pre-game tick gate), E3 (commit result propagation), E6,
  E7, then E57/R5 (tick debounce) and R3/R4 (snapshot reuse + LRU eviction) in the same lane —
  they all live in the same two files. *Blocks: the D4/E33 re-measurement (Lane 13) and T14's
  restart regression test.*
- **Lane 2 — Knowledge integrity (engine, small):** E9+C2+C3 (one function), C14, E20, E21.
  No overlap with Lane 1.
- **Lane 3 — Social-sim consequence (engine):** E42–E48, E50–E55, C9, C12 (deals/gossip/
  offscreen/emotionalArc/relationshipConstants/confessionals are its own files; its
  GameSessionAdapter fold methods are disjoint from Lane 1's commit path — coordinate the one
  shared file at merge). T1's live deal gate ships here as the proof.
- **Lane 4 — Player agency & ladder (engine):** E34–E36, E12 (+T2's honest test), C1, E51,
  E37, E39/C7+E38 (names + seed entropy share `characterFactory`/`createCharacter`), C6.
- **Lane 5 — Prompt content (engine):** P1, P4, P6, P9–P11, E58's varied house events, E60,
  plus C8's intake caps/echo neutralization. Tiny diffs, fast lane.
- **Lane 6 — FE framing & turn integrity (Python):** P2, P3, P7, P8, E16, E22, E23, E24, E25,
  E29, W2 (one-line), E15.
- **Lane 7 — Transcript surface (JS):** E65, E93, D5/W6 beat labels, E94, D3/E66.
- **Lane 8 — Game-build trim (Python+JS):** W1, W3, W4, W5, E17, E72, E96, W7, W8, D6, D7.
- **Lane 9 — Chrome & windows (JS/CSS):** sequenced *within* the lane: E64+E88+E95 (sidebar
  moves) → E90 → E91 (positions, against the new dock) → E97 (animations) → D2 (collision rule
  over the surviving floaters) → E92, E67–E71, then 0052 (themes ride the new chrome).
- **Lane 10 — Ops & supply chain:** E83, E84, E85, E80, E8, E32. Touches nothing the others do.
- **Lane 11 — Docs & status hygiene:** E87, E86(b) if the ADR-amendment path is chosen
  (E86(a) — actually building the fastembed adapter — is its own small engine lane, Lane 12,
  touching only `src/adapters/embedding/` + deploy fetch).
- **Lane 12 — Checkpoint & math hardening (engine, small):** C4, C5, C11, C15, C16, C17, E18
  (dep-cruiser default-deny), E19 (sentinel sweep extension). `saveState.ts`/
  `competitionOutcome.ts`/test files — no overlap with Lanes 1–4.
- **Lane 13 — Test repairs (blocked only where noted):** T3–T12, T15–T17, T19, T20, E76–E79,
  E81, E82 are independent step/test files — split among as many agents as desired (each owns
  whole files). T1 lands with Lane 3; T2 with Lane 4; T14 and the D4/E33 calibration gate
  **after Lane 1 merges**.
- **Lane 14 — Feature specs (docs only):** 0051, 0052 spec docs, 0053 — fully independent;
  0053's *implementation* (routes + settings row) is also independent of every lane above.

### Semantic dependencies (the only true sequencing)

1. **Lane 1 → D4/E33 re-measurement** (can't measure survival calibration while restarts
   corrupt sandboxes) **→ any nomination/vote calibration changes** that measurement motivates
   (which would then touch Lane 3/4 files — schedule as a follow-up, not concurrent).
2. **Lane 9 internal order** as listed (the dock must exist before positions/animations are
   tested against it; D2 shrinks after the sidebar moves).
3. **E12 (vote secrecy) before/with T2** — the honest test asserts the new anonymized surface.
4. **E18's default-deny rule lands after Lanes 1–4 merge** (it will police their new imports;
   landing it first creates merge friction for no benefit).
5. **Integration order at merge:** Lane 1 first (everything downstream re-tests against the
   fixed spine), then 2/3/4 (engine), then 5, then the FE lanes 6–9 (which call the new engine
   behavior), with 10/11/14 mergeable at any time.

Full-gate (`npm test` + FE pytest + smokes) runs per lane pre-merge and once on the integrated
result; the liveSentinel/liveFairness lanes are the cross-lane regression net.

## Recommended wave order

1. **Wave E-CRIT — make seasons restartable and reachable:** E1+D1 (one restart door, baseline
   reset, 4xx on fault), E2, E3, E4 → then re-run the round-4 calibration measurement and land
   E33/D4's jury-reach gate. *(Everything else about the endgame is unreachable content until
   this wave lands.)*
2. **Wave E-SEC — the wall and the edge:** E9, E27, E28, E29, E30, E10, E15, E16, E17, E20,
   E21, E18, E19.
3. **Wave E-SOCIAL — make the simulation matter:** E42, E43, E44, E45, E57, E49, E50, E51,
   E47, E48, E55, E46, E54, E56, E52, E53, E58.
4. **Wave E-PLAYER — agency & first impressions:** E38 (names), E34 (goodbyes), E35, E36, E64
   (sidebar HUD), E88 (sidebar Diary Room), E89 (approach timing), E93 (no editing the record),
   E91 (positions persist), E94 (image attach), E95 (sidebar dock), E65, E66/D3, E22, E23,
   E39/D8, plus the D2/D5–D10 batch from PR #200.
5. **Wave E-POLISH/OPS/DOCS:** the LOW clusters (E8, E13, E14, E26, E32, E37, E40, E41,
   E59–E63, E67–E75, E79–E82, E85, E90, E92, E96, E97), E76–E78, E83/E84, E86/E87. Then the
   0051 future spec.

---

# Post-merge addenda (2026-06-10, after the round-5/6 merge to main)

## A1 [MED-HIGH · Bug + Vacuous-test] ✅ PR #214 — Admin-enabled optional agent tools are silently re-disabled on every default game turn

**The ruling/request (2026-06-10):** the Settings → Admin → Agent tools page lists the
optional "power" tools (off by default); when an admin ENABLES one, it must actually work
when the LLM pulls it as a lever.

**The bug:** it doesn't, for exactly the four most likely candidates. Every Chat-mode turn
auto-escalates to the agent loop whenever the engine is reachable — the *default* player path
(`frontend/routes/chat_routes.py:565-567`, `auto_escalated = True`; the comment even
documents the intent: "the heavy shell/code/file tools stay withheld by the auto_escalated
block"). The withhold block at `:710-713` then updates `disabled_tools` with
`{"bash","python","read_file","write_file","builtin_browser"}` **unconditionally — after**
the game-build chokepoint at `:699-703` honored
`game_build_disabled_additions(get_setting("game_tools_enabled"))`. Net effect: the admin's
opt-in for `bash`/`python`/`read_file`/`write_file` is silently ignored on every
chat-originated game turn and honored only when the player manually selects Agent mode.
The rest of `GAME_TOOL_OPTIONAL` (`grep`/`glob`/`ls`/`edit_file`/`api_call`/
`chat_with_model`/session tools, `agent_tools.py:116-123`) is NOT in the withhold set and
works when enabled — so the admin panel behaves inconsistently per tool, which reads as
random breakage.

**The vacuous claimer (T-stream pattern):** `frontend/tests/test_game_tools_gating.py:161-162`
asserts `game_build_disabled_additions(["bash"])` excludes bash — true in isolation, never
composed with the auto-escalation override, so the suite "proves" the toggle while the
production path defeats it.

**Sub-note:** `app_api`/`api_call`, when enabled under the game build, will 404 against
dropped verticals (their routes are unmounted by design) — the admin UI copy should say so
rather than letting an enabled tool look broken.

**Fix spec:** distinguish the two escalation reasons. The intent escalation
(`chat_routes.py:453-457`, notes/email in plain chat) keeps the withhold as designed; the
game escalation (`:565-567`) must not re-disable explicitly opted-in tools — subtract the
opt-ins: `withheld - set(get_setting("game_tools_enabled", []))` (or skip the block entirely
on the game path, since the game-build chokepoint at `:699-703` is already the single source
of truth for that turn class). Keep `builtin_browser` withheld unconditionally (not in
`GAME_TOOL_OPTIONAL` — there is no sanctioned opt-in).

**Test spec:** (a) chat-path composition test in `test_game_tools_gating.py`: game build on,
`game_tools_enabled=["bash"]`, drive the chat route with `engine_available` true and
`chat_mode="chat"`; capture the disabled set handed to the agent loop; assert `bash` is NOT
in it — mirror case (no opt-in) asserts it IS; (b) the same pair for a non-withheld optional
(`grep`) to pin the consistency; (c) optional E2E: a scripted model calls `bash` on a
game turn and the tool executes. This closes the gap the existing test's isolation
assertion papers over.

## A2 [MED · Bug + Change] ✅ PR #214 — Enabled optional tools: the full four-gate trace — two more silent defeats beyond A1

End-to-end answer to "do disabled tools actually work when activated and called by the LLM's
lever?" Four gates sit between the Settings → Admin → Agent tools toggle and a working call:

1. **Game-build chokepoint** (`chat_routes.py:699-703`) — honors the opt-in. ✅
2. **Auto-escalation withhold** (`:710-713`) — finding **A1**: silently defeats
   `bash`/`python`/`read_file`/`write_file` on every chat-originated game turn. ❌
3. **Schema selection** (`agent_loop.py:1600-1627, 1898-1922`) — on game turns
   `_relevant_tools` is always a filtered set (RAG/keyword retrieval + pinned
   `ORWELL_GAME_TOOLS`), and the function-calling array is
   `FUNCTION_TOOL_SCHEMAS ∩ _relevant_tools − disabled_tools`. Tools in `ALWAYS_AVAILABLE`
   (`tool_index.py:32-40`: bash, python, read/write/edit_file, grep, glob, ls, api_call)
   reach the model when enabled — but the session-class optionals (`chat_with_model`,
   `create_session`, `list_sessions`, `send_to_session`, `pipeline`, `manage_session`) and
   `app_api` are NOT in `ALWAYS_AVAILABLE` and enter only via keyword hints
   (`tool_index.py:395-403`) that in-character prose never triggers — **enabled but never
   offered**: the toggle is a no-op for them on game turns. ❌
4. **Per-owner security** (`tool_security.py:178-182` + `NON_ADMIN_BLOCKED_TOOLS:14-51`) —
   non-admin owners are blocked from every power tool regardless of the toggle (sound
   policy), but nothing in the admin UI says the toggle is admin-owner-only, so for
   multi-account installs it reads as breakage. ⚠️ document.

**Net matrix (single-admin install, default game turn):** work when enabled —
`grep`/`glob`/`ls`/`edit_file`/`api_call`; defeated by gate 2 —
`bash`/`python`/`read_file`/`write_file` (manual Agent mode only); defeated by gate 3 —
the six session-class tools + `app_api` (which would additionally 404 against dropped
verticals, A1 sub-note). Non-admin players: nothing optional works (gate 4, by design).

**Fix spec:** (a) gate 2 per A1; (b) gate 3 — union the explicit opt-ins into the candidate
set alongside the pinned game tools (one line at the `pinned_tools` merge,
`agent_loop.py:1626`): an admin grant is not something retrieval should have to guess;
(c) gate 4 — admin UI copy: "optional tools apply to admin accounts only," and gray the
toggles when viewing as non-admin-relevant.
**Test spec:** schema-assembly test — game turn, `game_tools_enabled=["chat_with_model"]`,
assert the schema array handed to the API call contains `chat_with_model` (and the A1
composition cases); pytest for the gate-4 UI copy.

## A3 [MED · UX/System] ✅ PR #205 — The settings pane has no shared layout primitives — stray dividers and margin defects are the symptom

**User-reported (2026-06-10):** stray dividers and margin problems in the settings pane (on
top of the ruling-16 crowding report). **Root cause verified:** `frontend/static/js/settings.js`
contains **219 inline `style="…"` attributes** and the settings markup defines **zero** shared
section/divider classes (no `.settings-section`, no `.settings-divider`, no `<hr>` — section
breaks are improvised per tab, e.g. `<div style="font-size:11px;font-weight:600;opacity:0.6;
margin:8px 0 2px">` pseudo-headers). With no spacing scale or section component, every tab
accumulates its own margins/borders independently — orphaned separators and uneven gutters
are the inevitable result, and no single fix can hold.

**Fix spec (folds into the S-stream mechanism — ruling #16):** a small settings layout kit in
`style.css` — `.settings-section` (titled group with one consistent top rule + spacing-token
margins), `.settings-divider`, `.settings-row` variants on a shared spacing scale — then a
mechanical sweep of `settings.js` replacing inline layout styles with the kit (non-layout
inline styles like the spinner can stay). Add a regression gate: a pytest/source check that
caps inline `style=` attributes in `settings.js` (ratchet from 219 down as the sweep
proceeds) so the pane can't silently re-accrete ad-hoc layout.

---

# Stream S — responsiveness & installed-app audit (ruling #16; live-measured)

**Method:** static analysis of `style.css` (36,494 lines) + all injected panel styles, plus a
**live boot** driven with Playwright at 1366×768, 1024×768 (the ~125%-scaling proxy), 960×900
(half-snap), and 390×844 — measuring real modal/panel geometry, scrollWidth vs clientWidth,
computed font sizes, and touch targets, with per-tab settings screenshots. Round-4 and
E-batch items not re-reported; A3 (settings layout primitives) folds into S1/S12.

## Findings

- **S1 [HIGH · Bug/UX] ✅ PR #205 — The settings modal cannot de-crowd at normal desktop sizes —
  root-caused.** Measured: at 1366×768, 1024×768, and 960×900 the modal renders
  **byte-identically** (720px wide, 160px rail, 30px rows, 10px hints, 12px labels).
  Causes: (1) `width: min(720px, 92vw)` (`style.css:21349`) — `min()` only shrinks, never
  grows; at 125% scaling the same 720px eats 66% of a ~1093px viewport while `85vh`
  collapses to ~522px ⇒ less room, same density; (2) the whole modal is fixed sub-13px px
  type (`21415` 9px, `22488` 12px labels, `5664` 10px hints…); (3) **the density feature is
  dead on arrival** — `:root.density-compact/spacious` set root font-size (`152–156`) but
  the stylesheet has **1,135 px font-sizes vs 70 rem and 0 clamp()**; the user's only
  "bigger text" lever does nothing to the surface they complain about; (4) fixed chrome
  (160px rail, fixed paddings/gaps) absorbs nothing; (5) dozens of inline px styles are
  unreachable by any future rule (S12). *Fix:* width `clamp(560px, 58cqw, 880px)` against
  the overlay container; rem scale per the mechanism; rail `clamp(140px, 18cqw, 200px)`.
  *Acceptance:* hints ≥12px-equivalent at 1366×768; density toggle visibly scales the modal.
- **S2 [MED · UX] ✅ PR #205** — No short-viewport tier for settings: `min-height: 400px` +
  `max-height: calc(85vh - 60px)` (`21379–21380`) with `margin-top: 7vh` nearly touches the
  viewport bottom at 614px CSS height. Use `min(85dvh, 720px)`; drop the min-height under a
  height breakpoint.
- **S3 [MED · UX/Bug] ✅ PR #205** — The narrow settings tab rail hides 476px of tabs with zero
  affordance (`scrollWidth 866` vs `clientWidth 390`, `scrollbar-width:none` at `21595`) —
  Appearance/Shortcuts/Account/admin tabs are invisible on phones; and the layout switch
  exists as two diverging copies (`@media 600` at `21561` vs `@container 620` at `21582`).
  Keep only the container query; add an edge-fade affordance or two-row wrap.
- **S4 [MED · System]** Container-query adoption is half-finished: six surfaces use it
  (settings, tool modals, doc panes); every other modal/panel responds to the *viewport* —
  wrong by definition for draggable/snappable windows (the settings rule's own comment says
  so, `21579–21581`). Make `@container` the rule for all windows.
- **S5 [HIGH · System] ✅ PR #203 — Breakpoint anarchy: ~20 distinct thresholds across three idioms.**
  `@media` widths 768(×71)/600/820/640/520/540/480/460/700/720/769/821; container
  620/460/360/340/260; **JS `innerWidth` vs 768 written four different ways (44 sites)** —
  at exactly 768px, modules disagree which mode they're in. Plus near-duplicate tiers
  (820/821, 600/620). *Fix:* the token set + lint gate in the mechanism.
- **S6 [HIGH · System] ✅ PR #206 (the anchor-slot contract) — Every floating panel sizes itself differently; four have no narrow
  handling at all.** Inventory: status/social = fixed top offsets + 220px + a ≤768 sheet
  rule; **finale (240px floater, zero @media), presence, retrospective — no narrow tier**;
  the engine banner overlays at `top:0` (covered the mobile sheet grab-handle in
  screenshots); the DR modal re-implements none of the shared sheet system. The hard-coded
  `top:64px`/`top:210px` offsets encode assumptions about *each other's heights* — the
  structural cause of the R2/R4 overlap family. *Fix:* the anchor-slot contract below.
- **S7 [HIGH · Bug] ✅ PR #203 — PWA installability is broken: both manifest icons 404.**
  `manifest.json:12–13` → `/static/icon-192.png`/`icon-512.png` — neither exists (verified
  live); `apple-touch-icon` points at the same hole; the per-route manifest swap explicitly
  skips the root path. No valid icon ⇒ **no install prompt** — for a product whose mandate
  is "functions as an installed app." *Fix:* ship maskable 192/512 PNGs + 180px apple icon,
  precache, smoke-assert 200s.
- **S8 [MED · Bug/UX] ✅ PR #203 (tier + text-size-adjust; JS-panel safe-areas land with the chrome PR's slots) — Standalone-mode gaps:** no `@media (display-mode: standalone)`
  anywhere; no `text-size-adjust: 100%` (iOS landscape autoinflation of the fixed-px
  panels); JS-injected panels never use `env(safe-area-inset-*)` (presence `bottom:84px` /
  retro `bottom:96px` sit in the home-indicator band; the `top:0` banner collides with the
  notch under `viewport-fit=cover`).
- **S9 [MED · UX/Bug] ✅ PR #203 (the floor rule; residual swatch/slash rows xfail-tracked) — Touch-target floor violations beyond round 4's HUD chrome
  (measured):** settings nav tabs 32px at every viewport; slash-menu rows ≈22px;
  shortcut-action 24×24; fallback-remove 22×22; color swatches 24×24. The composer's
  coarse-pointer bump (28×32 → 44×44, `style.css:3036`) proves the mechanism — it was never
  swept. *Fix:* one `(pointer: coarse)` floor rule on a `--tap-min` token.
- **S10 [HIGH · System] ✅ PR #203 (the scale + fluid root; the settings px→rem sweep lands with the settings-repair PR) — There is no typography system** — 1,135 px font-sizes, 70 rem,
  0 clamp(); each surface invents its own 9–14px micro-scale. Ironically the orwell game
  panels use rem and would scale for free under a root-size mechanism the inherited
  workspace defeats.
- **S11 [MED · Bug] ✅ PR #206 — Saved panel positions restore unclamped on a different-sized viewport**
  (`orwellStatusPanel.js:68–73` et al.; `windowDrag.js`'s clamp runs only on `resize`) — a
  position saved at 2560px restores fully off-screen at 1366px. `windowResize.js:223`
  already clamps restored *sizes* — unify the pattern at restore (cross-device half of E91).
- **S12 [MED · System] ✅ PR #205 (type fully tokenized; the A3 ratchet caps the rest)** — Sizing-in-markup: dozens of inline `font-size`/`width` styles in
  the settings tree (`index.html:1794–1810`, `settings.js` builders) escape any central
  refactor — sweep into classes + the A3 ratchet gate.
- **S13 [LOW · Bug latent] ✅ PR #205 (settings; remaining modals move as they're touched)** — Modal width clamps use `vw` against a viewport the modal
  doesn't occupy (overlays are narrowed by the sidebar; `92vw` is inert at 1024px with the
  sidebar open) — use `cqw` against the overlay container they already have.

## The coherent mechanism (implementation-ready — the spine of the UI track)

One new `frontend/static/css/responsive-tokens.css` loaded before `style.css` + a contract
section in `INTEGRATION.md`:

1. **One breakpoint token set** — `--bp-compact: 480px / --bp-narrow: 768px / --bp-medium:
   1024px / --bp-wide: 1440px` (container tiers {360, 620}); enforced by a pytest lint gate
   that fails any `@media`/`innerWidth` threshold outside the set; JS normalized to a single
   `isNarrow()` via `matchMedia` (kills the 768 off-by-one written four ways). **Viewport
   queries are for page chrome only; anything draggable/dockable responds to `@container`.**
2. **The modal & floating-panel sizing contract** — every modal: `width: clamp(min,
   preferred-cqw, max)` (never bare fixed, never plain `min()`), `max-height: min(85dvh,
   cap)` with internal body scroll, mandatory `container-type`, and ≤768 becomes the shared
   bottom sheet (DR modal + onboarding move onto the shared classes). Every floating panel:
   **anchor slots, not coordinates** — a slot registry (`top-right`, `top-left`,
   `bottom-center`, `banner`) owned by `modalManager` stacks panels by measured height,
   deleting the `top:64/210px` constants and making the D2 collision rule structural; drag
   is a persisted offset-from-slot, clamped at restore (S11/E91); safe-area-inset offsets
   everywhere fixed positioning exists (S8).
3. **Fluid type on a rem scale** — fluid root via clamp(), token scale `--fs-2xs … --fs-xl`,
   floor `--fs-2xs` (~11px) for all UI text, density classes revived for free; migration is
   mechanical px→rem starting with the settings tree; add `text-size-adjust: 100%`.
4. **The PWA baseline** — real maskable icons (S7), a `display-mode: standalone` tier
   (status-bar-safe banner), the one coarse-pointer `--tap-min` floor rule (S9), and
   codifying the already-correct meta/dvh/overscroll/SW posture in INTEGRATION.md so a
   vendored update can't regress it.
5. **The responsive matrix gate** — promote the round-4 Playwright harness into
   `frontend/scripts/responsive_matrix.py` (FE pytest lane): ~10 staged surfaces × 6
   viewports + one standalone emulation + one 200% root-font pass; measurable assertions
   for overflow (`scrollWidth ≤ clientWidth+1` unless declared + affordance), overlap (no
   registered surface intersects another or the composer — D2, executable), **crowding**
   (no unellipsized text overflow; computed font ≥ `--fs-2xs`; label/control collision
   check; line-box overflow on nowrap elements), and touch (≥36px boxes at coarse-pointer).
   The full matrix ran in <2 minutes in the audit environment.

## Sound (keep-list)

The mobile sheet system (`6504–6660`: dvh, safe-area, grab pills, overscroll-contain) is
genuinely good — just not universal; the settings container query is the right template;
viewport meta is correct and zoom is not disabled; the SW caching strategy is tiered and
versioned; `body{height:100dvh}` + `overscroll-behavior:none` already handle the
keyboard/pull-to-refresh classes; `windowResize.js` clamps restored sizes (the pattern to
unify); the composer's coarse-pointer bump works; and the decision card is the one game
surface already on the correct sizing idiom — the model for the rest.

## A4 [Ruling #17 + spec] ✅ PR #218 — Going private on GitHub — one PAT prompt, ever

**Ruling (2026-06-10):** `Psychout-Media/orwell` becomes a private repo; no deploy/update-adjacent
script may break, and the user is asked for a credential **at most once**.

**What breaks today (inventory):** anonymous `git clone` (`orwell-install.sh:8,42`,
`orwell.sh:101`); the in-container `git fetch/pull` in `orwell-update.sh` (origin is the
anonymous https URL); the five raw-curl bridge fetches (`orwell-update.sh:52`,
`orwell-factory-reset.sh:69`, `orwell-game-reset.sh:71`, `orwell-doctor.sh:75` fallback,
`orwell.sh:199`); every `bash -c "$(curl raw…)"` one-liner in `deploy/README.md`. Unaffected:
GitHub Actions CI (automatic `GITHUB_TOKEN`), the front-end (no GH fetches), the fastembed
model fetch (not GH-hosted).

**The design (auth once, then never again):**

1. **One fine-grained PAT, captured at install only.** Scope: repo `Psychout-Media/orwell`,
   permission **Contents: Read-only**, nothing else. The bootstrap one-liner becomes the
   single authenticated moment:
   `GIT_TOKEN=github_pat_xxx bash -c "$(curl -fsSL -H "Authorization: Bearer $GIT_TOKEN" https://raw.githubusercontent.com/Psychout-Media/orwell/main/deploy/orwell.sh)"`
   (authenticated raw works on private repos). `orwell.sh` passes `GIT_TOKEN` into the
   container; `orwell-install.sh` clones with it and then **persists it to
   `${APP_DIR}/data/.env`** (`GIT_TOKEN=…`) — the one file every reset already preserves, so
   the factory reset, game reset, and updates never re-prompt. For an EXISTING install,
   `orwell-update.sh` gains a one-time `--set-token` prompt (and rotation path) that writes
   the same line.
2. **The token never lives in the remote URL or `.git/config`.** Configure a credential
   helper that reads `.env` at use time:
   `git config credential.helper '!f(){ echo username=x-access-token; echo "password=$(sed -n s/^GIT_TOKEN=//p '"$APP_DIR"'/data/.env)"; };f'`
   — `git pull/fetch` in every script then just works; rotation = edit one line of `.env`.
3. **Kill the raw-curl bridges — which also closes E84.** Post-install, every host bridge
   stops fetching from GitHub entirely: when run from a local file it pushes its own copy
   (the doctor already does this — `orwell-doctor.sh:73`); otherwise it runs the
   **in-container checked-out copy** via `pct exec bash ${APP_DIR}/deploy/<script>.sh`. The
   in-container update does `git pull` first (credential helper supplies auth), so the
   "one-version-stale script" window is a single update cycle — the exact integrity shape
   E84 recommended. Net: zero GitHub fetches outside `git`, zero `curl | bash` of branch
   tips, zero token exposure on the host.
4. **README rewrite:** first-install keeps the one authenticated one-liner (step 1);
   every other command becomes the local-copy form
   (`bash /opt/orwell/deploy/orwell-update.sh`, or from the host the same script which
   bridges via the local/in-container copy). The raw-curl maintenance one-liners are
   deleted.
5. **PAT expiry note:** fine-grained PATs cap at one year — document `--set-token` as the
   annual rotation (still "once," per year). The zero-expiry alternative — a read-only
   **deploy key** (SSH) pasted into GH once — is recorded as the variant for users who
   prefer never rotating; the PAT-in-`.env` path is the default because the
   preserve-`.env` infrastructure already exists.

**Tests/gates:** extend `deploy/smoke.sh` to run the update flow against a token-required
local git remote (proves the credential helper path); a deploy-lint test asserting **no
`raw.githubusercontent.com` URL remains in any script** (only the README's first-install
line); the existing secrets guard already covers "no token literal committed" — extend its
scope per E78 so a pasted PAT in any tracked file fails CI; factory-reset test asserts
`GIT_TOKEN` survives the scrub (it lives in the preserved `.env`).

---

# Campaign close-out ledger (2026-06-10, end of the parallel phase)

The implementer's honest accounting, verified by the Audit Manager against final main where
cheap to do so. This section is the authoritative open-items list going forward.

## A — Findings never reached (no code, no PR)
- ✅ **T3–T7, T10, T11, T19, T20** — nine T-stream test-integrity repairs — **DONE (PR #225,
  Lane B)**. Re-pointed at live seams / real assertions, each strengthened test
  mutation-verified; T10/T19 were already hardened in code by PR #221 and are verified +
  stamped here. (Originally open — Lane 10 lost two agents mid-work; only T8/T9/T12/T15–T17
  shipped then.)
- ✅ **E86(a)** — the real fastembed local-ONNX `EmbeddingProvider` adapter — **DONE (PR #226):**
  `FastembedEmbedding` + `fastembedWorker` behind the synchronous `EmbeddingProvider` seam, loud
  permanent degrade to the deterministic fake on failure. (Was: open — ADR 0004 had been amended
  to "Accepted — adapter not yet built." See the "E86a — BUILT" section below.)
- ✅ **Calibration instrumentation (the playtest-revisit enabler)** — the owner chose "instrument
  & gather data first" over tuning the calibration weights for the open E33-ceiling question
  ("passive players coast to Final 2 and lose there — emergent realism, or a degenerate plateau?",
  section C below). Two measurement pieces, **NO weight change**: (1) an append-only per-user
  **season-outcome log** (`frontend/src/orwell_outcomes.py`) that durably records the PUBLIC,
  post-finale facts the question needs — final placement, the player's recorded social-scene
  count, their public competition wins, and the final jury-vote margin — captured idempotently
  when a season finishes and surfaced on the admin surface (`/api/admin/calibration/outcomes`,
  the 0053 `require_admin` read pattern), so real playtest data accrues to review; and (2) an
  engine **gradient gate** (`tests/property/calibrationGradient.property.test.ts`, heavy-sims lane)
  that proves a minimal-active seeded policy reaches the jury and wins **at least as often** as the
  fully-passive policy `juryReach` already gates — measuring that *playing the game is never a
  disadvantage*, the monotonic property any future calibration must preserve. (Was: only the
  passive extreme was gated, and no public playtest data was captured.)

## B — Cross-lane tails that fell through (each verified absent on main)
**✅ All five DONE — one "cross-lane tails" PR (PR #224, Lane A), each with its proving test.**
1. ✅ **E54 tail** — `reliability` is now consumed in both seams: `chooseVetoSave` ranks the
   veto save by demonstrated loyalty (`RELIABILITY_WEIGHT`), and a centered reliability term
   (`JURY_WEIGHTS.reliability`) shifts `juryLean`. (Was: built/fed/consumed by `bondStrength`
   only.)
2. ✅ **E58 tail** — `PublicGameStatus.day = dayOfWeek(phase)` (hoh=1…eviction=5, null
   off-ladder). (Was: helper existed and fed the prompt, but the view had no `day` field.)
3. ✅ **CLAUDE.md ruling-#1 wording** — the do-not now reads the amended "no fixed cast"
   formulation (name corpora are raw material; no full-name+persona pairing hard-coded; legacy
   Bible's names stay banned). (Was: documentation drift only.)
4. ✅ **C8's third sub-item** — a later `updateCasting` that replaces a captured scalar now
   reports `overwrote: [...]` on the casting status, so the producer confirms rather than
   silently clobbering.
5. ✅ **E60/E89 FE tail** — the approach chip varies its framing by the `bond | probe` motive
   (copy + class + tooltip), and a FE belt (`firstCeremonyResolved`) suppresses every chip
   before the first ceremony resolves — holding even if the engine fails open (browser-smoke
   proven).
*Disposition: items 1–5 shipped as PR #224 with proving tests; engine `npm test` + FE
pytest/browser-smoke/matrix green.*

## C — Done differently than specced (deliberate, ruled)
- **The calibration measurement** runs 20 seeds × one active variant (compete +
  self-saving veto) as a permanent deterministic gate; the round-4 62-seed protocol and the
  never-use-veto variant were not re-measured (the dead agent's runs died with it).
- **The E33 ceiling (ruling):** passive jury-reach stays high (19/20) as emergent realism;
  "purge the floater" house behavior was explicitly NOT built. Passive players coast to
  Final 2 in ~half of seasons and lose there. **Revisit after real playtesting** — this is
  the largest open game-feel question.
- **`bondKeepWeight`** retained on realism grounds despite not moving the gate (ruled).

## D — Pre-existing deferrals, untouched (never campaign scope)
0022 (player-experience MVP-2) · 0010's container smoke on a real Proxmox host — which
means **the A4 single-PAT deploy design has never been verified on a real deployed box**,
only via simulated smoke probes; verify it during the private-repo flip · the real
relational adapters (SQLite/Postgres, sqlite-vec/pgvector) · ~~full MCP/JSON-RPC over the
HTTP transport~~ — **the JSON-RPC 2.0 envelope is now ✅ built** (additive `POST /:channel/rpc`:
`initialize`/`tools/list`/`tools/call` + notifications/batch, same guardrails; `jsonRpc.ts`);
only the unneeded SSE server-push stream remains (no server-initiated messages) ·
the specced-not-built 0051 (in-character images). **0053 (admin transcripts)
is now ✅ built (PR #223, Lane C)** — read-only admin-gated transcript retrieval incl. the
agent tool-call nodes; FE pytest-validated.

## The remaining work, in dispatch order
1. ✅ **The cross-lane tails PR** (B1–B5; one PR, proving tests included) — **DONE, PR #224.**
2. ✅ **The T-remainder batch** (A: T3–T7, T10, T11, T19, T20) — **DONE, PR #225.**
3. ✅ **0053 admin transcripts** (ruling #14) — **DONE, PR #223.** **0051** still when ready.
4. ✅ **E86(a)** fastembed adapter — **DONE, PR #226** (see the "E86a — BUILT" section below).
5. **The private-repo flip** — after a real-host verification pass of the A4 scripts (D).
6. **The playtest-gated calibration revisit** (C) — gather real sessions first.

> **Close-out update (2026-06-11):** the three dispatch-order-1/2/3 lanes landed as PRs
> #224 (cross-lane tails), #225 (T-remainder), and #223 (0053 admin transcripts), merged to
> `main` in that order atop the ledger PR #222. Dispatch item 4 (**E86(a) fastembed**) has since
> landed too (PR #226 — see the "E86a — BUILT" section below). Items 5–6 remain deliberately
> deferred (decision-gated): the private-repo flip (needs a real-host A4 verification) and the
> playtest-gated calibration revisit.

---

# Post-campaign UI follow-ups (rulings #18–#20, 2026-06-11 — playtest feedback)

## A5 [Ruling #18 · 0052 follow-up] Every house theme ships a creative particles.js background
The five house themes lack the particles.js background treatment the inherited themes have;
each must get one, in-theme: **The Feed** — sparse night-vision dust with an occasional
horizontal scanline sweep; **Telescreen** — faint phosphor flicker points; **Room 101** —
slow dust motes under a fluorescent stutter; **Memory Wall** — drifting bokeh/ember points
like gallery backlighting; **Sequester** — heavy slow velvet motes in brass. Constraints:
reuse the app's existing particles machinery; behind the chat (z-index), perf-budgeted;
`prefers-reduced-motion` ⇒ static or off; pause on `document.hidden`. *Test:* per-theme
particles config present + reduced-motion disables; browser smoke asserts the canvas mounts
behind the chat column.

## A6 [Bug · 0052/frost] Frosted transparency breaks at the top of open windows
User-observed: the frost visibly breaks at each window's top edge. Likely cause family: the
backdrop-filter living on a child/::before that doesn't span the header strip, or
border-radius clipping applied on a different element than the one carrying the filter.
*Fix spec:* the window ROOT carries `backdrop-filter` + radius + `overflow:hidden` as one
surface (header included); no separately-painted opaque header backgrounds over the frost.
*Test:* matrix/browser smoke samples computed styles — the element with backdrop-filter is
the panel root and the header's background is transparent over it.

## A7 [Ruling #19 · E97 follow-up] Close/minimize get a Windows-7-style fly-out
The E97 contract specced minimize motion toward the dock; the ruling sharpens it: a
**fly-out** — scale-down + translate along the path to the sidebar dock row on minimize,
and a scale+fade fly-away on close, with pronounced easing (the Win7 feel). Open stays
fade+scale-in. `prefers-reduced-motion` strips all of it. *Test:* the shared animation
contract exposes distinct minimize/close keyframes; reduced-motion removes them.

---

# E86a — BUILT (2026-06-11) · and the round-7 verification sweep

## E86a ✅ — the fastembed adapter (this PR)
`FastembedEmbedding` + `fastembedWorker` (`src/adapters/embedding/`): real local-ONNX
embeddings (fastembed pinned exact at 2.1.0; model pinned `fast-bge-small-en-v1.5`) behind
the synchronous `EmbeddingProvider` seam via a worker-thread SharedArrayBuffer/Atomics
bridge — the soul seam stays sync (the masked-race constraint), the vector space is
committed once per process at boot warm-up (`setRuntimeEmbedding` before any sandbox;
restore re-derives indexes via `rebuildSoulIndex`), and any failure degrades loudly +
permanently (per process) to the deterministic provider — the game never breaks. Deploy:
installer writes `ORWELL_EMBEDDINGS=fastembed` + `ORWELL_EMBED_CACHE=data/models` and
prefetches the model; update re-prefetches (no-op when cached); both reset scripts preserve
`data/models`. Tests: the bridge proven against protocol-faithful fake workers
(`tests/unit/fastembedBridge.test.ts` — ok/stall-degrade/init-fail/composition); the real
model only in the opt-in `ORWELL_TEST_FASTEMBED=1` integration test, per the ADR's
no-test-depends-on-real-embeddings rule.

## Round-7 verification sweep (origin/main @ 65cb5d4) — the campaign's claims, live-checked
**15/16 CONFIRMED, 1 PARTIAL.** Confirmed live on the real engine: the restart family
(season 2 survives reset + process kill; faults are 409s), the tick debounce (4 rapid calls
⇒ one tick, +4 hidden events, was +16), knowledge anchoring (both invented-content channels
refuse; genuine retellings pass), E20/E21, vote secrecy (13 staged evictions, `votedFor`-only
reveals; attribution unseals post-season only), player goodbyes as pending decisions, the
Houseguest's-Choice fix (seed-82 live repro: zero overlap, 6 distinct), 400s on malformed
args, A1/A2, W1, P1/P2, E38 (real-name casts live: "Sage Carr, Ivan Ramirez, Natasha
Lawrence…"), E22, E18 default-deny, and 3/3 doc stamps.
**PARTIAL — R3 perf:** snapshot reuse landed and is tested (≤2 serializations/mutation, was
~4), but late-season latency still grows linearly with the event log (~9× wk1→wk13, ~half
the old curve) — improved, not eliminated. The remaining cost is the O(events) export
itself; a future incremental-snapshot item if play feels it.

### New defects from the sweep (open; small)
- **A8 [LOW · Bug]** `humanize` mangles the English word "player(s)" in beat prose
  (`GameSessionAdapter.ts:1379–1387` splits on the literal id `"player"`): live repro —
  "the veto *Quinn Vales* are drawn… will name the final *Quinn Vale*" on every veto-draw
  beat. Fix: word-boundary-aware substitution (the old E63 sub-item, still open in practice).
- **A9 [LOW · Noise]** Late-season off-screen ticks log repeated
  `integrity fault … kinds=no-daily-event` (21 lines/season observed; fail-closed, circuit
  never opened, health ends ok) — quiet the expected-empty-tick case before it can ever
  meet the circuit threshold.
- **A10 [LOW · API]** The Houseguest's-Choice pending presents `options`+`pick:1` like
  choice-shaped decisions but `submitDecision` expects the pick on `vote` — any non-FE
  client trips. Align the field or document it on the pending view.

- **A11 [LOW · Noise · prod-observed 2026-06-11] ✅ DONE (ops-render-checks lane) — documentation +
  the doctor ignores it.** onnxruntime inside an LXC logs
  `pthread_setaffinity_np … error code: 22` (twice, at thread-pool creation) when the
  container's cgroup cpuset doesn't grant the host CPU indexes ORT tries to pin — harmless
  (threads run unpinned; inference unaffected), appears at prefetch and once at boot
  warm-up. Mitigation is documentation only (deploy README + the doctor ignores it):
  fastembed-js doesn't expose ORT's `intraOpNumThreads`, and widening the LXC cpuset is a
  worse trade. Upgrades to a real finding only if it ever spams per-inference (it
  shouldn't — one session, one pool, created once). *Fix:* a new **"Known harmless log noise (A11)"**
  section in `deploy/README.md` documents it as expected-and-ignorable, and
  `orwell-doctor.sh`'s `journal_tail` now drops exactly that benign ORT line from a failing
  unit's journal tail (reporting how many lines it hid) so it can never masquerade as the crash
  reason — every genuine diagnostic line still passes through.

## A12 [Ruling #21 · 2026-06-11 — SHIPPED same day] The container shell greets with a live health panel
**Ruling:** entering the container must never feel hung — interactive shells get a terminal
health panel. **Shipped:** `deploy/orwell-login-panel.sh` → installed as
`/usr/local/bin/orwell-panel` by install/update with a guarded `/etc/bash.bashrc` hook
(interactive shells only, `ORWELL_PANEL_SHOWN` guard). Shows: unit + HTTP health for both
tiers (and whether the tiers agree), recall provider + model-cache state, save count,
load/mem, the play URL, and the doctor/update one-liners. Design rule: NEVER blocks a
login — every probe `curl -m 1`, everything `|| true`, measured 96ms worst-case render with
all probes failing, exit 0 always. Legacy bbai-aware.

---

## 2026-06-19 (PM) — session reconciliation (authoritative current state)

This entry is the single authoritative snapshot for the 2026-06-19 PM work session. It is
grounded in the **merged git history** (`origin/main` @ `38a3381`), not the drift-prone
feature-README / CLAUDE.md status prose — where those disagree with the merged code, the code
wins and the drift is called out under *Ledger corrections* below.

### Merged to main this session
- **#348** — engine-sim perf: killed the per-season O(events²) integrity-checkpoint hotspot
  (passive season ~26.6s→4.8s, byte-identical outcomes by golden hash; every heavy CI lane now <3 min).
- **#347** — windowing kit airtight: re-clamp open kit windows into the viewport on browser resize.
- **#345** — vault/new-season window collision fix (distinct slots + clamped base-anchor stacking) — **closes L43**.
- **#344** — live-debug verification pass: L1–L20 confirmed fixed in code (running instance was a stale deploy); logged L43/L44/L45.
- **#342 / #341** — CI: jury path-filter + UAT fan-out (split matrix, one file per runner).
- **#340** — **0061 player self-eviction — BUILT, BDD-gated** (forfeit-on-quit, skippable parting message, any-beat-resolved; NPC self-eviction out of scope).
- **0062 move-in zeitgeist snapshot — BUILT, BDD-gated** (2026-06-20). `src/engine/zeitgeist.ts` captures
  ONE frozen, seeded `WorldSnapshot` at season creation (same seed hinge as the cast), persists it byte-
  stable on `SessionCore`/`GameState` (recalled never re-searched; 0007 superset/byte-compare guards the
  freeze), and renders the Vault-free "world you all moved in with" block into BOTH the player moment
  prompt AND the off-screen/`social` prompt (the C32-beyond reach), scaling the out-of-the-loop drift by
  the live week. FLAVOR ONLY — a seeded game advanced WITH vs. WITHOUT the snapshot is byte-identical in
  every comp result, vote, nomination, and relationship/soul fold (the §6/§10 headline guard, proven
  structurally). Owner recs taken: one-time 7-day lag offset (§11 #1), capture-once-persist + deterministic
  `model-framed` fallback for tests/replays (§11 #2/#9), small-and-bounded slices (§11 #3), engine-side
  outward `GameState` field (§11 #4). FE `web_search` capture lands via the `recordWorldSnapshot` write-back
  seam (FE provider wiring is its own lane, like 0051). `0062-*.feature` in `cucumber.cjs`; unit `tests/unit/zeitgeist.test.ts`.
- **#339** — **0062 move-in zeitgeist snapshot — SPEC** (superseded by the BUILT entry above).
- **#338** — NPC movement weighting, RNG- & calibration-isolated (juryReach green).
- **#337** — calibration instrumentation + gradient gate (no weight changes).
- **#336** — **0060 story-thread trigger/resolution scheduler — BUILT** (`src/engine/threadConstants.ts`; `0060-*.feature` in `cucumber.cjs`).
- **#335** — **0054 Phase 2 dock windows + A7 fly-out — DONE** (finale/cast/retro dock into the gadget rail; Win7 fly-out).
- **#334** — CI speedup (parallelize heavy sims; drop coverage double-run).
- **#332** — L27b recall fidelity + L39 God-Mode/finale + L37 ops-log hygiene.
- **#331** — L32/L34 frosted themes + whereabouts cohesion (L21/L24).
- **#330** — **E63 + SQLite relational adapters — DONE** (opt-in `ORWELL_STORE=sqlite`, sqlite-vec engine-only, Vault-walled).
- **#329** — L15/L17 cast-gen responsiveness + look-alike dedup pass.
- **#328** — 0058 Phase 2 thread-scheduler SPEC (built as 0060 in #336).
- **#327** — R3 incremental O(Δ) checkpoint (the `eloquent-hamilton` lane).

### The five dispatched lanes — ALL MERGED (a mid-session container restart killed the agent
*processes*; all work survived as on-disk worktrees, was committed + pushed as WIP checkpoints,
and finisher agents drove each to green — fast-gate only, **no heavy sims locally**, the real OOM cause):
- **#352** (`claude/0063-build`) — 0063 casting diversity floor (BIPOC/LGBTQ+/gender/age floors; ethnicity facet; **Vault-sealed private orientation**) + **orientation-aware 0059 showmance eligibility** + portrait enrichment. **Supersedes the #346 spec.**
- **#351** (`claude/ci-targeted-and-sharded`) — per-job path-filtering + shard heavy lanes (UAT 12→3, jury 20→5, gradient 6→2) under a unified deadlock-free `ci-gate`. **Supersedes #343.** Proved itself green end-to-end; every heavy lane <3 min.
- **#349** (`claude/portrait-image-config`) — square (1:1) aspect + pinned 1024² size + reference-image-on-regen (identity preservation for B&W eviction shots + L17 re-shoots).
- **#353** (`claude/fe-polish-…`) — **A5 (theme particles) + A6 (frosted-top, the kit titlebar's own backdrop-filter re-blurring the glass) + L45 (punctuation guard ?→!/./…)**. *0054 P2 dropped — already merged in #335.*
- **#354** (`claude/calibration-data-instrument`) — season-outcome instrument + the data report (`docs/audits/2026-06-19-calibration-data.md`). Instrument excluded from the fast gate/coverage (60-season run, on-demand only).

### Now in flight
- **0058 Phase 2 remainder** (`claude/0058-phase2-build`) — `recordCastProfile` LLM write-back + premiere voicing (the portrait physical-facet consumption is largely covered by the 0063 enrichment; the thread scheduler shipped as 0060/#336). **Kicked off now that 0063 merged** off the shared `GameSessionAdapter.ts`.

### Closed as superseded
- **#346** (0063 SPEC) → folded into #352. · **#343** (jury shard only) → folded into #351.

### Ledger corrections (drift fixed this pass)
- **0054 Phase 2 + A7 = DONE** (#335). **0060 = BUILT + BDD-gated** (#336). **Relational adapters (SQLite) = DONE** (#330). **A6 frosted-top = DONE** (#353).
- **live-debug ledger:** L43 fixed (#345); L15/L17 shipped (#329); L45 guard extended (#353).

### Still genuinely open (forward backlog, after this session)
1. **Calibration TUNING** — the instrument (#354) landed the data: passive reaches F2 43% / wins 17%, landslide F2 losses trace to `JURY_WEIGHTS.gameRespect: 0.9`. The follow-up lane lowers it ~0.6–0.7 and re-runs the instrument + `juryReach` `EARNED_WINS` guard. **The single biggest game-feel lever still unpulled.**
2. ✅ **0062** — move-in zeitgeist snapshot **— BUILT, BDD-gated** (2026-06-20; see the ledger entry above).
   *Forward FE follow-on (its own lane, not blocking):* wire the FE `web_search` capture into
   `recordWorldSnapshot` at season creation (the engine seam is built; the FE owns the provider, like 0051).
3. **0022** — MVP-2 rich game UI (the long-standing deliberate deferral; the chat *is* the UI per ADR 0003).
4. **0010 real-Proxmox container smoke** + A4 single-PAT real-host verification (do at the private-repo flip).
5. **R3 deep follow-on** — the full O(Δ) `isSuperset`/leak-check rewrite (the WeakMap memo + #348 cut the worst hotspots; the export itself is still O(events)).
6. ✅ **Browser-render validations owed — DONE (ops-render-checks lane).** `browser_smoke.py`
   now drives the real FE headless and asserts both surfaces actually render: **0051** — a real
   cast-portrait `<img>` is present, has its src, and is SIZED (~1:1 holder, no placeholder
   fallback); **0057** — the season progress bar is present & ≤5px & spans the viewport without
   horizontal overflow, the "Season N" chip reads past season 1 inside the viewport, and the
   post-season "New season" kit window mounts in-view (keep + recast). Vault-free routed
   projections only; whole suite green locally + CI.
7. ✅ **A11 — DONE (ops-render-checks lane).** onnxruntime cpuset log noise: documented in
   `deploy/README.md` as expected-and-ignorable, and `orwell-doctor.sh` filters the exact benign
   line out of its failing-unit journal tail (see the A11 entry above).
8. **Postgres + pgvector** → reclassified under **MVP-002** (see below).

### MVP-002 — post-launch scale-out (milestone)

A deliberate **second-wave** milestone for infrastructure that only earns its keep *beyond* the
single-container deploy — not blocking launch, filed here so it's a planned wave rather than a vague
"someday". (2026-06-20.)

- **Postgres + pgvector** — the relational/vector storage tier behind the existing `UserSaveStore`
  and engine-only `VectorIndex` ports. A clean adapter swap (no domain/engine change; Vault-walled by
  dependency-cruiser exactly like the SQLite adapter). SQLite + sqlite-vec already shipped **opt-in**
  (#330, `ORWELL_STORE=sqlite`) and are sufficient for *one container per host, one game per user*.
  Postgres buys what SQLite does not: **multi-instance shared state, a managed cloud database, heavier
  concurrent write throughput, and replication / point-in-time recovery** — i.e. it matters only when
  Orwell scales past a single host. No gameplay impact.

## 2026-06-20 — ADR 0005: split authority by openness (the dynamism guard) — MERGED

**#355 — ADR 0005 + the generative-consequence path + the expressive-non-collapse gate.** A new
design principle and its first implementation, shipped end to end. Captures the constraint that
keeps the growing LLM↔engine **sync spine** from flattening creative play: **authority is split by
*openness*, not by *layer*.** The **closed set** (outcomes, eligibility, state truth, persistence,
the Vault) is engine-dictated and may be as strict as it likes — there is *no dynamism to lose*.
The **open set** (the meaning/texture/consequence of social play) is recorded faithfully and never
*normalized* — the engine may not collapse an open-ended utterance into a closed bucket in a way
that changes what can be narrated or played next.

- **Built, not just stated** — `recordInteraction` / the 0023 `ConsequenceEngine` now take an
  optional, Vault-free `consequence` descriptor (`{ toward, direction, emphasis? }` + `rationale`):
  the model proposes the *shape*; the engine still owns the bounded, seeded *magnitude*
  (`emphasis`→a clamped 0.6/1.0/1.4 multiplier — no raw number crosses; mandate #3 holds). `kind`
  stays the floor (no descriptor ⇒ byte-identical fold). The MCP boundary shape-guards a malformed
  descriptor (clean 400, E31/D10/R6 pattern); the FE schema/client forward it and the 0055
  `_auto_record_scene` can propose one.
- **A new permanent regression gate** joins richness + the Vault sentinel:
  `tests/unit/expressiveNonCollapse.test.ts` (lossless record / consequenced-not-dropped /
  recalled-in-full / distinguishable-downstream) + `frontend/tests/test_expressive_non_collapse.py`
  (no rail-correction of creative prose). The desync guard's WINNER/NEW-HOH branches were
  phase-scoped so a creative claim can't trip a board-outcome rail-correction.
- Documented in **[ADR 0005](../decisions/0005-split-authority-by-openness.md)** (now *Accepted —
  BUILT*) and folded into the `docs/decisions/` index + the `docs/features/README.md` amendments
  table (under 0023/0055).

This **does not** close any item in the forward backlog above (calibration tuning, 0062, 0022,
the real-host smoke, R3, the browser-render validations, A11, MVP-002 remain exactly as listed) —
it is a *new* refinement record plus its implementation. Its standing claim is the **litmus test**
in the ADR: any future sync or consequence change must keep the open set recordable,
consequenceable, recallable, and narratable in full while only ever constraining the closed set.

## 2026-06-20/21 — live-LLM walkthrough audit (casting → weeks 1–2) — fixes MERGED + open log

Pre-launch end-to-end pass driving the **real FE + real engine + a real LLM** (`deepseek-v4-pro`
via OpenRouter) under headless Playwright — the path the automated gates structurally can't exercise
(they stub the LLM). Drove casting → premiere → **week 1 (player won HOH) → week 2 (player nominated,
veto not won, player EVICTED pre-jury)**. Per the owner directive, **every** observation is logged
below (fixed + open + minor), no matter how small. Most are rooted in the documented
**model-under-calls-progression-tools** failure class.

- **#411** (State-1 UX) — themed the casting/headshot file input; silenced dropped voice-probe 404s. *MERGED.*
- **#415** (game-start / premiere) — casting framing tells the model the **headshot is on file** so it
  finalizes; **`createCharacter` finalize fallback** + premiere **`markHouseguestMet` auto-belt**. *MERGED.*
- **#420** (staged-comp pacing, owner ruling) — **fewer/bigger rounds** (`STAGED_TARGET_ROUNDS`, ~4–8/comp
  vs ~14) + **only round 1 binds** (`binding` flag; later rounds non-binding flavor). Presentation-only;
  `stagedTrajectoryNeutral` + UAT green. *MERGED.*
- **#434** (decision-card arming) — a **silent forced-advance** (FE error-correction when the model
  under-calls `advanceGame`) progressed the engine onto a new player pending but armed **no card** in the
  open page (only a reload did). Fix: arm from `gameStatus` at turn-end + don't let a lingering "✓ Locked
  in" card suppress the next round. *MERGED.* **Live-verified:** a complete week 1 (HOH crown → noms →
  veto comp → veto ceremony/replacement → eviction → week 2) ran with **0 page errors** and no board desync.

### Complete issue log (LW = live-walkthrough; every observation)

**Fixed + merged this session:**
- **LW1** [#411] Unstyled native OS file input on the casting/headshot gate + Settings profile picture.
- **LW2** [#411] Dropped voice-vertical 404s (`/api/stt/stats`, `/api/tts/stats`) on first paint under the game build.
- **LW3** [#415] Game wouldn't reliably START — the model under-called `createCharacter` (looped asking for a
  photo already on file). Fix: casting framing says the headshot is handled + a `createCharacter` finalize fallback.
- **LW4** [#415] Premiere meet-everyone progression (`markHouseguestMet` auto-belt) — defense-in-depth for under-callers.
- **LW5** [#420] Staged comp ran ~14 elimination rounds (slog). Fix: batched to ~4–8 (`STAGED_TARGET_ROUNDS`).
- **LW6** [#420] Per-round comp cards read as binding when only round 1 binds. Fix: `binding` flag + flavor presentation.
- **LW7** [#434] Decision card did NOT arm after a silent forced-advance — player stranded with no card (reload-only).
  Fix: arm from `gameStatus` at turn-end.
- **LW8** [#434] A lingering "✓ Locked in" (`.odec-done`) card suppressed the NEXT round's card during its 4s fade.
- **LW10** [FIXED this session] **Pre-jury player eviction now has a terminal hand-off.** A voted-out pre-jury player
  was left in limbo (status=`evicted`, `finished:false`) — the 0048 retrospective only fires on SEASON finish, so the
  evictee got only the model's prose and could nudge the house forward one week at a time (→ week 3) with no terminal
  signal (0046's *terminal recap*). Fix: a player-reachable **`POST /api/orwell/conclude-season`** (gated on
  player.status==`evicted`; a juror is NOT swept) drives the deterministic loop to the crown in ONE `advance_to_finale`
  call → the season reaches post-season → the existing retrospective (0048) + keep/recast hand-off (0057) fire; the FE
  shows a **"🚪 Evicted — your season is over · See how it ends"** surface (`orwellNewSeason.js`, reusing the post-season
  window). Tests: `test_lw10_conclude_season.py` (gating + idempotency) + live-verified (surface renders, button POSTs).

**Verified CLEAR (checked live — not defects):**
- **LW13** ✅ CLEAR. Reasoning renders in the collapsed "View thinking process" accordion (by design); the
  eviction-narration message **bodies were clean** (no reasoning leak). F8 (#435) holds; 0 page errors.
- **LW14** ✅ CLEAR. An evicted (pre-jury) player is offered **no decision card** (confirmed live — card is `None`).
- **LW16/LW17** ✅ CLEAR (were fast-forward artifacts). At season finish `/api/orwell/state` reports `moment ==
  "post-season"`, so the retrospective + new-season surfaces gate correctly; the earlier `visible:false` reads were the
  OrwellWindow-kit offsetParent quirk (the windows render + are interactive), not a gate failure.
- **LW18** ✅ CLEAR (test error). `next-season` honors `body.keep` correctly; an earlier curl sent `keepCharacter`
  (wrong field) so `keep` defaulted true. The full **finished → next-season → SEASON 2 (fresh 16-cast, player active,
  premiere)** transition was driven end to end (HTTP 200) — "continue into the next season" achieved.

- **LW12** ✅ CLEAR (by design). The premiere "Welcome to the house — premiere week" guide
  (`orwellPremiereTutorial.js`) gates on **week === 1** (the premiere *week*), not the premiere phase — so it
  intentionally spans the HOH phase in week 1, is dismissible ("Got it", per-user persisted), and auto-hides in
  week 2+ / post-season. It is a premiere-*week* guide, not a phase banner; the "lingers into HOH" read conflated
  phase with week.

**Still to verify:**
- **LW15** [verify · pacing] Staged rounds still depend on the model advancing (or the L39b forced belt) each round;
  weeks 1–2 completed acceptably with #420's fewer rounds — keep an eye on it over longer runs.

**Carry-forward open items (lower priority):**
- **LW9** [MITIGATED this session] stale model PROSE during a staged comp — it narrated a STALE, larger still-in set
  from its own history ("ten still in" when the engine had 7). Root: the live still-in *is* given each turn (the
  comp-round pending prompt + the `_pending_barrier_directive` quote it), but the model overrode it with memory.
  Mitigation (FE, `routes/chat_helpers.py`): the barrier now surfaces the engine's CURRENT still-in set as an
  EXPLICIT, prominent fact — "still in this round are EXACTLY these N: … anyone you named earlier who is NOT on this
  list has been eliminated; voice ONLY this set" — directly countering the stale-history failure. Tests in
  `test_pending_barrier.py` (grounding present for comp-round, absent for non-comp). *Prompt-grounding, not a
  guarantee: a non-compliant model could still drift — can't be fully gate-verified (no real-LLM in the gates).*
- **LW11** → **moved to the PO list as PO-1** (eviction-night length — a product-owner judgment call: batch/trim
  the staged secret-ballot reveal like the comps, or keep the core drama). See "Product-owner decisions PENDING
  (PO list)" near the top of this ledger.

## 2026-07-05 — audit-closure fan-out (the 2026-07-03 final-pre-ship audit): 18 fixes MERGED

The `docs/audits/2026-07-03-final-pre-ship-audit/` campaign (per-lane findings across deploy-ops,
doc-drift, test-gaps, settings-admin, security, plus the deep-play/UX/social/narration/consistency
lanes) fanned out a ×10 parallel dispatch plus eight earlier same-day merges. Every item below is
**DONE** on `main`, with its verifying artifact — recorded here per this ledger's own convention (a
merged fix is closed out with a citation, not left as a dangling PR number).

**The ×10 fan-out:**
- **#1198** [fe-unit flake] — isolate the per-worker pytest DB so `pytest-xdist` workers stop
  silently converging on one shared sqlite file (the `DATABASE_URL` `setdefault` was a no-op in
  every worker subprocess, since the controller sets it before workers fork). Root cause of the
  intermittent `fe-unit` red on `test_null_owner_endpoint_*`/reaper siblings. **DONE** —
  `frontend/tests/conftest.py`.
- **#1199** [welcome-card] — the premiere "Welcome to the house" guide card gated on `week === 1`,
  so it kept rendering through the ENTIRE week-1 chain (HOH → noms → veto → ceremony → eviction),
  not just the meet-everyone gate — corroborated 4× in the source audit (DEEP-23, TRANS-1,
  RESP-2/7/23, FLOW-10). Now gates on the engine's own `moment === "premiere"`, which flips off the
  instant the gate completes. **DONE** — `frontend/static/js/orwellPremiereTutorial.js`,
  `frontend/tests/test_l31_premiere_tutorial.py`. Amends feature 0050.
- **#1200** [ceremony-runway, J-3] — the FE pacing belts were fighting the social-runway holds they
  exist to protect: the forced-`tool_choice` gate read the raw engine phase and force-advanced
  straight past the social-runway HOLD and the witnessed-ceremony re-frame; separately, the
  runway/stall-nudge regexes false-positived on ordinary BB scheming language ("nominate"/"noms", a
  bare "next", "continue", "proceed"). Both tightened FE-side only — no engine advance logic
  touched. **DONE** — `frontend/routes/chat_helpers.py`, `frontend/src/agent_loop.py`,
  `frontend/tests/test_tool_choice_force.py`.
- **#1201** [ceremony-anim, TRANS-12/VM-5] — ceremony-beat outcome rows (HOH crown, nomination
  reveal, veto result, eviction vote) swapped in via a raw `innerHTML` replace with zero motion —
  the show's biggest set-piece beats landed as a silent instant flip. Now tagged
  `ow-ceremony-reveal` with a staged fade/settle entrance on the shared kit easing;
  `prefers-reduced-motion` strips back to the original instant swap. **DONE** —
  `frontend/static/js/chat.js`, `frontend/static/style.css`,
  `frontend/tests/test_transient_ceremony_reveal.py`.
- **#1202** [diary-invite] — activated the dead 0013 §5 producer Diary-Room invite trigger (PG-14 /
  PS-4). **DONE** — `frontend/routes/chat_helpers.py`, `src/engine/diaryRoom.ts`,
  `src/adapters/engine/GameSessionAdapter.ts`, `src/ports/GameSession.ts`,
  `frontend/tests/test_diary_room_producer_invite.py`, `tests/unit/diaryRoom.test.ts`. Amends
  feature 0013.
- **#1203** [storyFacts, SOC-1/4] — the player's pathway-surfaced facts (0002 knowledge propagation)
  weren't being delivered to the narrator every turn, so the model could contradict what the
  engine had already surfaced to the player. **DONE** — `src/adapters/engine/GameSessionAdapter.ts`,
  `src/engine/momentPrompts.ts`, `tests/unit/surfacedFactsDelivery.test.ts`.
- **#1204** [sqlite-vec, PERSIST-7] — the `ORWELL_STORE=sqlite` opt-in tier's vector recall index
  was never persisted/reloaded across an engine restart, silently resetting semantic recall to cold
  on every reboot — a mandate-4 (non-degradation) violation on the one tier meant for a real
  multi-user deploy. **DONE** — `src/adapters/engine/SoulStore.ts`,
  `src/adapters/sqlite/SqliteVectorIndex.ts`, `src/composition/engineRoot.ts`,
  `tests/unit/sqliteVectorIndex.test.ts`.
- **#1205** [npc-voice, I6 distinct-voices] — the per-NPC 0084/0090 voice fingerprint wasn't
  reaching the per-turn roster the narrator reads, so voices sounded flatter/more uniform in
  practice than the built voice system intended. **DONE** —
  `src/adapters/engine/GameSessionAdapter.ts`, `src/engine/momentPrompts.ts`, `src/engine/voice.ts`,
  `src/ports/GameSession.ts`, `tests/unit/rosterVoiceFingerprint.test.ts`.
- **#1206** [ritual-language, BB-nerd audit] — added ceremony ritual-language cues (the genre's
  formal phrasing conventions at HOH/nomination/veto/eviction beats) to the moment-prompt layer.
  **DONE** — `src/engine/momentPrompts.ts`, `tests/unit/ceremonyRitualLanguage.test.ts`.
- **#1207** [responsive tap-target, RESP-4] — the icon-only settings-sidebar collapse chevron
  rendered ~41.5px wide at the tablet-820 coarse-pointer tier, under the WCAG 2.5.5 44px floor the
  responsive matrix enforces (the existing coarse-pointer rule floored button HEIGHT but not
  icon-only WIDTH). **DONE** — `frontend/static/css/responsive-tokens.css` (verified clean by
  `frontend/scripts/responsive_matrix.py`).

**Six earlier same-day merges (also from the 2026-07-03 audit):**
- **#1186** [checkpoint, PERSIST-8] — the 0031 fail-closed non-degradation checkpoint's
  `toGameState` projection predated features 0058–0107 and never verified ~a dozen newer,
  genuinely-accumulating `SessionCore` dimensions (deals, deep profiles, confidences,
  secrets-as-power, nomination history, texture overrides, seeded-tie surfacing…) — exactly where
  mandate #4 is supposed to be strongest. Adds `sessionCoreCounts`/`sessionCoreCountsNonDecreasing`/
  `sessionCoreIsSuperset` (append-only ⇒ id/subset presence; monotonic accumulators ⇒
  non-decreasing), wired into `Orchestrator.checkpoint` beside the existing 0007 check. **DONE** —
  `src/composition/orchestrator.ts`, `src/engine/sessionSnapshot.ts`,
  `tests/unit/sessionCoreCheckpointCoverage.test.ts`. Amends feature 0031/0007.
- **#1188** [offense P1, about-edges consequence] — extends the ADR 0005 generative-consequence
  descriptor (feature 0023/0055 — the model proposes shape, the engine keeps the bounded seeded
  magnitude) to **third-party edges**: the player can now pitch a consequence that lands on an
  edge *between two NPCs*, not just their own — a first playable-offense lever (turning the house
  against a rival by proxy) rather than only reactive/self-facing folds. **DONE** —
  `frontend/src/agent_loop.py`, `frontend/src/tool_schemas.py`,
  `frontend/tests/test_0005_generative_consequence.py`,
  `src/adapters/engine/EngineCommandsAdapter.ts`, `src/adapters/mcp/McpServer.ts`,
  `src/engine/consequence.ts`, `src/engine/relationshipConstants.ts`,
  `src/ports/EngineCommands.ts`, `src/surfaces/tools/registry.ts`,
  `tests/unit/thirdPartyConsequence.test.ts`. Amends feature 0023/0055 (ADR 0005).
- **#1189** [gossip distortion, SG-6] — 0002/0038's gossip diffusion previously only decayed
  *confidence* on each retelling; the belief's *content* itself never actually distorted, so a
  rumor a player heard third-hand was suspiciously as accurate as the original — undermining the
  "distorted belief with a source + confidence" model CLAUDE.md's event/visibility section
  describes. Diffusion now genuinely mutates the propagated belief (not just its confidence).
  **DONE** — `src/engine/gossip.ts`, `tests/unit/gossipDistortion.test.ts`. Amends feature
  0002/0038.
- **#1190** [embedding guard, PERSIST-1/PERSIST-4] — a fail-safe dimension guard + a live provider
  pin for the embedding/vector layer (ADR 0004): guards against a silent dimension mismatch (e.g. a
  provider/model swap mid-season corrupting recall) and pins the provider actually used per save so
  a later provider change can't silently misinterpret old vectors. **DONE** —
  `src/adapters/engine/SoulStore.ts`, `src/adapters/inmemory/InMemoryVectorIndex.ts`,
  `src/adapters/sqlite/SqliteVectorIndex.ts`, `src/composition/engineRoot.ts`,
  `src/ports/VectorIndex.ts`, `tests/unit/embeddingPinAndDimGuard.test.ts`. Amends ADR 0004 /
  feature 0024.
- **#1191** [endgame reveal, ENDGAME-4/BB-14] — two missing BB set-piece PRESENTATION beats (pure
  staging over already-decided outcomes — no roll/vote/calibration touched): the post-season prompt
  framed a champion and runner-up identically (no distinct WINNER moment); the weekly HOH-room
  reveal (a recurring BB staple — the house watching who wins the coveted suite) was missing.
  **DONE** — `src/engine/momentPrompts.ts`, `tests/unit/endgameWinnerMomentNeutral.test.ts`,
  `tests/unit/hohRoomReveal.test.ts`. Amends feature 0045/0049.
- **#1195** [house-events] — the ambient house-event pool (the daily-event invariant's
  between-ceremony texture) was **dead code for every real game**: its record-gate checked
  `trigger === "player-turn"`, a value the real commit path never sends (the R5/E57 debounce
  refactor renamed it to `"offscreen-tick"` without updating this gate) — so 100% of the
  `house-event` texture a live player ever saw was ceremony boilerplate. Re-gated on
  `trigger !== "audit"` (fires on the real production trigger) and deepened the pool. **DONE** —
  `src/composition/orchestrator.ts`, `src/engine/houseEvents.ts`, `tests/unit/houseEvents.test.ts`,
  `tests/unit/orchestrator.test.ts`, `tests/unit/stateDelta.test.ts`. Amends feature 0008/0070.

**Two additional Wave-C merges (same campaign, UX/a11y lanes):**
- **#1192** [a11y, Wave-C] — fixed the measured WCAG contrast failures (decision-card risk badge
  ~2.25:1 → ~5.2:1; the disabled "Confirm — this is binding" button ~1.74:1 → ~4.95:1, now opaque
  rather than opacity-based) and keyboard/focus/AT gaps (a decision card's `aria-label` didn't
  actually include the risk-badge text despite its own comment claiming it did; a non-interactive
  `<span>` welcome-screen trigger) found by the ux-content-a11y / ux-visual-motion / ux-interaction
  lanes. **DONE** — `frontend/static/index.html`, `frontend/static/js/{chat,models,orwellDecision,
  orwellHeadshot}.js`, `frontend/static/style.css`, `frontend/tests/test_wavec_a11y_contrast_focus.py`.
- **#1193** [offense P4] — `confide`/`exposeSecret`/`tradeSecret` (features 0075/0093/0099) were
  fully built, wired engine tools but fired **near-never in real play**: `exposeSecret`/`tradeSecret`
  were advertised in the model-facing schema and game-build allow-list, but `tool_execution.py`'s
  dispatcher had no branch for either name — every model-driven call fell through to "Unknown tool
  type" (a dead wire, not just a discoverability gap). Added the FE wrappers/dispatch cases
  mirroring the working `confide` path end to end, plus the model-facing schema's missing
  `askKind` field on `tradeSecret`. **DONE** — `frontend/src/agent_loop.py`,
  `frontend/src/orwell_engine.py`, `frontend/src/tool_execution.py`,
  `frontend/src/tool_implementations.py`, `frontend/src/tool_schemas.py`,
  `frontend/tests/test_0093_0099_secret_verbs_onramp.py`. Closes the FE half of features
  0075/0093/0099.

**Still-OPEN tail (not this session's job to close; tracked here so nothing falls off the map):**
- **h2b/h2h3 CI real-fix** — in progress; the underlying test-harness/CI wiring work is not yet
  landed as of this entry. Do not mark done until its own verifying artifact lands.
- **Offense P2/P3 + the B2 dark-feature-activation flags** — owner-decision, in build. Offense
  P2/P3 extend the P1 (#1188, third-party edges) / P4 (#1193, FE on-ramp) work further; B2 is the
  `deploy-ops` lane's DEPLOY-1/DEPLOY-12 dark-flag-activation plan (five calibration-proven
  behavioral flags — `ORWELL_TRAJECTORIES`/`ORWELL_TRIGGERS`/`ORWELL_SECRET_PACING`/
  `ORWELL_JURY_HOUSE`/`ORWELL_SEEDED_TIE_SURFACING` — ship permanently dark; see
  `docs/audits/2026-07-03-final-pre-ship-audit/lanes/deploy-ops.md` DEPLOY-1/DEPLOY-12). Both are
  explicitly owner judgment calls, not agent work — do not auto-activate.
- **0010 Proxmox container smoke** — still needs a real host; owner action, unchanged from every
  prior ledger entry.
- **0108 (real-model golden-path gate)** — still spec-only; the structurally-right fix for the
  "every gate stubs the LLM" class of gap the `test-gaps` lane re-confirmed (TCG-1…TCG-31). Not
  started this session.

**Doc-reconciliation done alongside this fan-out (2026-07-05, doc-drift lane closure):** fixed the
0102/0107 spec-number collisions (the day-1-experience and LLM-call-observability drafts renamed to
**0111**/**0112**; content unchanged, see `docs/features/README.md`), corrected `CLAUDE.md`'s stale
"ADRs 0001–0014" table (now 0001–0016) and its last two "through 0109" mentions (now 0110),
corrected ADR 0012's status field (was bare "Proposed" while every downstream doc relied on it as
shipped), fixed the ship-gate's PARKED-bucket description of #905–909 (they have owner rulings, per
`PO-DECISIONS-LOG.md`'s 2026-06-27 entry — they're build-ready, not undecided), fixed
`docs/IMPLEMENTATION_QUEUE.md`'s self-contradiction (top banner said the D1–D11 batch was done, the
D1–D11 section header itself still said "OPEN"), and closed the README's stale 0075/0076 amendment
notes (the confide guardrail fast-follow shipped in PR #1088; the 0077 floor-plan 0076 was waiting
on has landed). `deploy/orwell-ready.sh`'s wrong front-end port fallback (8000, should be 8080 —
DEPLOY-7 in the deploy-ops lane) was also fixed, since a stock install was reliably reporting
"NOT READY" for a fully healthy front-end. GitHub issues **#862** and **#880** (0093/0099's
tracking issues, DOC-10) were **closed** — both were still `open` despite the underlying mechanics
being fully merged and BDD-gated since 2026-06-27.

## 2026-07-06 — closure session: 18 PRs MERGED (the remaining 2026-07-03 audit tail + the last spec-only builds)

A second, larger fan-out closing out almost everything the 2026-07-05 entry above still listed as
"still-OPEN tail" (h2b/h2h3, offense-P2/P3, the B2 dark-flag activation) plus the last three
spec-only feature files (0094/0095/0096), the redesigned daily recap (0102), and 0101 NPC
myth-making — plus a security/a11y/machinery-leak/engine-mandate-safety sweep from the remaining
2026-07-03 lanes. Every item below is **DONE** on `main`, verified via its own merge commit.

**Spec builds:**
- **#1217** [0102 daily recap] — the REDESIGNED daily "day in review" digest (PO ruling
  2026-06-27, #884; supersedes the originally-drafted weekly recap) ships engine-side: fires at
  the player's own bedtime (`turnIn`, ADR 0006), Vault-free, ends on an optional non-committal
  cliffhanger hook on its own dedicated side rng, never perturbs a seeded roll. New `dailyRecap`
  read tool (engine + MCP boundary). Also assessed 0103/0108 (stayed frozen/spec-only — see
  below). **DONE** — `src/ports/GameSession.ts`, `src/engine/liveSeason.ts`,
  `src/adapters/engine/GameSessionAdapter.ts`, `src/surfaces/tools/registry.ts`,
  `tests/unit/dailyRecap0102.test.ts` (13 cases). Updates `docs/features/README.md` 0102 row to
  Built.
- **#1226** [dailyRecap FE lever-drift fix] — 0102's engine tool shipped in #1217 but was never
  exposed through the FE tool layer, so `test_c13_lever_drift` failed (the prompt advertised a
  lever the agent couldn't call) — blocking `fe-unit` on every subsequent FE PR. Wired
  `dailyRecap` through the FE mirroring the sibling `seasonRecap`/`seasonRetrospective` read
  tools end to end. **DONE** — `frontend/src/{tool_schemas,agent_tools,orwell_engine,
  tool_execution,tool_implementations}.py`, `frontend/static/js/orwellToolBeats.js`.
- **#1221** [0101 NPC myth-making] — the player's notable public acts (HOH win, veto win/save,
  noms, finale win) seed gossip legends about themselves that spread, distort, and circle back
  ("people are saying you…") — a new *origin* for the existing 0002 diffusion, riding it
  wholesale (no new gossip system). Opt-in `ORWELL_MYTH_MAKING`, dedicated rng, folds **no
  edge at all** ⇒ calibration-neutral even while ON. Also re-verified 0097/0098 stay
  owner-frozen (untouched, not reopened). **DONE** — `src/engine/legends.ts`,
  `src/engine/gossip.ts`, `src/adapters/engine/GameSessionAdapter.ts`,
  `tests/unit/legends0101.test.ts`, BDD `0101-npc-myth-making.feature`.
- **#1228** [0094 (scoped) / 0095 / 0096] — closes the last three spec-only feature files:
  **0096 emergent nemesis** (pure `selectNemesis` elevates sustained player-directed threat into
  a felt antagonist, biasing the NPC's existing 0085 campaign + 0086 drive; Vault-safe `rivalry`
  tone hint only); **0095 pre-show ties as time-bombs** (a monotonic `sealed → surfaced-to-house
  → public` exposure state on 0059's seeded ties, an overhear pathway + the player-reachable
  `accuseTie` lever, direct witnesses take full `BETRAYAL_SHOCK`); **0094 distorted-gossip
  consequences, SCOPED** — shipped as a new dedicated `confront(npcId, factId)` lever (the
  `confide`/`accuseTie` sibling) rather than a retrofit of `nominate`/`vote`, because those hold
  a hard, calibration-load-bearing invariant ("whoever the player names IS the nominee/vote")
  that a bounded feature build should not touch — **flagged to the owner as a genuinely separate,
  larger design call** (see the owner-action tail below). All three opt-in/dedicated-rng ⇒
  calibration-neutral when off, proven by the heavy-sims suite. **DONE** —
  `src/engine/beliefReliability.ts`, `src/engine/tieReveal.ts`, `src/engine/campaigns.ts`,
  `tests/unit/{beliefReliability0094,confrontWiring0094,tieReveal0095,tieRevealWiring0095,
  nemesis0096,nemesisWiring0096}.test.ts`, BDD `009{4,5,6}-*.feature`.

**The former "still-OPEN tail" (now closed):**
- **#1216** [h2b/h2h3 CI-flake, the real fix] — the recurring #925/#1148/#930 onboarding-scrim
  flake's actual root cause: tests were racing the boot loader / onboarding card instead of
  deterministically waiting past them before opening Settings. **DONE** —
  `frontend/tests/conftest.py` + the affected browser tests.
- **#1211** [offense-P3] — unfreezes the player→NPC edge: every `recordInteraction` fold only
  ever moved the partner's opinion *of* the player, so `player→NPC` sat frozen at its move-in
  scatter all season under every mutual-bond gate (`formAlliance`/`joinAlliance`, blocs 0043).
  New `foldPlayerReciprocal` (`src/engine/consequence.ts`) reciprocates a bounded share
  (`RECIPROCAL_SHARE=0.5`) of the same engine-owned fold onto `player→partner` through the
  identical update rule (ADR 0002: engine computes both directions; no number crosses). Also
  fixes the `formAlliance`/`joinAlliance` dead-wire found in the same audit finding (SG-2).
  **DONE** — `src/engine/consequence.ts`, `src/engine/relationshipConstants.ts`,
  `src/adapters/engine/EngineCommandsAdapter.ts`, `tests/unit/playerReciprocalFold.test.ts`.
- **#1215** [offense-P2] — Phase 2 of "the player can play offense": a landed (never-backfired)
  player third-party pitch now earns a real, persistent, bounded `Campaign` the player owns
  (`advancePlayerCampaign` in `src/engine/campaigns.ts`, folded via
  `GameSessionAdapter.foldPlayerCampaignMove`), feeding the same `campaignTiltFor` mechanism an
  NPC's campaign uses — throttled to one progress-earning pitch per beat, excluded from the
  autonomous off-screen `campaignTick` (a self-caught bug: without the exclusion the player
  would earn free progress every turn regardless of whether they'd pitched anyone). **DONE** —
  `src/engine/campaigns.ts`, `src/engine/sessionSnapshot.ts`,
  `tests/unit/playerCampaign0085.test.ts` (442 lines).
- **#1213** [B2 dark-flags activation] — activates the tranche of built, calibration-neutral-
  when-off behavioral-fidelity layers that had shipped permanently dark: `ORWELL_TRAJECTORIES`
  (0087), `ORWELL_TRIGGERS` (0091), `ORWELL_SECRET_PACING` (0092), `ORWELL_JURY_HOUSE` (0100),
  `ORWELL_SEEDED_TIE_SURFACING` (0059 §5) now ON in the deploy installer alongside the
  already-shipped `ORWELL_CAMPAIGNS`/`ORWELL_COMP_INTENT`. Adds a non-Vault God-Mode dial
  (`setBehavioralFlags`/`getBehavioralFlags`, mirroring the ADR 0006 `setTimeOfDay` pattern;
  player channel cannot reach either tool) plus `/health` flag visibility + `orwell doctor`
  reporting. **DONE** — `src/adapters/engine/GameSessionAdapter.ts`,
  `tests/unit/behavioralFlagsToggle.test.ts`, `tests/unit/adminPlayerPartition.test.ts`,
  `tests/integration/httpServer.test.ts`, deploy installer changes.

**Engine/persistence/consistency hardening:**
- **#1212** [BE-101/102, BE-202, PERSIST-3/10/11/13] — `recordInteraction`'s `toward` (flat and
  inside the ADR-0005 consequence descriptor) bypassed the B39 living-houseguest check, letting
  a caller fold a relationship move onto an evicted juror or an invented id; now filtered against
  the same living set everywhere (`toward`, `edges[].toward`, `aboutEdges.holder`/`about`). An
  unrecognized consequence direction/emphasis indexed a lookup table with no fallback (crash or
  NaN into the permanent relationship layer); `foldGenerativeConsequence`/
  `foldThirdPartyConsequence` now skip unresolvable edges. FE outcome-claim detector was a single
  if/elif chain — a sentence matching an earlier category (usually eviction) skipped every later
  category's check even on a clean verdict; categories are now independently evaluated. **DONE**
  — `src/engine/consequence.ts`, `frontend/routes/chat_helpers.py`,
  `tests/unit/relationshipModel.test.ts`, `tests/unit/notorietyStoreCorruption.test.ts`,
  `tests/unit/opsHardening.test.ts`.
- **#1225** [engine-mandate-safety: COMP-6/BE-DEEP2-3, BE-6, PERSIST-12, BE-3/14/15, BE-5,
  BE-103/TCG-16, CON-6] — seven surgical fixes: house-event/trigger-eruption records hardcoded a
  single second witness instead of the true co-present set (now reuse the real awake/co-present
  room set); `EventStore.query()` fast-pathed to the full Vault-inclusive log on any unfiltered
  call (added `queryAll()` as the explicit engine-internal escape hatch; bare `query()` now
  requires ≥1 filter); `InMemoryVaultStore.writeHidden()` had no duplicate-id guard (now an
  idempotent upsert-by-id); the reserve-twist pool integrity + CAS/sync-spine parity checks; a
  `portDispatchCoverage` exhaustive `GameSession` method-list gate (TCG-16) that immediately
  caught a real port-surface drift (the new `dailyRecap` method) via compile error. **DONE** —
  various `src/` files, `tests/unit/portDispatchCoverage.test.ts`.
- **#1218** [A-S3/CON-11 consequence-fold-drop fix; PERSIST-5] — the FE's single-retry
  stale-409 reconcile (issue #591) was correct for ONE contested write, but under sustained
  two-window concurrency a SECOND consecutive stale-409 on a fold-bearing back-fill
  (`recordInteraction`/`makeDeal`/`confide`/`exposeSecret`/`tradeSecret`) still
  reconciled-and-DROPPED the call, silently evaporating a scene's only hidden-consequence fold
  (mandate #4). `_backfill_with_cas` now takes a `defer_fold` flag: a fold-bearing call that
  hits a double stale-409 is queued into a small bounded per-owner retry store and
  opportunistically retried on the owner's next back-fill (loss bounded to latency, never data;
  each retry re-attaches the freshest CAS token so it can never double-apply). `moveTo` keeps
  the old skip-and-rederive behavior deliberately (a stale location landing late would be wrong,
  not just late). Also fixes `/health`'s embeddings status being a one-time boot snapshot instead
  of live. **DONE** — `frontend/routes/chat_helpers.py`.
- **#1210** [ops/tracker] — the doc-reconciliation pass that closed out the 2026-07-05 fan-out
  (recorded in the entry above this one) — folded in here as the session's opening PR.

**Deploy/ops hygiene (DEPLOY-5/6/9/10/11/13/14/15/17):** **#1219** — stopped putting the LLM
install env on a `pct exec … bash -c "…"` argv (visible in host/container `ps`; now routed
through the same pct-push-a-temp-file mechanism as `GIT_TOKEN`); removed the installer's dead
"Anthropic API key" menu option (never consumed, silently discarded after being exposed); added
`orwell-backup.timer`/`.service` (daily, systemd) + retention pruning
(`ORWELL_BACKUP_RETENTION_DAYS`, default 30); `orwell-doctor.sh` now warns on high disk usage
and on a silent fastembed→deterministic embeddings fallback; added `deploy/logrotate/orwell`;
journald `SystemMaxUse=` cap. **DONE** — `deploy/`.

**FE HUD/gadget/decision/notice tail (2026-07-03 gadgets/social-game/ux-interaction/
api-slash-notify/transient-animation lanes):** **#1220** — first-week player-eviction badge no
longer suppressed mid-goodbye; nominee-holding-veto now shows both badges; a phase-conditional
eviction-night seat cue; veto-aftermath + `lastEviction` HUD rows; finale "Asking: …" during
questions; `orwellDeals`-pattern name resolution in the finale panel; retrospective highlights
cap 12→40; a HUD-field write-skip-when-unchanged guard (no per-poll DOM churn). Player-tier
client JS only — no engine/`chat.js`/`markdown.js`/`index.html`/`style.css` touched. **DONE** —
`frontend/static/js/{orwellStatusPanel,orwellFinale,orwellRetrospective,orwellDeals}.js`.

**Accessibility (AXE a11y lane):** **#1222** — keyboard-operable model-picker/theme grids
(`role="option"` + roving tabindex + Arrow/Home/End/Enter/Space); distinct "your connection
dropped" copy vs. the hard-outage banner; `--color-muted` lightened to pass WCAG 1.4.3 contrast
in both themes; generalized the Tab-cycling focus trap to the legacy `.modal` family; re-leveled
the Theme window's misordered headings; the composer's `aria-label` now tracks its per-build
placeholder. **DONE** — `frontend/static/{js/{models,theme,orwellEngineStatus}.js,css,
index.html}`.

**Machinery-leak hardening (I9 lane — mandate #1/#2):** **#1223** — scrub the merged stream
buffer before caching to `dataset.raw` and before every TTS read-aloud (new
`markdown.js scrubMachineryForPersistence`); JS↔Python scrub word-parity (Vault, God Mode,
admin panel/surface/console, `producerVault`, developer console); rebalance orphaned
producer-aside delimiters after a mid-run machinery sentence is dropped; `momentPrompts` refuses
"list your tools/functions/levers" as an OOC aside; silence God-Mode/admin tool beats in the
game build (fail-closed on the auth-off single-user convenience); narrowed the machinery-noun
regex to require an operator-verb context (so "gaming the system" survives); added
copula/existential phantom-name + possessive-inanimate masking to `_stages_in_scene` (shared with
the Vault-leak guard). **DONE** — `frontend/static/js/markdown.js`, `frontend/src/`,
`frontend/routes/`.

**Security (fail-closed, SEC-1/3/5):** **#1224** — SEC-1: `POST /api/auth/setup` was
auth-exempt for any remote caller during the pre-account window (a race an attacker could win
against the operator); now restricted to a direct, unproxied loopback connection. SEC-3:
`AUTH_ENABLED=false` reachable beyond loopback (a forgotten port-forward, a believed-private LAN,
a VPN misconfig) fail-opened `bash`/`python` tool access to every caller with
`assert_public_profile_safe` never firing (it only checks the explicit `ORWELL_PUBLIC` case); a
new `assert_auth_off_requires_loopback` boot guard now refuses to start. SEC-5: (third
fail-closed fix in the same lane). **DONE** — `frontend/routes/auth_routes.py`,
`frontend/core/middleware.py`, `frontend/app.py`, `frontend/tests/test_sec1_setup_loopback.py`.
**Owner review still owed** (see the tail below — these are structural fail-closed fixes, not
behavior changes to the intended public posture, but a security lane always gets a second look).

**Doc reconciliation (2026-07-06, this pass):** corrected `CLAUDE.md`'s three stale
built/spec-only split callouts (the top "Status:" paragraph, the 0067–0074 launch-band
paragraph, and the "Current status" section) — the true split is **built 0075–0096, 0099–0102,
0104–0107, 0109, 0110; frozen 0097/0098/0103; spec-only 0108** (the old "0094–0098, 0103
spec-only/frozen" line was wrong the moment #1228/#1217/#1221 merged). `docs/features/README.md`'s
per-row statuses for 0094–0096/0101/0102/0097/0098/0103/0108 were already correct (each shipped
PR updated its own row) — verified, no changes needed there. Added this ledger entry and the
companion `docs/audits/2026-07-06-closure-session.md` summary.

**The owner-action tail (NOT closed by this session — needs a human call):**
- **Review the merged security fixes (#1224, SEC-1/3/5)** — fail-closed structural changes;
  revertable if any operator posture assumption in them turns out wrong.
- **0094's narrowed scope** — whether `nominate`/`vote` should ever misfire on a distorted
  belief is a genuinely separate, larger design call (it touches the calibration-load-bearing
  closed-set decision spine) that this session deliberately did NOT build; `confront` covers the
  spec's confrontation mechanic without it.
- **0010 Proxmox on-host container smoke** — still needs a real host; unchanged from every prior
  ledger entry.
- **0108 (real-model golden-path gate)** — still spec-only; needs a real LLM endpoint to record
  the replay fixture. Not started this session.
- **Rotate the OpenRouter API key** that was exposed in chat during this session.
- **Deferred POLISH waves** (the ~200 Minor/Polish residual-audit items across microcopy,
  prompt-craft, engine-texture, FE-python-sync lanes in `docs/audits/2026-07-03-final-pre-ship-audit/`)
  — parked pending owner go-ahead; not this session's job.

## 2026-07-10 — doc reconciliation (what shipped since the 2026-07-06 tail)

Docs-only pass. The 2026-07-06 owner-action tail above (written before this work landed) is
superseded on two points, and several tracked open items closed between 2026-07-07 and 2026-07-10.

**Closed / shipped since 2026-07-06:**
- **0108 (real-model golden-path gate) — now BUILT (2026-07-07) + ARMED (2026-07-09).** The
  "still spec-only" line in the tail above was true at 2026-07-06 only; the record/replay seam +
  `golden-path` PR job + `golden-nightly` re-record shipped 2026-07-07, and the first real-model
  fixture was committed/regenerated (#1251) so the `golden-path` job replays it key-free and is
  blocking via `ci-gate`. (`docs/features/README.md` row 0108 is authoritative.)
- **Ship-gate F5 (realtime two-window mirror parity) — CLOSED + CI-gated (#1276, 2026-07-09).** The
  former #1 release blocker was briefly re-flagged RED (#1269) then fixed AND wired into `ci-gate`
  as a required check the same day. No longer a launch-blocker.
- **ADR-0010 token-economy #1 + #3 — DONE.** Per-class `max_tokens` runtime-editable
  (`frontend/src/token_policy.py`, `max_tokens_budget`) and `appliedMaxTokens`/`finishReason` in the
  token ledger (`frontend/src/orwell_token_ledger.py`). Still open: #2 (model-aware reasoning sizing)
  and #4 (`Continue ▸` in chat mode).
- **Real-time / real-world clock purge (#1282, 2026-07-10, PO ruling).** The wall-clock
  `GameWatcher`/`SystemClock` surface is **deleted, not disabled**; the house lives only on the
  player's play-clock (one bounded off-screen tick per committed turn, fixed-epoch `LogicalClock`).
  Feature 0035 (live off-screen life / running watcher) is **removed** as a consequence.
- **FE↔BE integration gap review (2026-07-07) — being executed via the M1–M4 build lanes.** The
  DOC-ONLY gap review `docs/audits/2026-07-07-fe-be-integration-gap-review.md` (findings A1–A11 seam
  bugs, plus the B "first five minutes look like television" and C "surface the invisible game" moves)
  is landing through the `frontend/tests/test_m{1,2,3,4}_*.py` lanes (dossier, memory wall, ceremony
  slates, room strip, speaker chips, decision faces, premiere strip, cold-open, etc.).
- **WebSocket Phase-1 transport — landed DORMANT (ADR 0017/0018).** The full Phase-1 stack merged
  behind `ORWELL_WS_TRANSPORT` (default off): #1283–#1287, #1293 + the poll-kill batches #1290/#1291/
  #1294. **Turn-on is Phase-2 and still OPEN.**
- **Apple-HIG audit (#694) + #660 window-kit migration + #738 Liquid-Glass batch — substantially
  shipped.** HIG: all findings bar F-CHROME-1 (#1270/#1271/#1278/#1279/#1280). #660: the game-build
  surface is on the OrwellWindow kit (Theme-window drag #1289 was the last game-build residual). #738:
  a large glass legibility/a11y batch merged incrementally (#1259–#1264, #1275, #1292); item-level tail
  tracked in issue #738.

**Still genuinely OPEN (accurately, as of 2026-07-10):**
- **A-S3 / #591** — the dropped-consequence-fold stale-409 class: #1218 (2026-07-06) added a bounded
  double-409 `defer_fold` retry store (the acute loss path), but the fuller `REFACTOR-ROADMAP.md`
  A-S3 rewrite remains post-launch open.
- **WS Phase-1 turn-on** — flip `ORWELL_WS_TRANSPORT` on + the live two-window verification cadence.
- **0111 / 0112** — in progress (being built now).
- **HIG F-CHROME-1 / full-workspace legacy `.modal-content` migration**, the #738 residual tail, and
  the ADR-0010 #2/#4 follow-ons.
- Everything the 2026-07-06 tail left open that a human still owns: the SEC-1/3/5 review, 0094's
  narrowed-scope design call, the 0010 Proxmox on-host smoke, the OpenRouter key rotation, and the
  deferred POLISH waves — plus the frozen/parked set (0097/0098/0103) and the deferred-by-design
  tier (Postgres+pgvector, ADR 0006 Phase-2).
