# 2026-06-26 — BB-Nerd-Auditor playtest: cross-artifact synthesis & fix ledger

**Inputs synthesized (3 artifacts × 6 parallel read-only auditors):**
- `docs/audits/2026-06-26-bb-nerd-auditor-live-playtest.md` — the live playtest (F1–F16).
- `orwell-debug-bundle.json` — the Vault-free operator bundle (health/config/logs/sessions/state).
- `orwell-producers-vault.json` — the sanctioned `producerVault` DEBUG unseal (hidden layer).
  *Removed from the working tree; the sealed export remains recoverable in git history:
  `git show 219ff1b:orwell-producers-vault.json`.*

**Auditor lenses:** source-triage (F1–F16 vs. current code), debug-bundle log/ops mining (DB-series),
Producer's-Vault hidden-layer guardian (PV-series + verdict), distributed-consistency/parity,
narration-fidelity, BB-canon social-game. All six cross-corroborated with **zero contradictions**.

> This doc is the authoritative consolidated ledger. Each row carries: still-real verdict, root cause,
> fix site (file:line), disjoint lane, live-verify flag, regression risk, and the GitHub issue / existing
> issue it maps to. The two BLOCKERs (F14, F16) each got two independent reads.

---

## Headline verdict

**The engine and the hidden layer are sound; the launch break is the player-surface narration seam.**

- **Anti-sycophancy held hard** — verified at both comps and votes. The Vault confirms the player's
  eviction vote was *overridden* in 4 of 9 weeks (player's lone Trent vote vs. the house's 11–1 Asher);
  the passive floater got 0 jury votes. The engine never hands the player a win.
- **Vault Wall holds** — the debug bundle is genuinely Vault-free (zero secret scores/targets/credentials;
  mandate #2 intact). The producerVault unseal is the only place hidden state appears, by design.
- **The hidden layer is RICH (mandate #1 + #4 substantially MET at the engine layer)** — 650 hidden
  entries across 13 content classes, all 15 NPCs carry 4–5 distinct secret threads, confessional volume
  tracks survival depth (winner 29 vs. week-1 evictee 3), a character's threat/ally targets *evolve*
  weekly as the house thins, relationships are directed/asymmetric (0 reverse-dups — #842 holds).
  Non-degradation is satisfied at the engine layer (numeric-edge round-trip proof still owed — see
  *Structural notes*).
- **The single highest-leverage fix:** the FE error-correction belts cover *progression* (`advanceGame`)
  and *recording* (`recordInteraction`) but have **no belt for "surface/voice an engine-raised beat the
  model skipped"** — neither a player decision card nor an NPC ceremony's narration. That one missing
  belt class is the root of **F14, F16, F8, and F12**. Debug-bundle metric corroboration: **0% tool-call
  rate** across all 15 sampled live turns (`tool_call_seen=False`, 8:1 reasoning:reply).

**Iron rule for every fix below:** the FE may *surface* a card and *drive an advance*, but must **never
resolve a player decision or author an outcome** — anti-sycophancy, secret ballot (E12), player goodbye
authorship (E34), and the Vault Wall all stay intact.

---

## Tier 1 — LAUNCH BLOCKERS

### F14 — every eviction wedges at the goodbye/vote gate  · **BLOCK** · issue: **NEW**
The engine correctly raises a player `goodbye-message` pending (`liveSeason.ts:1162`) — and an
`eviction-vote` pending before it (`:1441`) — and `advanceGame` correctly no-ops on any open player
pending (`liveSeason.ts:1368`; `GameSessionAdapter.ts:4338`). The model narrates "X evicted" with **no
mutating tool call**, so the card-dispatch seam (`chat.js:2605-2609`, fires only on `advanceGame`/
`submitDecision`) never fires, `orwell:gamechanged` never fires, and the only surfacing path left is the
15s JS poll (`orwellDecision.js:830`) — which is why the card appeared a full week late. The L39b
forced-advance (`agent_loop.py:~4936`) is structurally inert here (it calls `advanceGame`, which cannot
resolve a player decision — correct, by E34). **Two-pending wedge** (vote → goodbye), both un-surfaced.
- **Fix (Lane A):** a "surface-the-pending" belt in `agent_loop.py` (post-turn block ~`:4396-4420`): if
  `status.pending.by == player` and the model didn't `submitDecision` this turn, force-emit the stream
  signal that dispatches `orwell:pending` immediately (twin of the `markHouseguestMet` belt — it
  **surfaces**, never **resolves**). Lift the L39b gate so a forced advance may **drain NPC
  eviction-reveal beats** (deterministic, E12-anonymized) until the engine raises the player pending.
  After the card POSTs, drive one `advanceGame` to roll `goodbye → result → rollWeek`
  (`orwell_routes.py:917`). Secondary: drop `orwellDecision.js:830` poll cadence 15s→~2-3s or trigger off
  `turn-settled`. **Engine untouched.**
- **live-verify:** YES (gates stub the narrator; the under-call only manifests live).
- **risk:** must NOT auto-resolve the pending (anti-sycophancy + E34). The drain only walks existing
  anonymized reveal beats (secret ballot safe).

### F16 — model narrates the WRONG evictee / invents a tally · **BLOCK** · issue: **NEW**
GM narrated "the majority votes to evict **Trent** … Trent departing" while the engine was at
`phase:veto-competition, evicted:null`; the engine then tallied **Asher 11 / Trent 1** (Vault-confirmed)
and evicted Asher. **The wrong name is the player's own lone vote target** — a sycophantic reach the guard
must kill. Two independent root causes in the pre-emission outcome guard (`chat_helpers.py`):
1. **It is count-only / identity-blind.** Every eviction detector checks whether the `evicted` *count*
   moved (`_narration_claims_outcome:974`); **nothing compares the narrated name to
   `evictedNames`** — which is already built into the signature (`:844-847`) but unused for this. So once
   any eviction commits, naming the wrong evictee passes.
2. **The result/tally branch is phase-scoped to `eviction`** (`_CLAIM_EVICT_RESULT_RE`, `:996-998`,
   gated `_EVICTION_PHASES`), so it was blind at `veto-competition`. And `_CLAIM_EVICTED_RE` (`:904`)
   matches only "is/was/been evicted", missing "votes to evict X" / "X departing".
   Compounded by F14: with no engine eviction beat ever returned, the `_eviction_reveal_steer`
   (`agent_loop.py:1512`) never engages and the model freelances into the vacuum.
- **Fix (Lane B):** (a) broaden `_CLAIM_EVICTED_RE` to catch "votes to evict X / X departing / leaving /
  going home / majority to evict X"; (b) add an **identity check** — a result/tally claim *naming* an
  active houseguest not in the just-evicted delta (`after.evictedNames − before.evictedNames`) → HOLD +
  re-ground; (c) add an **ahead-of-phase** rule — any committed-eviction claim while `phase ∉
  _EVICTION_PHASES` is a phantom, HOLD it. Plus the F14 driver fix removes the vacuum. Framing nudge in
  `momentPrompts.ts` eviction fragment: a tally/evictee may be stated **only** from a literal
  `eviction-result` beat handed this turn — never "majority" as a prediction.
- **live-verify:** YES. **risk:** clamp must be closed-set-only (never scrub creative prose —
  `expressiveNonCollapse` stays the proof); gate the ahead-of-phase rule strictly so a real in-phase
  eviction is unaffected; the re-ground text must stay name-free/count-free until the engine commits
  (secret ballot).

---

## Tier 2 — POLISH (high) / soft-block on spirit

### F8 — nomination ceremony never narrated · **POLISH (high)** · issue: **NEW** (covers F12)
For an **NPC HOH** the engine emits one `nominations` beat and **self-advances the phase to
`veto-competition` in the same call** (`liveSeason.ts:1402`), so `momentForPhase` never selects the
(well-written) `nominations` fragment (`momentPrompts.ts:582-587`) and there is **no FE nomination
steer** (`"nominations"` ∉ the steered set at `agent_loop.py:5570`). Noms appear only in the HUD. The
player-HOH path is fine (raises a `nominations` pending). **F12** (eviction-night beats skipped — staged
reveal + goodbye) is **fully subsumed by F14**: both are implemented (`liveSeason.ts:1136-1163`) +
steered, and only fail to run because the sub-loop never advances.
- **Fix (Lane A/D):** generalize `_eviction_reveal_steer` into a **ceremony-narration belt** keyed on a
  just-resolved `nominations`/`veto-ceremony` beat ("voice THIS ceremony beat before any other scene");
  OR keep the moment on `nominations` one extra beat in `liveSeason.ts:1402` so the fragment surfaces.
- **live-verify:** YES. **risk:** keep noms the engine's (steer must not invent noms).

### F3 — archetypes told, not inferred · **POLISH** · issue: **NEW**
NPCs self-label their strategy on day-1 intros and the GM tells threats ("as a comp-beast, she's known
for…"), violating the "player forms their own reads" mandate. **Not a Vault breach** — archetype is a
public facet — but the load-bearing cause is *salience*: `momentPrompts.ts:791-792` builds every roster
line **leading** with `${archetype}, plays ${strategyStyle}` — the most prominent token is the exact
label the prose (`:246-251/543/557`) then forbids voicing ("don't think of the elephant"). The
observable facets (demeanor/look/background) are buried after it.
- **Fix (Lane C):** demote the archetype to a fenced **private voice cue** ("never said aloud"), lead the
  roster line with observable facets. Demote, don't remove (persona-consistency anchor needs it).
- **live-verify:** YES. **risk:** don't strip the label (regresses voice consistency); not Vault state.
- Related existing: #905/#916 (casting discover-don't-declare), #868 (per-archetype voice).

---

## Tier 3 — POLISH / NIT (player-facing)

### F2 — dead-end empty-response error UX · **POLISH** · issue: **NEW**
The true-empty branch surfaces a bare operator string (`agent_loop.py:3203`, "The model returned an empty
response…") with no in-game recourse for a non-technical player. The reasoning-channel re-emit branch
(FEPY-2) is correct and must stay. **Fix:** an in-character producer line + a `retry` SSE affordance
(reuse the `Continue ▸` pattern at `agent_loop.py:5612`). **live-verify:** no. **risk:** preserve the
reply/reasoning buffer split (`chat.js`).

### F13 — "Houseguest's Choice" chip not surfaced in the veto draw · **NIT** · issue: **NEW**
The engine **fully models HGC** — the chip is in the `veto-draw` beat content (`liveSeason.ts:613-624`)
and named in the moment prompt (`momentPrompts.ts:589-593`) — but when an NPC holds it the model
collapses the chip detail (narrates the seated six without voicing the special draw). **Fix (Lane D):**
strengthen the `veto-competition` fragment to always voice the chip draw as its own ritual beat;
optionally expose which seat held HGC in the `veto.players` projection. Vault-free public canon.

### F9 — post-decision pacing: out-of-band decision doesn't auto-advance · **NIT** · issue: **NEW**
After the player submits a comp-intent via the **decision-card POST** (out-of-band, not via the model),
`_decision_undelivered` (`agent_loop.py:4409`) only fires when the *model* called `submitDecision` this
turn, and the framed beat key `(week, phase, moment)` doesn't change mid-competition, so `_peer_advanced`
stays False and the `_ADVANCE_GRACE_TURNS=2` grace swallows the advance → one dead turn. **Fix (Lane A):**
include the `pending` descriptor in the framed beat key (`chat_helpers.py:2022`) so a resolved pending
flips peer-advance detection; ensure a resolved comp-intent drives one `advanceGame`. **risk:** idempotency
(0065 `idempotencyKey`) — don't double-advance.

### F5 — premiere house dispersed before the gather ritual · **NIT** · issue: **NEW**
The `premiere` prompt says "gather the whole house in the living room" (`momentPrompts.ts:526`) but there
is **no premiere gather projection** — the `houseEvent` whole-house block (`GameSession.ts:839-844`)
covers ceremonies but **not the premiere**, so `whereabouts` returns ordinary dispersed presence and the
model (told presence is ground truth) narrates a scattered house. Two ground-truths fight; presence wins.
**Fix (Lane D):** while `premiere` is active and the meet-everyone list is non-empty, project a
`houseEvent`-style gather (everyone in the living room) — reuse the existing ceremony-gather pattern;
release to normal dispersal after intros. Calibration-identical (observational projection only).
Related existing: #917/#906 (premiere-gate reframe).

### F10 — mild cast job clustering · **NIT** · issue: **NEW**
The **final** cast is fully diverse (15 distinct authored `vocation`s, capped `MAX_PER_VOCATION=2`,
`characterFactory.ts:319`). The "3 marketing / 2 firefighters" the auditor saw is the **uncapped legacy
`background`** line (`characterFactory.ts:309/667`, 14-item `OCCUPATIONS`) leaking before/instead of the
richer authored `vocation`. **Fix (Lane E):** voice `vocation` in the premiere roster context and suppress
the legacy occupation clause (preferred); or cap the `OCCUPATIONS` pick. **risk:** do NOT reorder the
`OCCUPATIONS` rng draw (byte-stability `:307`) — change only which field narration reads.

### F1 — duplicate onboarding gates · **POLISH** · issue: **NEW** (related: #874)
Two gates both framed "Production needs the feeds": `mountHolding` (`orwellOnboarding.js:818`) +
`mountSetup` (`:287/301`). **Fix (Lane F):** differentiate the copy or collapse one. #874 already proposes
removing the modal in the healthy case — coordinate.

---

## Tier 4 — LATENT / verify-only

- **F15 — roster not pruned · resolved-by-F14.** The `house[]` superset is by design (`GameSessionAdapter.ts:5569`,
  flagged `status: seatOf()` reading `evictionOrder`); eligibility reads `evictionOrder`, not array length
  (correct — Week-2 field was right). Stale only because nothing committed (F14). Optional additive POLISH:
  add an `activeCount` field to the `/state` projection + confirm the model's roster context lists evictees
  as gone. **Never prune the array** (backs the 0048 retrospective + grayscale cast pin).
- **F11 — veto narrated a beat early · NIT, self-resolving.** Narration-ahead-of-poll, not an ordering
  race; the veto-winner guard already verifies against `vetoHolder` and `orwell:gamechanged` converges the
  HUD. Optional: a beatSeq (0065) check to distinguish ahead-of-commit. No fix required.
- **F4 — own room listed twice · NOT REPRODUCIBLE on current source.** `HOUSE_SIGHTLINE` is irreflexive
  (`house.ts:66-80`); backend `nearby` and FE header/body render separately (`orwellPresence.js`). Likely
  fixed since the playtest build. Optional defensive: `nearby.filter(n => n.room !== w.room)`.
- **F6 — pre-game DOM carries "Season complete"/"Nightfall" · LATENT.** Panel is hidden pre-game
  (`orwellStatusPanel.js`), but the strings are baked into the static `innerHTML`. **Fix (Lane F):** render
  dynamically. issue: **NEW** (small).
- **F7 — owner=NULL endpoint unusable · LATENT** (was the auditor's own env artifact, but a real latent
  trap). `chat_routes.py` `_clear_orphaned_session_endpoint` → `owner_filter(include_shared=False)` treats a
  null-owner endpoint as removed → opaque 400. **Fix (Lane G):** stamp owner at registration or surface a
  clear diagnostic. **Merge with DB6/CP1** (orphan-session hygiene). **risk:** don't broaden `owner_filter`
  cross-user (isolation mandate). issue: **NEW**.

---

## Debug-bundle findings (DB-series — new, not in the playtest doc)

> The bundle is **genuinely Vault-free** (CRITICAL mandate-#2 check PASSED — zero secret
> scores/targets/credentials; provider keys masked).

- **DB1+DB2 — `/api/orwell/decision` returns HTTP 502 for a 400 client-validation error → retry storm ·
  POLISH (latent BLOCK at a real finale) · issue: NEW.** `orwell_routes.py:945` rewrites the engine's
  deliberate **400** ("a legal finale appeal is required", `GameSessionAdapter.ts:4901`) to a hardcoded
  **502**, which is in `_TRANSIENT_STATUSES` (`orwell_engine.py:135`) → signals "retry me" → a **60-call
  refused-POST storm in 5.5s** (`health.failed 512/6477`). **Fix:** propagate the engine's real status /
  map validation `EngineToolError` → 400; reserve 502 for genuine unreachability. Add a per-session
  debounce on rapidly-repeated identical failing decisions.
- **DB3 — cast-authoring token ledger logs `cap=0` · POLISH (ADR-0010 accuracy) · issue: NEW.**
  `orwell_cast_authoring.py:510` omits `applied_max_tokens=_max_tokens` in `record_turn`, so the meter
  reports `cap=0` though the cap was applied on the wire. **Fix:** pass `applied_max_tokens`.
- **DB4 — health `disk.usedPct` wildly wrong (reports 3.3%, actual 88.6%) · NIT · issue: NEW.**
  `admin_health_routes.py:399` derives `usedPct` from `du.used/du.total` while `freeMb` uses `du.free`
  (different block accounting on an overlay fs) — internally contradictory. **Fix:** `usedPct =
  round(100*(total-free)/total, 1)`.
- **DB5 — 0% tool-call rate on all sampled live turns · LATENT/metric (no separate fix).** The clean
  metric behind F8/F14 — corroborates the under-call class; a watch signal, folds into F14/F8.
- **DB6 — orphaned 0-message casting-shell sessions + session↔model mismatch · NIT.** Merge into the F7
  hygiene issue: reap `messageCount==0` shells; verify authoring spend keys to the canonical *game* session
  (gate reaping on not-canonical-id; never widen cross-user).
- **DB7 — providerConfig: no default endpoint surfaced, `supportsTools:null`, a `localhost.openrouter.ai`
  base URL · NIT/LATENT · issue: NEW.** Surface `isDefault`/`default_endpoint_id` + the resolved default in
  the bundle; populate `supportsTools` when known (a tool-less endpoint fails casting like F7). Loopback +
  masked keys — benign, noted under the 0071 URL-guard posture.
- **DB8 — `opsStatus.updateTriggerInstalled:false` (dev-expected; deploy A4/#0010 verify) + the finale
  storm evicted real history from the 200-line log ring · NIT.** Folds into DB1/DB2 (dedupe repeated
  warnings before the ring).

---

## Producer's-Vault findings (PV-series — new; hidden-layer quality)

> **Verdict: the hidden layer is rich and canon — NOT the biggest gap. The launch-blocker is the player
> surface (F14), not the Vault.** The items below are quality-of-richness, not absence.

- **PV1 — the player is invisible to off-screen NPC cognition · POLISH · issue: NEW.** Across all 650
  hidden entries the player appears exactly **once** (an auto-recorded casting line); **no** NPC ever names
  the player as a threat/ally/target in any confessional/whisper/strategy/alliance, though the player rode
  to Final 2. `richOffscreenStretch` (`offscreen.ts:130/177`) draws scene partners from `npcs` only; the
  player is structurally excluded as a *subject*. **Fix:** let an NPC name the player as a subject of an
  off-screen confessional/strategy beat, folding the existing NPC→player hidden edge — **never** as an
  initiator/witness, **never** surfaced except via a pathway. The difference between a house that schemes
  *around* the player and one that ignores them.
- **PV2 — gossip surfacing renders `(, muffled)`: empty source + flat confidence · POLISH ·
  REGRESSION → reopen #997.** All 36 `Surfacing` rows share the malformed `(, muffled)` prefix — empty
  source name, single hardcoded confidence band — though the belief model *computes* graded decaying
  confidence + provenance (`gossip.ts:173`). #997's `humanize.ts:194` `(?![:,])` carve-out (merged in
  #1008) is **insufficient**: the deeper cause is that `presence.ts:323` hardcodes the literal prefix and
  **never injects the source NPC name** in the first place — so even a perfect scrub yields `(, muffled)`.
  **Fix:** build the prefix from real belief state — `(${tellerName}, ${confidenceWord(confidence)})` with a
  graded vocabulary; add a `producerVaultRender` assertion that no row matches `/^\(\s*,/` and that >1
  confidence word appears across a multi-hop season.
- **PV3 — deterministic confessional floor is templated (57% identical shell) · POLISH · related #866/#868.**
  113/198 confessionals are the byte-identical "I need X gone — they're my biggest threat. Y is the one I
  actually trust." — the **engine floor** exposed during the model-free fast-forward (live, the LLM voices
  these; ADR-0003 bargain). Distinct *content* (targets evolve), flat *phrasing*. **Fix:** widen the shell
  pool keyed on archetype/emotional-arc (calibration-neutral, prose-only), and/or tag confessionals with
  the source secret thread so the live model has richer material. Vault-safe; no numbers.
- **PV4 — `twists:[]` at the finale · NIT (likely correct) · verify-only.** Reserve twists are seeded-rare
  (≤1 armed/week); an empty array is plausibly "none armed this seed," not a serialize drop. **Verify:** a
  test seed that arms a twist asserts the dump's `twists` populates.
- **PV5 — late-week unanimous votes · no fix (methodology note).** W10–13 unanimity is a harness artifact
  (Tier-B fast-forward defaulted every NPC vote to the first option); the live W1 was a contested 7–6.
  Engine vote logic is sound. For future hidden-layer audits, drive late weeks with seeded NPC vote intent.
- **SG7 — finale per-juror jury-vote breakdown not persisted into the retrospective unseal schema ·
  LATENT · issue: NEW.** The export carries weekly secret `evictionVotes` + `winner`, but **no `juryVotes`
  block** — the finale per-juror votes are computed and revealed live (`liveSeason.ts:1282/1352`) yet not
  threaded into the 0048 retrospective. For a BB fan the finale vote breakdown is a core unsealing payoff.
  **Fix:** persist the finale `votes` (juror→finalist) into the season record + add a `juryVotes` block to
  the producerVault export, mirroring `evictionVotes`. Post-season only (jury votes are attributed by canon
  at the finale — the contrast to secret eviction ballots). Don't unseal weekly ballots in-season.

---

## Structural notes (for the implementers)

1. **The single belt class.** F14/F16/F8/F12 share one missing primitive: a belt that **surfaces or voices
   an engine-raised beat the model skipped** (a player decision card; an NPC ceremony's narration). Build it
   once (generalize `_eviction_reveal_steer` + add the pending-card surfacer) and four findings close. It
   **surfaces**, never **resolves** — the iron rule.
2. **The guard reasons over counts, never identities.** F16's root is that the pre-emission outcome guard
   verifies "did a fact move," never "is the *named* entity the right one." Making `_narration_claims_outcome`
   identity-aware (evictee name; and the already-present nominee `nomNames`/`activeNames`) is the
   highest-value structural hardening — it stops the read-replica asserting a *contradictory* closed-set
   fact, only a *premature* one.
3. **Live-verify is mandatory for the narration lane.** Every automated gate stubs the narrator
   (`DeterministicNarrator`/`EchoNarrativePort`), so F14/F16/F8/F3/F9/F13 fixes **cannot** be proven green by
   the suite alone — they need a real `deepseek-v4-pro` run driven into the eviction sub-loop (the structural
   unit tests against the guards give partial proof). Lanes A and B verify together.
4. **Numeric non-degradation proof still owed.** The producerVault dump is an event-log + thread + vote
   unseal, **not** the numeric Soul/relationship edge matrix. The behavioral evidence (evolving targets,
   survival-tracked volume) is strongly consistent with non-degradation, but a *hard* proof needs a
   save/reload round-trip diff of `SoulStore` — a separate verification task.

## Disjoint-lane parallelization map

| Lane | Files | Findings |
|---|---|---|
| **A — FE eviction driver / belts** (do first) | `frontend/src/agent_loop.py`, `frontend/static/js/orwellDecision.js`, `frontend/static/js/chat.js`, `frontend/routes/orwell_routes.py` | **F14**, F12, F15, F9, F2, F8(steer) |
| **B — FE outcome-guard hardening** | `frontend/routes/chat_helpers.py` | **F16**, F11 |
| **C — engine narration framing** | `src/engine/momentPrompts.ts` | F3 |
| **D — engine ceremony/premiere beats** | `src/engine/liveSeason.ts`, `src/engine/presence.ts`, `src/ports/GameSession.ts` | F8(beat), F13, F5 |
| **E — casting realism** | `src/engine/characterFactory.ts`, `frontend/src/orwell_cast_authoring.py` | F10, DB3 |
| **F — FE onboarding/HUD** | `orwellOnboarding.js`, `orwellStatusPanel.js`, `orwellNightStatus.js`, `orwellPresence.js` | F1, F6, F4(defensive) |
| **G — FE setup/ops robustness** | `frontend/routes/chat_routes.py`, `frontend/routes/orwell_routes.py`, `frontend/routes/admin_health_routes.py`, `auth_helpers.py` | F7, DB1+DB2, DB4, DB6, DB7 |
| **H — engine hidden-layer** | `src/engine/offscreen.ts`, `src/engine/confessionals.ts`, `src/engine/presence.ts`, `src/domain/humanize.ts`, the producerVault export | PV1, PV2(#997), PV3, PV4, SG7 |

Lanes A and B both touch the eviction sub-loop and both require the same live-LLM verification — verify them
together. Nothing here regresses a Verified-GOOD item provided the iron rule holds.
