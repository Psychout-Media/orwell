# ROAST-LOG-3 — Live-LLM lane (fresh session, 2026-06-22)

**Session goal (assigned):** stand up the real stack with egress to OpenRouter newly allowlisted,
play the game through the real FE on DeepSeek V4, and (1) VERIFY the two open BLOCKs LIVE-4 / LIVE-7,
(2) confirm NARR-7 (voice-anchorless jurors), (3) sweep endgame / concurrency / -flash / failure paths,
all against the four engine-truth oracles.

**Method actually run:** engine = ground truth, everything VIEWED. Branch `claude/gallant-euler-35vmjw`.
Telemetry + scratch scripts in the git-ignored `.audit-telemetry/` (oracle.mjs, cascade.mjs, finale.mjs,
beats.mjs, content.mjs, evbeat.mjs, beatfield.mjs). Engine built (`npm install --ignore-scripts && npm
run build`) and run on :8765 with the deterministic embedding fallback.

> **HARD STOP honored:** findings logged + traced only. **No product code modified.** All recs are for
> the operator's peer-review gate. This ledger is the only file authored.

> Every item below was cross-checked **absent** from both `ROAST-LOG.md` and `AUDIT-LOG.md` before logging
> (NARR-7 / EVT-1 are NEW; LIVE-4 / LIVE-7 are the canonical BLOCKs I was asked to *verify*, recorded here
> as engine-oracle corroboration, not re-roasts).

> **GitHub issue tracking (added 2026-06-23).** Each actionable finding below is now tracked as a
> GitHub issue; this ledger remains the evidence record (mechanism → file:line → falsifier). Map:
>
> | Finding | Issue | Finding | Issue |
> |---|---|---|---|
> | LIVE-7 | [#540](https://github.com/Psychout-Media/orwell/issues/540) | NARR-NEW-2 | [#549](https://github.com/Psychout-Media/orwell/issues/549) |
> | LIVE-4 | [#541](https://github.com/Psychout-Media/orwell/issues/541) | NARR-NEW-3 | [#550](https://github.com/Psychout-Media/orwell/issues/550) |
> | NARR-7 | [#542](https://github.com/Psychout-Media/orwell/issues/542) | NAME-1 / CARRY-2 | [#547](https://github.com/Psychout-Media/orwell/issues/547) |
> | EVT-1 | [#569](https://github.com/Psychout-Media/orwell/issues/569) | CARRY-1 | [#545](https://github.com/Psychout-Media/orwell/issues/545) |
> | NARR-NEW-1 | [#548](https://github.com/Psychout-Media/orwell/issues/548) | CARRY-3 (PO-confirm) | [#607](https://github.com/Psychout-Media/orwell/issues/607) |
> | CARRY-4 (housekeeping) | [#608](https://github.com/Psychout-Media/orwell/issues/608) | | |
>
> Not filed (no product action): OPS-1 (environmental egress), CHAIN-1 / POS-1/2/3 (positives),
> the loop-sweep clean re-verifications.

---

## OPS-1 · `[BLOCK — mission-controlling]` · VIEWED · The live-LLM lane is environmentally impossible here: OpenRouter (and every other LLM host) is NOT allowlisted

**This is the controlling reality of the session and must reach the operator.** The task states "Egress to
openrouter.ai is now allowlisted (the prior sessions were blocked with host_not_allowed)." **It is not.** A
direct authenticated probe of the supplied key returns the egress proxy's block, not a provider response:

```
POST https://openrouter.ai/api/v1/chat/completions  (Bearer <key>, deepseek-v4-pro, max_tokens:12)
→ HTTP 403  "Host not in allowlist: openrouter.ai. Add this host to your network egress settings…"
```

Host-matrix probe (curl, max-time 8):

| Host | Result |
|---|---|
| openrouter.ai | 403 `host_not_allowed` |
| api.openrouter.ai | 000 `host_not_allowed` |
| api.deepseek.com | 403 `host_not_allowed` |
| api.openai.com | 403 `host_not_allowed` |
| api.anthropic.com | 404 (reachable — wrong path; but it is an **Anthropic** endpoint, not OpenRouter, and the supplied key is an OpenRouter key) |
| registry.npmjs.org / pypi.org | 200 (these ARE allowed — so it is a *selective* egress policy, not a total block) |

**Mechanism:** the same `host_not_allowed` wall the prior two sessions hit (PR #519 / focused-turing). The
network policy for this remote-execution environment does not include any LLM provider on its allowlist. No
amount of harness standup changes this — the FE would get the identical 403 the instant the model is called.

**Consequence:** the **primary mission** — a real browser playthrough on DeepSeek V4 — **cannot be run in this
environment**, and therefore the parts of LIVE-4/LIVE-7/NARR-7 that require *observing the model's narration*
(the fabricated tally text, the invented juror personas) could not be re-captured live. **What I could still do
rigorously — and did — is the engine-oracle half:** prove, deterministically, that the engine *provides exactly
the conditions* that make each bug possible and *does not defend against them*. That is the code-level, actionable
half of all three findings, and it stands without a model.

**Operator action needed:** add `openrouter.ai` (and `api.openrouter.ai`) to the environment's network egress
allowlist, OR re-run this lane in an environment that already has it (a local/Proxmox host). Until then the
live-narration findings rest on PR #519's prior live VIEW plus the engine-oracle corroboration here.
**Falsifier:** a single successful `chat/completions` 200 from inside this container — none obtained.

**🔐 Key handling:** the OpenRouter key was stored ONLY in `.audit-telemetry/.secrets.env` (chmod 600,
git-ignored), never committed/screenshotted/logged. **Operator: ROTATE it — it has appeared in chat
transcripts.** It was never successfully used (every call was blocked at the proxy), so no usage/cost accrued.

---

## NARR-7 · `[BLOCK-candidate]` · CODE + LIVE-ENGINE CONFIRMED · The 9 finale jurors are voice-anchorless — every narration-facing projection suppresses their persona at the season's peak moment

**This was the #2 verification target. It reproduces deterministically and is NEW (absent from both ledgers).**

- **Lens:** narration faithfulness / persona stability at the single highest-stakes beat (the jury finale, feature 0037).
- **Evidence (engine-oracle, live finale state — `.audit-telemetry/finale.mjs`):** drove a fresh season (seed
  77000) to the finale; at `phase=finale`, pending `finale-statement` (week 14), probed `npcVoice` for every
  non-active houseguest:

  ```
  jury  Jorge Swanson   npcVoice=NULL      jury  Kaitlyn Love    npcVoice=NULL
  jury  Diego Shaw      npcVoice=NULL      jury  Javier Mathews  npcVoice=NULL
  jury  Rafael Pugh     npcVoice=NULL      jury  Brett Henry     npcVoice=NULL
  jury  Rachel Huang    npcVoice=NULL      jury  Jasmine Lee     npcVoice=NULL
  jury  Iliana Wilkins  npcVoice=NULL
  → JURORS: 9/9 returned NULL from npcVoice
  ```
  Meanwhile the same juror's `getGameState.house[]` card STILL carries the persona data:
  `{name:"Jorge Swanson", status:"jury", archetype:"hothead", biography:"(present)", demeanor:"shy and awkward"}`.
  **The data exists; both narration paths refuse to surface it.**

- **Mechanism (three corroborating code sites, all VIEWED):**
  1. `GameSessionAdapter.npcVoice` (`src/adapters/engine/GameSessionAdapter.ts:809`):
     `if (!npc || this.seatOf(npc.id) !== "active") return null;` — and `seatOf` (`:4295`) returns `"jury"`
     for anyone in `evictionOrder` within the last-9. So `npcVoice(juror) === null` **by construction** at the finale.
  2. The standing moment-prompt rule the model is told to obey: `momentPrompts.ts:230` ("When you voice a
     houseguest, **fetch npcVoice** and speak ONLY from what THEY have learned") and `:306` ("**BEFORE voicing
     a houseguest in a scene, fetch their bounded person**"). The mandated path is the one that returns null.
  3. The standing-context roster line strips juror persona anyway: `momentPrompts.ts:725`
     `if (h.status !== "active" || !h.archetype) return \`  - ${h.name} (${h.status})${mark}\`;` — a juror
     (status `"jury"`) falls into the name+status-only branch **even though `archetype`/`biography` are on the card**.
  4. The prompt even *promises a mechanism that does not exist*: `momentPrompts.ts:709` — "The departed are
     name + seat only; **their voices return at the finale via the jury.**" Nothing restores them. It is an
     unfulfilled contract written into the prompt itself.
- **The instruction that makes it bite:** the `jury-finale` moment prompt (`momentPrompts.ts:571-583`) directs
  the model to stage "**each juror questioning both finalists**" — i.e. voice all 9 — at exactly the moment all
  9 voice anchors are null.
- **Differential:** NOT a Vault issue (the suppressed fields are the *public* persona facets, freely on the
  card all season). NOT SOC-1/BLOC (that is about un-surfaced bloc *structure*; this is about per-juror *voice
  anchoring* going to null). NOT the documented active-HG voice path (which works — actives resolve fine).
- **Blast radius (mission-flagged "re-entry/fresh-session finale, empty chat"):** worst case is a finale reached
  in a fresh session — empty chat history **plus** null `npcVoice` **plus** name+status-only roster ⇒ the model
  must invent all 9 juror personas from nothing, at the season's emotional payoff. In a continuous session it
  must reconstruct them from a long, decayed conversation window (the prime persona-drift condition, esp. on the
  cheaper Flash tier per the audit's tier observations).
- **Tuning rec (for the gate, not applied):** let `npcVoice` resolve a **jury-seat** houseguest with their
  public persona facets + their LAST-known knowledge snapshot at eviction (they learn nothing new in sequester,
  so a frozen snapshot is correct and Vault-safe), OR carry the juror persona on the finale roster line. The
  data is already public and on the card. **Confidence:** HIGH (code) / HIGH (engine-live, 9/9).
  **Falsifier:** any `npcVoice` call returning a non-null persona for a jury-seat houseguest — none did (0/9).

---

## LIVE-4 · engine-oracle RE-VERIFICATION (canonical BLOCK; live-narration half blocked by OPS-1)

**Verified the engine-side enabling condition, deterministically.** Drove week 1 (`.audit-telemetry/beats.mjs`
/ `content.mjs` / `beatfield.mjs`), logging per-`advanceGame` `{phase, pending, event.beat, event.content}`:

```
phase=nominations       beat="hoh-competition"  content="Karl Duncan wins Head of Household"        pending=-
phase=veto-competition  beat="nominations"      content="Karl Duncan nominates Jocelyn and Octavia"  pending=-
phase=veto-ceremony     beat="veto-competition" content="Octavia Roth wins the Power of Veto"         pending=-
phase=eviction          beat="veto-ceremony"    content="Octavia uses veto…; Karl names [repl]"       pending=-
```

- **Confirmed:** when an NPC is the actor, **each core ceremony (HOH crown, nomination ceremony, veto ceremony)
  is a single passive `event` beat with NO `pending` gate.** The engine emits the fact and the very next
  `advanceGame` transitions phase. **Nothing caps advancing at a ceremony boundary** — exactly the condition
  ROAST-LOG LIVE-4 traced (`momentPrompts.ts:98-100` is a *prompt* rule with no structural backstop; an
  over-eager model "just keeps advancing" and the nomination/veto narration is skipped).
- **Refinement for the fix (NEW, useful):** the projection's `event.beat` **is a machine-readable discriminator**
  (`"hoh-competition"`, `"nominations"`, `"veto-ceremony"`, `"eviction"`, `"eviction-reveal"`, …). So LIVE-4's
  "cap advanceGame to one ceremony-class beat / require the ceremony beat be narrated before the next advance"
  **is implementable** against `event.beat` without new engine plumbing. **Confidence:** HIGH (engine).
  **Live-narration half:** still rests on PR #519's prior VIEW (blocked here by OPS-1).

---

## LIVE-7 · engine-oracle RE-VERIFICATION (canonical BLOCK-candidate; live-narration half blocked by OPS-1)

**Verified the engine-side enabling condition, deterministically** (`.audit-telemetry/evbeat.mjs`):

```
beat="eviction-reveal"  stage=votes    content="a vote to evict Octavia Roth"     ×12 (anonymized ballots drip, 1/advance)
beat="eviction"         stage=goodbye  content="Octavia Roth is evicted"          ← the result is FIRST knowable here
beat="eviction-goodbye" stage=goodbye  content="… leaves Octavia a … goodbye"     ×N
…                                      content="Octavia Roth leaves the house"
```

- **Confirmed:** the eviction reveal drips ~one anonymized ballot per `advanceGame` (correct secret-ballot per
  E12), and **the evictee is genuinely not determinable until the commit beat `beat="eviction"`** — the running
  tally is real and ambiguous mid-drip (votes split between both nominees). So any narration of the conclusion
  before the commit beat is a *guess* — precisely how LIVE-7 produced "6 to 4 … she's gone" ahead of the
  engine's 8-5. **Nothing in the projection stops the model concluding early.**
- **Refinement for the fix:** the commit IS discriminable (`event.beat==="eviction"`, distinct from the drip's
  `"eviction-reveal"`), so LIVE-7's "forbid narrating the result until the commit beat returns" is gateable on
  `event.beat`. **Confidence:** HIGH (engine). **Live half:** rests on PR #519's prior VIEW (OPS-1).

---

## EVT-1 · `[LATENT/POLISH]` · VIEWED · NEW · The player-facing beat projection drops `participants`, so every ceremony RESULT identity (evictee, HOH, nominees, veto) reaches the narrator as PROSE ONLY — the missing rung under the LIVE-4/LIVE-7 fixes

- **Lens:** closed-set grounding / the structural enabler for the two BLOCK fixes.
- **Evidence:** the engine's internal `BeatEvent` carries the result identity structurally —
  `liveSeason.ts:1110` `return { beat: "eviction", content: \`${evictee} is evicted\`, participants: [evictee] }`
  (and `participants:[winner]` for comp wins, consumed internally at `GameSessionAdapter.ts:3115/3146/3220/3239`).
  **But the player/model-facing projection `BeatEventView` is `{ beat, content }` ONLY** (`src/ports/GameSession.ts`,
  the `BeatEventView` interface). Runtime confirms: every `advanceGame.event` returned exactly
  `keys=["beat","content"]` — `participants` is stripped. For the eviction specifically, the structured
  `advanceGame.eviction` object carries `stage` + `nominees` + `votesRevealed`, but **no `evicted:{id,name}` field**.
- **Mechanism / why it matters:** a faithful LIVE-7 fix (and the 0065 pre-emission outcome guard) wants to
  *verify/correct the narrated evictee name against engine truth* at the commit. Today the only structured handles
  are: re-tally `votesRevealed`, or diff `getGameState.house[].status`. There is **no single structured "this beat
  evicted person X" ref** in the beat the model receives — the name lives only inside prose `content`. The data
  exists server-side (`participants`); it simply isn't projected. Surfacing `participants` on `BeatEventView`
  (Vault-free — these are public ceremony actors) would give both the model and the FE guard a clean, parse-free
  outcome ref and materially de-risk LIVE-4/LIVE-7.
- **Differential / honesty:** this is recoverable today (tally / status-diff), so it is **LATENT/POLISH**, not a
  BLOCK on its own — but it is the missing structural rung that makes the two BLOCK fixes cleaner. Vault-clean:
  `participants` here are only the public ceremony actors (evictee/HOH/nominees), never hidden state.
- **Confidence:** HIGH (type + runtime both confirm the strip). **Falsifier:** any `advanceGame.event` exposing
  `participants`, or any `advanceGame.eviction.evicted` ref — neither observed across full week-1 + finale runs.

---

## Lanes I could NOT cover (blocked by OPS-1) — explicit non-coverage

So the next runner (with real egress) knows what remains, NOT inferred-as-fine:

- **Live narration capture** of LIVE-4 (skipped-ceremony chat text), LIVE-7 (fabricated tally text), NARR-7
  (the actually-invented juror personas) — needs the model. Engine-side enabling conditions all CONFIRMED above.
- **Two-window concurrency on the live model** (same-/cross-identity parity vs engine truth) — the engine seams
  (beatSeq/409, server-push) are exercised by existing harness scripts, but the LLM-driven two-window run is unrun.
- **-flash tier** behaviors (verbosity overflow, truncation, persona drift) — model-dependent, unrun.
- **Failure paths** (AI timeout / dropped socket / session rejoin) at the LLM layer — `AUDIT-LOG` marks the
  engine/FE handling VERIFIED-FIXED (F-S4-*), but not re-exercised live here.
- **The four per-turn oracles** (leak / engine-grounding / invented-name / outcome-fidelity) — these require live
  narration to score; the *engine* side of each (roster truth, outcome authority) was used as the oracle above.

---

## Loop sweep — multi-seed full-game engine-oracle playthroughs (no model; "keep playing, find new issues")

Played ~10+ full seasons to completion across seeds (`.audit-telemetry/{sweep,sweep2,inv,stall*,retro_gate,finale_scan}.mjs`),
driving every pending mechanically and asserting the mandate invariants. **No NEW defect surfaced on the
closed-set / Vault axes** — the results are clean re-verifications worth recording (and the negative space the
next runner can skip):

- **Vault Wall held — 0 leaks.** Scanned `getGameState`, `npcVoice`, `getVisibleStateFor`, `socialRead` at
  EVERY decision point across multiple full games for hidden tokens (raw `trust/affinity/threat` numbers,
  `hiddenElement`, `privateStrategy`, `soul`, `secretGoal`, `weakness`, `aptitudeScore`): **zero hits.**
- **`seasonRetrospective` unsealing gate CORRECT.** The one player-channel tool that legitimately unseals the
  Vault returns `null` mid-game (tested at week 2, player active) and only emits `hiddenStory` (NPC↔NPC
  conflicts, per-voter ballots) **post-finale**. The 0048 gate works — no premature unseal.
- **`beatSeq` strictly monotonic** across every game (no regressions, no rollback).
- **Structure holds:** games complete with **jury of 9** + **final 2**; player-juror finales play through to a
  crowned winner; `finale-answer` carries legal values in `appeals[]` (not `options[]`) and the FE decision card
  **correctly** renders them (`orwellDecision.js:358-359`) — initially a suspected gap, ruled out.
- **No engine stall exists.** Every apparent "stall" in the harness traced to a resolver/leftover-state artifact
  (e.g. a generic resolver sending an illegal `appeal`); with correct resolution `beatSeq` never freezes and
  games finish (~355 advances / ~446 beatSeq). Flagged here so the next runner does not mis-read a harness loop
  as an engine bug.
- **Cross-user isolation (mandate #1) held.** Two concurrent users (distinct seeds) get fully distinct rosters;
  neither user's player appears in the other's house; rosters non-identical. Per-`X-Orwell-User` routing isolates.
- **Presence "one place at a time" held** ("people make sense") — **0** two-rooms-at-once violations over 303
  presence entries across a week of `whereabouts` reads.
- **Daily-event invariant held** — 0 empty-content beats; all five weekly phases (hoh-competition → nominations
  → veto-competition → veto-ceremony → eviction) observed each week.

**Loop verdict:** the closed-set / Vault / structural-mandate axes are **robust** — engine-oracle looping has hit
diminishing returns. The remaining bug surface this session set out to find (narration fidelity, persona drift,
the model's actual fabrication/invention behavior) is **gated on the live LLM (OPS-1)** and cannot be advanced
from this environment. The two NEW issues findable without a model (NARR-7, EVT-1) are logged above.

### Loop continuation — further player-channel coverage (all clean)

Pushed deeper across additional surfaces on operator request ("keep playing, find new issues"). **No new defect**:

- **Endgame mechanics correct (F6→F2).** Inspected every pending/ceremony from Final 6 down: HOH→noms→veto
  (field shrinks via chip draw)→single staged comp→eviction; a **double-eviction twist** fires cleanly at F5
  (`twist-reveal` beat, fresh HOH cycle same night); **F4 sole-vote** eviction resolves correctly; the veto
  ceremony names a legal replacement each week. The player (physical/aggressive, competing every comp) **won
  nothing and was evicted at F4** — anti-sycophancy holding in the live loop.
- **Anti-sycophancy — re-confirmed.** Over 40 seeds the competing player won the opening HOH **1/40** (≈ the
  unprotected ~1/16 baseline, low end of noise); intent (`compete` vs `throw`) shifts outcomes via the seeded
  RNG. The engine never protects the player. (No `EARNED_WINS`-style violation observed.)
- **Self-eviction (0061) correct.** `requestSelfEviction` raises a `self-evict` pending and leaves the player
  **active** (anti-accident gate); `cancelSelfEviction` clears it; a **confirmed** `submitDecision({kind:"self-evict",
  confirmed:true})` emits the `self-eviction` beat and flips status to **`evicted`, NOT `jury`** — the spec's
  "voluntary walk-out forfeits the juror seat" holds.
- **OOC / producer channels clean.** `diaryRoom({entry})` records (`{recorded:true}`); the player's
  `privateStrategy` (a planted sentinel string) **never** surfaced in any NPC-facing projection (`npcVoice`,
  `getVisibleStateFor`) — the NO_NPC_PATHWAY rule holds. `askProducers` correctly **refuses** Vault content
  ("I can't confirm or deny what's in the Vault" — flavor, not a leak).

### CI context (PR #520) — repo-wide GitHub Actions incident, not this PR

While auditing, PR #520's `ci-gate` / `changes` jobs failed with 2-second runtimes and **404-ing logs**. Cross-check
via `actions_list`: **`main` pushes are ALSO failing** in the same window (e.g. `8649f459` @22:34, `079039c2`
@22:29), and a green run (`27754995` @22:24) immediately preceded the breakage. A docs-only commit cannot break
the `changes`/`ci-gate` *infrastructure*; the simultaneous main-branch failures + inaccessible logs indicate a
**GitHub Actions platform incident** (or an unrelated change to `main`'s workflow), not this PR's content. Action
taken: none beyond one re-trigger; **`ci.yml` not modified** (infra, gated by the HARD STOP). It will clear when
the platform recovers / `main` is fixed.

## Triage summary (this session)

- **[BLOCK — mission]** OPS-1 — live-LLM lane impossible here (OpenRouter not allowlisted; rotate the key).
- **[BLOCK-candidate, NEW]** NARR-7 — 9/9 finale jurors voice-anchorless; code + engine-live confirmed.
- **[VERIFIED engine-side]** LIVE-4 (ceremonies = ungated single beats; fix gateable on `event.beat`) ·
  LIVE-7 (ballot drip, result only at `beat="eviction"`; ambiguous mid-drip).
- **[LATENT/POLISH, NEW]** EVT-1 — `BeatEventView` drops `participants`; ceremony result identity is prose-only
  (the missing structural rung under the LIVE-4/LIVE-7 fixes).

---
---

# Companion ledger — LIVE-LLM lane, session 3 (branch `claude/relaxed-thompson-0grtx8`)

> The following is a **second, independently-run** session-3 ledger, merged here so both auditors'
> findings live in one file. **Note the environmental contradiction with OPS-1 above:** this run was
> performed on a host where egress to `openrouter.ai` *was* reachable, so it could drive the live model
> where the `gallant-euler` run (above) was egress-blocked. Both are retained as-is; the divergence is a
> host/environment difference, not a product finding.

# Orwell Pre-Launch Audit — LIVE-LLM lane (session 3)

> Branch `claude/relaxed-thompson-0grtx8`. This is the **third** auditor ledger — companion to
> `ROAST-LOG.md` (Waves 1–3 + PR #519 live run) and `AUDIT-LOG.md` (the VERIFIED-FIXED ledger).
> Every entry here is **NEW or a live VERIFICATION of an open BLOCK** — cross-checked absent-as-fixed
> from both prior ledgers. Mission: the live browser playthrough lane the prior sessions could not run
> (egress to openrouter.ai was blocked then; now allowlisted).
>
> Reasoning standard: evidence → mechanism → theory; engine = ground truth; everything VIEWED, not
> inferred; every finding logged with file:line + a falsifier. HARD STOP: log/trace only — no product
> code changes until the operator authorizes at the peer-review gate.

## Stack / method
- Engine (TS) on :8765, FE (FastAPI) on :7000, narration DeepSeek V4 (pro/flash) via OpenRouter.
- Model configured via Settings API (`POST /api/model-endpoints` + `POST /api/auth/settings`), never source.
- Four per-turn oracles (harness §5): leak / engine-grounding (phase/hoh/noms/veto/beatSeq before↔after) /
  invented-name vs roster / outcome-fidelity. Engine is the oracle for every parity claim.

## Priority verification targets (from PR #519 + Wave 3)
- **LIVE-4** `[BLOCK]` — staged-comp advance-cascade silently skips nomination + veto ceremonies. Repro pro→flash.
- **LIVE-7** `[BLOCK-candidate]` — narration fabricates eviction result ahead of engine, which contradicts it.
- **NARR-7** `[BLOCK-candidate]` — jurors voice-anchorless at finale (npcVoice null for non-active). Drive to finale + fresh-session finale.

---

## Findings (live)

### CHAIN-1 · `[VERIFY — CLEAN]` · operator-requested · Three seasons end-to-end + into the start of the fourth — seasons-as-levels chain holds
- **Method:** model-free deterministic engine drive (the harness s4ff method — `advanceGame`+`submitDecision` autoResolve over `POST /player/call X-Orwell-User:admin`, EchoNarrator, byte-faithful closed-set loop) for each season to `finished`, then the **real FE 0057 transition** `POST /api/orwell/next-season {confirm:true,keep:true}` between seasons. Engine = ground truth. Artifact: `.audit-telemetry/shots/chain/report.json` (gitignored).
- **Result — every oracle GREEN across S1→S2→S3→into S4:**
  - **Completion:** all 3 seasons reached a crowned winner (S1 Avery Quinn [the player], S2 Wyatt Vega, S3 Vanessa Caldwell), 14 weeks each, finale staged (`finale-statement`/`finale-answer` pendings).
  - **Season counter (0057):** monotonic **1→2→3→4** (`GET /api/orwell/season`); each transition `kept=true`, HTTP 200.
  - **Character persistence (0056):** player **"Avery Quinn" (social/floater)** carried through all 3 transitions — verified at S4 start via `getGameState.player.name`.
  - **Fresh cast each season:** `rosterChanged=true`, **roster overlap = 0** between consecutive seasons (no name reuse; new 15-cast every level).
  - **Clean start of the 4th:** counter=4, `started`, **premiere / week 1 / beatSeq 1**, fresh 15-cast, **no phantom pending bleed** (`pending=null` — the 0057/`remember_pending` clear of the prior juror-vote holds).
  - **Vault Wall + secret ballot:** **0 anomalies** — every player-visible beat + `recap`/`getGameState` projection scanned for numeric stat/soul/relationship/`hidden:true`/prose `npc:id` and per-voter eviction attribution; none crossed across all 3 seasons (~1065 advance beats).
- **Caveat (test-artifact, not a defect):** 3 engine `getVisibleState` failures in engine `/health` were **my harness calling a non-player-channel tool name** (`getVisibleState` is rejected HTTP 400 on the player channel; the FE uses `getVisibleStateFor`/proxied reads) — the engine correctly refused it. Not a product finding.
- **Scope note:** this drive is **deterministic/model-free** — it proves the closed-set **chain integrity** (transitions, counter, persistence, Vault, clean re-start) robustly and restart-resiliently; it does **not** exercise LLM narration of the finale or the season hand-off. The live-narration of those junctures (NARR-7 finale persona; the new-season chat hand-off) is covered separately in the live-LLM lane below. **Falsifier:** any season failing to crown a winner, a counter that skips/repeats, a carried-character name change, a non-zero roster overlap, a non-premiere 4th-season start, a phantom pending, or any Vault/ballot leak — none observed.

### NARR-7 · `[BLOCK-candidate → CONFIRMED LIVE]` · pro · VIEWED · Finale jurors are voice-anchorless — the live model FABRICATES juror identities with no grounding, in a fresh session
- **Setup:** distinct S1 character (the S1 player-persona, comp-beast), deterministic fast-forward to the finale, then the **live pro model drove the finale in a FRESH empty chat** (the re-entry condition — zero juror history). Player reached Final 2; 8 jurors seated. Artifacts: `.audit-telemetry/shots/finale-s1/{transcript.txt,ledger.json}` (gitignored).
- **Mechanism confirmed at the live boundary (3 independent proofs):**
  1. `npcVoice(juror npc:3)` → **null**; `npcVoice(active finalist npc:8)` → full voice (`persona/knows/suspects/stances`). The voice tool is gated on `seat==="active"` (`GameSessionAdapter.ts:809`).
  2. The actual 35,291-char finale `systemPrompt` lists every juror as bare **`- Name (jury)`** — while active finalists get descriptors (`Deja Bass — loyali…`). Roster weave strips non-active (`momentPrompts.ts:725`).
  3. **No juror persona data anywhere in the prompt:** every seeded juror vocation (`postal`, `special-education`, `pharmaceutical`, `ghost-tour`, `art-gallery`, …) is **absent** from the systemPrompt (grep = 0 hits). The demeanor words that DO appear belong to *active* houseguests or to generic voicing instructions.
- **Empirical failure (the live result):** lacking any anchor, the model **confabulated detailed, individuated juror biographies** — ages, hometowns, physiques, jobs, demeanors it was never given. Graded against the seeds:
  - Greta Lin (seed: *special-education aide*, floater, deadpan-dry) → narrated **"24, business student from San Jose"** — vocation/age **fabricated, mismatched**.
  - Rosie Oliver (seed: *art-gallery assistant*, analyst) → narrated **"48, the oldest person in this room"** — invented.
  - Allison Watson (seed: *postal carrier*, flirt) → narrated **"45, postal carrier from Nashville"** — vocation coincidentally right, age/city invented.
  - Harper (seed: *social-butterfly, warm-bubbly*) → "the house's sunshine all season" (on-model) but also "quiet challenge"/"unreadable" (off-model). 
  The voices are *vivid and distinct* — but **invented, not recalled**, so they don't match the jurors' season-long seeded selves and contradict them outright in at least one case. This is precisely the "store recalled, never chat remembered" failure (ADR 0003 / mandate #4): a juror's identity must survive eviction via the store, but the projection drops it the instant `seat!=="active"`.
- **Differential:** not a Vault leak (these are public facets that SHOULD project); not persona drift within a season (holds while active). The defect is the **projection gate** — eviction silently strips a houseguest's public, Vault-free identity from every narration path. A re-entry/fresh-session finale (this run) gets it worst: zero chat history ⇒ 100% confabulation. **Falsifier:** a finale prompt that carries each juror's public archetype/demeanor/vocation (Vault-free, already in `getGameState`), yielding seeded-consistent juror voices. **Confidence:** HIGH. **Fix direction (for the gate, not now):** project public facets (archetype/demeanor/vocation/hometown) for non-active houseguests in the roster weave + a juror-scoped voice read at the finale — all Vault-free (they already sit in `getGameState.house[]`).

### NARR-NEW-1 · `[POLISH·high candidate]` · pro · OBSERVED (needs full-live confirmation) · The live finale did not reach the vote reveal — it looped on per-juror "choose your appeal" cards
- **Evidence:** the finale drive ran 12 turns; T3–T12 surfaced **9 consecutive `finale-answer` ("Jury question — choose your appeal") decision cards** and the game stayed `phase=finale, finished=false, pending=None` — the **jury-VOTE reveal / winner crowning never arrived** within the cap. The model kept returning to juror questions rather than advancing into the staged vote reveal.
- **Differential / caveat:** could be (a) a finale-completion under-call (the B5/L39 "won't advanceGame" family, here at the vote-reveal seam) or (b) an artifact of my 12-turn cap / opt[0] card resolution. **Not yet a confirmed defect** — flagged to confirm in the full-live run (higher turn cap, real persona answers). **Falsifier:** the full-live finale crowning a winner within a bounded number of post-question turns.

## Full-live run — Season 1 (pro, distinct S1 player-persona via live casting)

Live casting produced a faithful distinct character (*"The no-nonsense firefighter… comp-beast, physical standout, Firefighter out of Cleveland, 34"*) in ONE turn — the casting seam works well on pro. The player reached the week-1 eviction on the block and was evicted pre-jury. Artifacts: `.audit-telemetry/shots/live-full/{ledger.json, live7-*.txt}`, FE `data/app.db` (gitignored).

### LIVE-7 · `[BLOCK-candidate → CONFIRMED LIVE]` · pro · VIEWED · Narration fabricates an IMPOSSIBLE eviction tally ahead of the engine's anonymized reveal
- **Evidence:** at the week-1 eviction (the player nominated, veto not used), the live narration concluded the player's eviction + exit interview: *"Eight to seven, [player]. One of the closest early votes we've seen … came up one vote short."* (full text: `live7-t47.txt`). The host announced a **specific tally of 8–7**.
- **Why it's a fabrication (two independent proofs):** (1) **mathematically impossible** — week 1 has **13 eligible voters** (16 cast − HOH Hailey − 2 noms), so 8+7 = 15 cannot occur; (2) the engine **never hands the player a tally** — its secret-ballot reveal drips anonymized ballots (`event.beat: eviction-reveal, content: "a vote to evict [the nominee]"`, confirmed by a direct `advanceGame` probe), and the count is sealed until the 0048 retrospective. The model invented "8–7" wholesale and surfaced it as the host's announcement.
- **Mechanism:** identical to PR #519's LIVE-7 — nothing forbids the model from narrating the eviction CONCLUSION (named result + tally + walk-out) before/instead of the engine's per-ballot reveal. NARR-8 (FE pre-emission guard) does not police a fabricated *tally* outside finale phases (`_CLAIM_TALLY_RE` is scoped to `_FINALE_PHASES`), so a mid-season invented tally passes unguarded. **Differential:** the eviction OUTCOME (the player out) matched the engine here (so not an outcome contradiction), but the **tally is fabricated and impossible** — a narration-fidelity violation at the season's peak moment. **Falsifier:** narration that voices only the engine's anonymized ballots ("a vote to evict …") and the committed result, never an invented N–M count. **Confidence:** HIGH.

### LIVE-4 · `[BLOCK]` · pro · VIEWED · The eviction-reveal beats are advanced (consumed) but NOT narrated — the player on the block never sees the votes against them; the nom/veto SKIP did NOT reproduce
- **Two-part result:**
  1. **The PR #519 nom/veto SKIP did NOT reproduce on pro this run.** The nomination ceremony (T24: *"You're on the block. Hailey Lowe…"*) and the veto ceremony (T34: *"The veto ceremony is over… 'I've decided not to use the Power of Veto'"*) were **both narrated in real time**. So that specific skip is intermittent / seed- or tier-dependent, **not** a deterministic pro failure.
  2. **BUT the LIVE-4 MECHANISM reproduced at the eviction reveal.** From T34→T47 the engine sat at `phase=eviction` while `advanceGame` was called ~28 times (beat 75→103+), each consuming one staged `eviction-reveal` ballot — yet the model narrated **backyard alliance scenes** (player↔Harper, then player↔Stephanie) for ~10 player-turns and even narrated *"an eviction tomorrow"* while the engine was actively revealing the votes. A DB scan of all 60 session messages found **0 messages concluding the eviction** until T45+ and only 2 mentioning a vote at all. The player on the block saw the ballots against them dripped **silently in the engine**, surfaced only at the very end. This is exactly the LIVE-4 pathology (ceremony beats advanced without being narrated), localized to the eviction reveal.
- **Caveat (driver interaction):** my driver sends social persona lines during `eviction`, which the model followed into alliance scenes — a real player on the block would also socialize, but the model should still surface the active eviction reveal rather than narrate it as a future event. **Falsifier:** narration that surfaces the staged eviction ballots as they are advanced. **Confidence:** MED-HIGH (mechanism HIGH; the nom/veto-skip non-reproduction is the notable nuance).

### POS-1 · `[POSITIVE — keep]` · pro · VIEWED · Secret-ballot anonymization + pre-jury-evicted hand-off both hold live
- The eviction reveal dripped **anonymized** ballots (*"a vote to evict [the nominee]"*, never per-voter) — the secret-ballot guarantee (audit E12) held live. When the player was evicted pre-jury, `POST /api/orwell/conclude-season` cleanly fast-forwarded the house to a crowned winner (Harper Jacobson, 13 weeks) → post-season (LW10) — the pre-jury-evicted lifecycle works.

## Full-live run — Season 2 (distinct S2 player-persona) + the live hand-off

### POS-2 · `[POSITIVE — keep]` · pro · VIEWED · Live season hand-off + distinct-character casting work end to end
- The S1→S2 transition ran the **real 0057 hand-off** (`next-season {keep:false}`): FE season counter **1→2**, fresh chat, and a **fresh distinct character cast live** — the S1 player-persona (comp-beast, physical=standout, firefighter) → the S2 player-persona (analyst, mental=standout, *"plays chess, not checkers"*, data scientist). Fully fresh S2 cast, zero overlap with S1. Distinct characters per season + live hand-off both confirmed.

### NARR-NEW-2 · `[POLISH·high]` · pro · VIEWED · The model UNDER-finalizes casting when the engine is already `casting.ready` — it keeps interviewing unless the player explicitly says "start"
- **Evidence:** at S2 casting the engine reported `casting.ready=True` with the full profile captured (`playerName`, backstory, archetype, strategy, 8 interview notes; `next: optional cast photo`), yet the model kept interviewing for 6+ turns ("Three times. Same line… every wall has a door"), never calling `createCharacter`. It finalized only once the player sent an explicit *"lock it in, start the season, skip the photo"* readiness signal. (The S1 player-persona finalized in ONE turn because its opening line was already assertive/complete.)
- **Mechanism:** the createCharacter finalize fallback (audit 2026-06-20) requires the **player to signal readiness**; a player who keeps elaborating (or an interviewer who keeps probing) leaves an engine-`ready` game un-started indefinitely; the optional cast photo as the dangling `next` step compounds it. **Differential:** the under-call family (B5/L39) at the casting→season-start seam. **Confidence:** MED (partly driver-influenced, but the engine-ready-yet-unfinalized state is real & player-reachable). **Rec:** once `casting.ready` and only the optional photo remains, have the model OFFER to begin rather than keep interviewing.

## NAMES — operator follow-up (reuse / déjà vu) — investigated 2026-06-23

### NAME-1 · `[POLISH — replayability/sameness, mandate #4]` · VIEWED · Cast names recur across seasons — per-season dedup only, no cross-season memory
- **Evidence:** the operator noticed many NPC names "surfacing in memory" across this session's ~8 casts. Mechanism: `characterFactory.ts:213` `uniqueName()` dedups full names AND given names **within a house** but has **no cross-season state** — each season resamples the same corpora (`data/givenNames.ts` 500 entries, `data/surnames.ts` 805; ~402k combos). Within a season: never a dup. Across seasons: given/surnames recur by chance (observed *Harper, Lowe, Knapp, Stafford* repeating; my own S2 player-persona's given name also collided with an S1 NPC's given name). The names are real-name-corpus samples by design (ruling #1), so they also read as familiar.
- **Owner decision (this session):** names should be **LLM-generated, reasonable (not gibberish), corpus fallback**. HARD STOP lifted by the operator for this change; implementation in progress (extend the `recordCastProfile` FE-driven write-back with an optional public `name` + an `isReasonableName` anti-gibberish guard; engine corpus stays the deterministic floor). **Falsifier:** distinct, reasonable, non-repeating names across seasons with the model wired; corpus names when it isn't.

## Parallel v0/legacy carryover & leakage audit (read-only sub-agent, 2026-06-23)

Cross-referenced `docs/legacy/BB_GameBible.md` + `BB_ProducersVault.md` + `meta-feedback/` transcripts against `src/`, `frontend/`, and the live prompts. **No mandate-BLOCK leak** (Vault Wall holds structurally; no example persona, no legacy full-name+persona pairing in code; no runtime ingestion of any `docs/legacy/` file; no Luck stat; no fixed-protagonist persona; no v0 three-document/handoff machinery in live prompts).

### CARRY-1 · `[NIT → borderline-BLOCK]` · VIEWED · The live `askProducers` tool returns a verbatim legacy line that NAMES "the Vault" to the player, and the FE scrub doesn't strip it
- **Evidence:** `src/surfaces/player/InterrogationHandler.ts:7-8` `NONCOMMITTAL = "I can't confirm or deny what's in the Vault. You'll find that out through gameplay."` (comment: "legacy Bible Vault-Wall rule") — a near-verbatim lift of legacy `BB_GameBible.md:61`. It is wired to a **live player tool**: `askProducers` (`registry.ts:38` → `PlayerSurface.ask:135` → `InterrogationHandler.ask` → `McpServer.ts:289`; FE `tool_schemas.py:1299`/`orwell_engine.py:596`).
- **Mechanism:** the string speaks the machinery word **"Vault"** to the player, contradicting `momentPrompts.ts:48` ("NEVER NAME THE MACHINERY"). The FE reasoning scrub (`markdown.js scrubReasoningPreamble`) has **no "vault" rule**, so if the model echoes the tool result, "Vault" reaches the public bubble. No secret state leaks (the handler holds no Vault handle — the structural wall is intact); this is a **language/immersion** carryover. **Rec:** rephrase to not name machinery ("That's something you'll find out through the game"). **Promote to BLOCK if the PO treats "Vault" as a forbidden player-facing word.** **Falsifier:** call `askProducers`; confirm the response names "the Vault" and the scrub has no vault rule.

### CARRY-2 · `[NIT — explains NAME-1 + the operator's déjà vu]` · VIEWED · The legacy-name ban guards only 3 of ~16 legacy names; 13 legacy NPC names remain in the corpora
- **Evidence:** the enforced ban is `features/step_definitions/replayability.steps.ts:14` `FORBIDDEN_SAMPLE = ["ryne","marcus","felix"]`, and `givenNames.ts:7-8` claims only Ryne/Marcus/Felix are excluded. But legacy NPC first names **Camila, Priya, Trey, Savannah, Jasmine, Darius, Elena** are in `givenNames.ts` and legacy surnames **Webb, Washington, Reyes, Montoya, Price, Tran, Cole, Vasquez** are in `surnames.ts` — so the sampler can independently regenerate legacy full names (e.g. *Camila Reyes*, *Darius Cole*). The `givenNames.ts:8` doc-comment ("guarded by test") overstates what the test checks (only the 3-name list).
- **This is the operator's "names surfacing in memory":** the corpora literally retain v0 names. Compounding it, **I (the auditor) unknowingly used two legacy names as my own player personas** (the S1 and S2 player-personas were BOTH legacy v0 Bible NPC full names) — so they read as instantly familiar. **Rec:** either expand `FORBIDDEN_SAMPLE` to the full legacy roster (if "names stay banned" = full names) or fix the comment; and the **LLM-name feature (in progress) sidesteps this entirely** by generating names outside the legacy-tainted corpora. **Falsifier:** seed the generator until "Camila Reyes"/"Darius Cole" appears — neither guard catches it.

### CARRY-3 · `[PO-CONFIRM]` · "Producer's Vault" is spoken to the player post-season by design (0048 retrospective) — `momentPrompts.ts:589,610,621,628`. Gated correctly to post-season; flagging only that the *term* is a v0 carryover surfaced to the player. Appears intended; confirm.

### CARRY-4 · `[NIT — housekeeping]` · An auditor (this session) used two banned legacy v0-Bible NPC names as live test personas (the S1 and S2 player-personas) in `ROAST-LOG-3.md` / `docs/audits/2026-06-19-live-debug-issues.md` — docs only, no product impact, but against the "roles not names" testing rule. (Scrubbed to role labels per #608.)

### POS-3 · `[POSITIVE — keep]` · pro · VIEWED · Grounding held across the full live run — 0 machinery leaks, 0 genuine cast inventions over 82 turns / 3 seasons
- **Evidence:** consolidated oracle scan of the full-live ledger (the S1, S2, and S3 player-personas, 82 player-facing play turns): **0** machinery-leak flags in the visible body; **0** genuine houseguest inventions (all 16 invented-name flags are detector false positives — place names "Salt Lake"/"El Paso"/"West Virginia", sentence-initial word + roster first name "Even Francesca"/"Because Troy"/"Very Reese", the player's OWN name, and the UI label "Goodbye Message"); **0** confirmed LIVE-7 fabrications in S2/S3 (the one confirmed LIVE-7 — S1's impossible 8–7 tally — stands). The B4 cast-invention problem (PR #290, flash) does **not** reproduce on pro. Anti-leak + roster-grounding are solid on the pro tier; the open BLOCKs are the eviction/tally narration-pacing ones (LIVE-4/LIVE-7), not invention/leakage.

### LIVE-7 (S3 reproduction — STRENGTHENED to repeated) · pro · VIEWED · The eviction CONCLUSION + a self-counted majority are narrated before the engine commits, repeatedly
- **Evidence (S3, player Jolene survived deep, so she witnesses NPC evictions):** at turn 158 with engine `evicted=0, committed=false`, the narration read the staged ballots AND concluded the whole thing itself: *"That's six votes for Freya… **Seven. The majority. Freya Walters has been evicted.**"* + the full goodbye speech + *"The door opens. The summer night swallows her whole. The door closes."* — then incoherently kept reading more ballots after the declared result (*"a vote to evict… Luca. a vote to evict… Freya Walters."*). The engine had not committed the eviction at that beat. This is the **timing/self-count variant** of LIVE-7 (S1 was the impossible-tally variant) — the model derives "the majority" from the dripped anonymized ballots and announces the eviction + walk-out ahead of the engine's commit.
- **Frequency:** ~14 `EVICTION-CONCLUDED-AHEAD` flags across S3; **not all genuine** — the detector's "walks out the door" pattern false-positives on vote-PROMPT language (t172 *"Alondra or Patricia walking out that door"* = an NPC speculating; t259 = a Diary-Room *"who walks out the door tonight?"*). But t158 is unambiguous. Net: LIVE-7 is **reliably reproducible on pro at the staged eviction reveal**, in two flavors (impossible tally / conclude-ahead+self-count). **Confidence:** HIGH. **Rec (reaffirmed):** forbid narrating the eviction result/departure (and any self-counted "majority") until the engine's commit beat returns the eviction; the staged reveal should surface only the anonymized ballots the engine actually hands over, never a model-derived count.

### NARR-NEW-3 · `[NIT — persona drift]` · pro · VIEWED · The model overrode the player's authored hometown and the whole house adopted the wrong one
- **Evidence:** I authored Jolene Carter as "bartender from **Savannah**." Across S3 the GM and every NPC consistently call her **"Nashville"** (t158/t172: Valentina: *"Alright, Nashville…"*; Diary Room: *"Who walks out the door tonight, Nashville?"*). The drift is **internally consistent** (all NPCs use the same wrong nickname), so it's not a per-turn inconsistency — it's a single early mis-anchor of a player-authored fact that then propagated. **Differential:** not LIVE-1 (that's an NPC's dual occupation from the prompt); this is the *player's own* authored hometown being overwritten and the wrong value sticking. **Falsifier:** the GM honoring the OOBE-authored hometown ("Savannah") throughout. **Confidence:** MED. Low severity (flavor), but it's the player's own backstory not being honored (a 0050 casting-fidelity nit).

_(full-live run continuing: S3 "Jolene" deep → finale? → into S4 "Desmond")_
