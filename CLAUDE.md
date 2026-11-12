# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Overseer continuity:** if you are orchestrating this work as an *overseer* (dispatching delegate
> agents, reviewing, watching CI, merging), read [`SOUL.md`](SOUL.md) first — it holds the operating
> model, dispatch discipline, the hard-won lessons (diagnose-before-revert, live-verify streaming
> changes, the `stat -L` agent-health rule, the gitignored-`settings.json` test red herring), and a
> current-state snapshot. It is operational continuity, distinct from the game's `CHARACTER`/`SOUL`.

## What this project is

`orwell` is a rebuild of an immersive, single-player, text-based **_Big Brother_ simulation**
as a web application. The system is game master, narrator, and the voice of every NPC
houseguest. A prior version ran entirely inside one LLM chat context; this rebuild moves
game state into **external, permissioned stores** behind a **hexagonal architecture** so
that the deterministic rules, the secret state, and the narration are cleanly separated.

**Status: feature-complete through the drafted spec set (BDD/TDD-first; reconciled 2026-07-06).** Specs now run
through **0110**, and the originally-drafted set is built and **green** — the spec ceiling and the
*built* one are now nearly flush: **0075–0096, 0099–0102, 0104–0110** are built, while
**0097/0098/0103** are **retired and removed** (owner, 2026-11-11: "Retire and remove is fine."; ORW-267; previously frozen)
— **0108** (the real-model golden-path gate), along with its screenshot siblings **0113** (visual-regression) and **0114** (theme-consistency) that rode the same fixture, was **DECOMMISSIONED (2026-07-21, owner directive)** — the fixture, record/replay scripts + `src/golden_path.py` seam, the three CI jobs, `golden-nightly.yml`, and unit gates were removed entirely (advisory/non-gating, perpetually stale, hang-prone #1713). The 2026-07-06 closure session shipped
the last three spec-only files — 0094 (distorted-gossip consequences, shipped SCOPED as a new
`confront(npcId, factId)` lever; deliberately did not retrofit nominate/vote, an owner-flagged design
call), 0095 (pre-show ties as time-bombs), and 0096 (emergent nemesis) — alongside 0101 (NPC
myth-making, 2026-07-05) and 0102 (the redesigned daily recap, 2026-07-05, #884). *(The former lone
deferral, **0022 (MVP-2, the rich game UI)**, was **removed** in the 2026-06-28 PO review — superseded
by 0020/0051/0054 under ADR 0003.)* The
reconciled per-feature index in `docs/features/README.md` is authoritative for built vs. spec-only — plus **0053**
(admin transcripts, FE-side) — covering: the eight
priority invariants, the MCP seam, the one-liner deploy, the gameplay loop, the MVP-1 batch —
including the **living, persisted consequence loop (0023)** (act → hidden impact → persist →
recall, wired into the live game) — the live-loop batch, the endgame batch (Final 5 → Final 2,
player eviction & the juror's seat, eviction night live), the post-audit batch (0038 live
society + gossip diffusion, 0039 deals, 0040 confessionals, **0041 character evolution — the
linchpin**, 0042 competition library, 0043 emergent blocs, 0044 strategic noms/votes), 0048
retrospective/unsealing, 0049 house presence & lingering, and 0050 the casting interview.
**Every batch in `docs/IMPLEMENTATION_QUEUE.md` is ✅ DONE** (each item carries its verifying
artifact) — through the B/C audit waves (B34–B73 / C12–C33), the round-4 UI & runtime audit
(D1–D11), the round-5/6 full-product-audit campaign (the E/P/W/S/T parallel lanes + the
prioritized UI track U1–U5), and the 2026-06-11 close-out lanes (cross-lane tails, the
T-remainder, 0053, E86a fastembed). The **campaign close-out ledger** in
`docs/audits/2026-06-10-full-product-audit.md` is **the authoritative open-items list going
forward**. *(2026-06-11, post-ledger: the **DWE windowing lane** — Lane F — shipped end to end:
the window audit (`docs/audits/2026-06-11-dwe-window-audit.md`), the `OrwellWindow` kit +
`.ow-*` family, the migration waves, and the F-3 anti-fragmentation ratchet; new FE windows
MUST compose the kit.)* The game is **folded into the main chat**: the player-facing tier is the vendored
**Orwell** front-end (`frontend/`, Python) talking to the TS engine over MCP (see
[Architecture](#architecture-hexagonal)). Priority-ordered feature specs live in
`docs/features/` (through **0110**; the 0067–0074 launch band is 0067/0068 public-internet exposure + ADR 0007, 0069 token economy,
0070 off-screen texture enrichment, 0071 defensive hardening (redaction + URL/path guards), 0072 the
multi-platform gateway, 0073 the structural anti-sycophancy game-build wall (a CI gate), and 0074 local &
tunable HTTPS (ADR 0014); past the launch band, **0075–0096, 0099–0102, 0104–0110** are built and **0097/0098/0103** are retired and removed (owner, 2026-11-11; ORW-267) — 0108 (the golden-path replay gate) was **DECOMMISSIONED 2026-07-21 (owner directive)**: the fixture, scripts + seam, the `golden-path`/`visual-regression`/`theme-consistency` CI jobs, and `golden-nightly.yml` were removed entirely (advisory/non-gating, perpetually stale, hang-prone #1713);
0052 — the house themes — shipped FE-side from the audit
spec with no standalone file; 0051 in-character images shipped 2026-06-11, PR #235, and its
follow-on **portrait/headshot lane** — Lane G — extended it FE-side: cast-portrait generation &
backfill, the casting headshot studio + player-uploaded/AI account avatar, portrait variety, and
the game-build provider gating (OpenRouter image models via `/chat/completions`)). **New work starts as a new spec/queue
item** — the remaining known deferrals are listed under [Current status](#current-status); the
governing design rulings are `docs/audits/2026-06-09-product-audit.md` ("Remediation
principles"), the **product-owner rulings #1–#21** in `docs/audits/2026-06-10-full-product-audit.md`,
and ADRs `docs/decisions/0003` (the conversation is the game) and `docs/decisions/0005` (split
authority by openness — the engine records the open set of social play, never normalizes it).

## Source of truth — read these first

The design is fully specified. **Read `docs/CLAUDE_CODE_INSTRUCTIONS.md` first** (the build
brief and complete decision log), then `docs/bb-sim-spec.md` (the v3 domain spec). These two
are authoritative and reference each other as companions.

| File | Role |
|---|---|
| `docs/CLAUDE_CODE_INSTRUCTIONS.md` | **Build brief & decision log** — start here. Architecture directives, workflow, hard "do-nots", milestones, open decisions (§15). |
| `docs/bb-sim-spec.md` | **v3 domain spec** — concept, persistence model, Vault Wall, behavioral-fidelity mandate, the BDD invariants (§12), open decisions (§16). |
| `docs/decisions/` | **Decision records (ADRs 0001–0016)** — accepted refinements to the canonical mechanics. 0001 competition stats / Character-Soul split / veto "Houseguest's Choice" · 0002 organic relationship model · 0003 the conversation is the game · 0004 embedding provider (fastembed/ONNX) · 0005 split authority by openness · 0006 in-game time/sleep/presence economy · 0007 public-internet exposure · 0008 cross-tab/-device chat consistency · 0009 location/movement single source of truth · 0010 token-economy architecture · 0011 concurrent engine-drive beat-aware guardrails · 0012 two-window lockstep "Messenger mirror" · 0013 cast photos require a model-authored identity · 0014 local & tunable HTTPS (LAN-trusted, with or without a domain) · 0015 collapse the duplicated live-vs-mirror chat render paths (ship-gate F5's root cause) · 0016 LLM model selection (narrator `z-ai/glm-4.7` reasoning-low + utility `qwen/qwen3.6-flash`, portrait `google/gemini-3.1-flash-image` — re-amended 2026-07-13/14; this is BOTH the OOB default and the currently-live/deployed selection, per the owner's 2026-07-09 ruling that the deployment pair also became the OOB default; the Seedream-portrait follow-on is built as an OPTIONAL fal.ai provider (#1156), used only when explicitly configured, alongside the OpenRouter default). (`README.md` there indexes them.) |
| `docs/features/` | **Priority-ordered feature specs** — each `NNNN-*.md` (design note) + `NNNN-*.feature` (executable Gherkin), built in order. `README.md` there holds the live per-feature **status index** and the **Amendments to shipped specs** table (implementers must pick those up). |
| `docs/IMPLEMENTATION_QUEUE.md` | **Live work queue** — per-item implementation prompts (B/C/D/U/L-numbered lanes), dispatch order + dependencies, and the truest prose snapshot of what's done vs. remaining. |
| `docs/audits/` | **Audit record & rulings.** `2026-06-10-full-product-audit.md` carries the product-owner **rulings #1–#21** and the **campaign close-out ledger** (the authoritative open-items list); `2026-06-10-v1-transcript-meta-feedback-audit.md` reconstructs the v1 game from its logged transcripts (why the Bible's emphatic passages exist). The 2026-06-11 **house-audit pattern** (real FE + real engine driven headless under Playwright, DOC-ONLY) produced `2026-06-11-dwe-window-audit.md` (windowing), `2026-06-11-refresh-persistence-audit.md` (every transient UI state × reload), and `2026-06-11-settings-wiring-audit.md` (every settings control × {wired, persisted, applied}). The **`2026-06-27-ship-gate.md`** is the **launch-acceptance bar** — the authoritative "what blocks ship": the FE-airtight standard **F1–F5** (no missing messages, right status, smart queueing, multi-window concurrency, realtime two-window mirror parity — historically the #1 release blocker, now **CLOSED + CI-gated** as a required check, #1276, 2026-07-09) and the casting→eviction golden path **G1–G9**, each with the real-model gate that proves it, plus the launch-blocker / post-launch / parked triage of every open issue. |
| `docs/legacy/BB_GameBible.md` | **Legacy reference only.** The old chat-prompt implementation being replaced. Source of the *concrete* mechanics, but its fixed player persona / names are illustrative — never hard-code them. Same rule for the vendored v1 transcripts in `docs/legacy/meta-feedback/`. |

## The non-negotiable mandate

These four priorities override convenience. A mechanically-correct but behaviorally-thin or
leak-prone build is a **failure state**, not a partial success.

1. **Behavioral fidelity is priority #1.** Reproduce the *full social texture* of a real
   _BB_ episode — drama, nuance, hidden conversations, and **off-screen NPC-to-NPC scheming
   the player never witnesses**. Tests must verify *richness*, not just mechanics.
2. **The Vault Wall is absolute and structural.** Secret state can never reach the player —
   enforced in code at the port/tool boundary, *never* by prompt wording. The model "cannot
   leak what it never receives." **God Mode / admin is walled from the Vault too** (the human
   has never read it and must not be able to — spoilers ruin the game above all else).
   **THREE sanctioned exceptions exist — and only these three.** (1) **owner-ruled DEBUG override: `producerVault`** — a live-Vault
   *unseal* for operator debugging. It is deliberately quarantined and is NOT a hole in the wall for
   normal play: it lives in `DEBUG_VAULT_TOOLS` (the *only* `readsVault: true` registry — the literal
   `ToolDescriptor.readsVault: false` guard still holds for every advertised tool), is **out-of-band**
   (never in the `toolsFor` allowlist), **admin/God-Mode channel only**, and fires **only** behind an
   explicit FE "unseal" on `/admin/status` (hidden by default). Every "admin allowlist is Vault-free"
   guarantee stays literally true; `tests/unit/producerVault.test.ts` is the gate. Do **not** "fix" it
   as a leak — it is intentional; do **not** widen it (never the player channel, never an advertised
   tool, never always-on). (2) **The eviction-night exit package (owner-ruled 2026-07-21, Q1 —
   player-only AUDIENCE):** a structurally-filtered unseal at EACH eviction night — speaker = the
   departing evictee, airing to the player alone; subjects limited to the player, prior evictees,
   and facts already in the player's knowledge layer; never living players' secrets; adversarial-test-gated like `producerVault`;
   flag-gated off-by-default. Spec: `docs/design/2026-07-21-moonshot-round2-divergent-slate.md`
   §5 Q1. (3) **The 0048 post-season retrospective (owner-approved 2026-11-10, card 29: "This seems fine as is."):** after the
   winner is crowned and the season is over, the per-voter attribution of the secret eviction ballots unseals for the player's
   look-back. Post-season only — never during play, never before the winner is crowned. Never extend Vault exposure beyond these three doors.
3. **Anti-sycophancy.** The deterministic core + seeded randomness decide outcomes; the LLM
   only *narrates*. Ground truth lives in the stores and is *queried*, never "remembered"
   and bent to please the player.
4. **Non-degradation.** Persisted detail must **never** be lost across saves and should
   *accumulate and deepen* over a game. The old version's secret store thinned out over time;
   do the exact opposite.

**The conversation is the game (`docs/decisions/0003`).** The beta proved the loop — a good LLM +
the Bible + secrets *is* the game. The engine exists only to fix the four degradations above
(leaks / sycophancy / memory-thinning / sameness) and otherwise **get out of the model's way**:
prefer removing context to adding it; hand the model *facts to voice*, never *scripts to recite*;
UI may **augment** the chat intelligently but never **replace** an interaction that builds or
progresses the game; **lingering is play** (the player can mill around any room, learn who's
present/adjacent, and talk to anyone — while those NPCs keep playing *their* game, and nothing
force-marches the week); **people must make sense** (one place at a time; speech scoped to what
each NPC legitimately knows; stable public persona); replayability is engine-seeded, and
long-term memory is the store *recalled*, never the chat *remembered*. Each of these is
**testable structurally** where possible (see the ADR's testability section). Don't "improve"
the game into a dashboard.

## Architecture (hexagonal)

Keep the **domain core pure and dependency-free** (no I/O) regardless of stack choices.
Everything else sits behind ports.

- **Domain core** — the Game Bible as code: the weekly loop (HOH → nominations → veto →
  veto ceremony → eviction → jury → final two), eligibility/legality rules,
  **stat-+-temperature-weighted** competition resolution, votes, win conditions, and the
  daily-event invariant. Fully unit-testable with a seeded `RandomnessSource`.
- **Ports (interfaces)** — at minimum: `GameStateRepository`, `VaultStore` (**engine-only**),
  `JournalStore`, `EventStore`, `KnowledgeService`, `NarrativePort` (the LLM),
  `RandomnessSource` (**seedable**), `Clock`/`Scheduler`, `CharacterFactory`, `SoulProvider`.
- **Adapters** — DB adapter(s) for relational/graph state and the event record; soul storage
  (md and/or vector); **MCP server(s)** exposing *permissioned* tools to the narrative LLM
  (e.g. `getVisibleStateFor(entity)`, `recordInteraction`, `resolveCompetition`,
  `surfaceInformationTo(player, fact, pathway)`); the LLM adapter behind `NarrativePort`.

**The permission boundary is the whole point.** No player-facing **or** admin/God-Mode-facing
adapter or tool may depend on `VaultStore`. A surface is not "done" until a test proves it
returns no Vault data.

### Three channels → ports

- **Administrator / God Mode** — admin-only meta port (configure, override mechanics, inspect
  **non-Vault** state, manage the sandbox). Walled from the Vault even for the admin.
- **Player-level** — out-of-character strategy/directives within the player's agency.
- **In-character** — narrative interactions.

Each running game is its own isolated sandbox — keyed to the **physical-world user**: **one
active game per user**, **unlimited users concurrently**, each fully isolated. **Cross-user
isolation** is a first-class guarantee *alongside* the Vault Wall (no call for user A may return
user B's game — secret or not). The chat is each user's window into *their* game. (Feature 0021.)

### Wiring an FE-driven engine write-back (the recurring boundary gotcha)

Several engine tools are **FE-driven write-backs**: the front-end (which owns a concrete provider —
an LLM, `web_search`, the image API) produces content and writes it BACK so the **engine** stays the
source of truth. The live ones: `recordCastProfile` (0058 deep-profile authoring), `preSeedCast`
(0065 cast pre-warm), `recordWorldSnapshot` (0062 zeitgeist), `recordImageBeat` (0051). Adding one is
a **four-place** change, and a missing piece fails **silently at runtime** (the FE call is rejected at
the MCP boundary, and the best-effort caller swallows it):

1. `src/ports/GameSession.ts` — the method + its req/result types.
2. `src/adapters/engine/GameSessionAdapter.ts` — the implementation.
3. `src/surfaces/tools/registry.ts` — add to `PLAYER_TOOLS` **and** to `INFRA_LEVERS` (these are
   FE-driven, **not** model levers, so they stay out of the agent's lever manifest / drift gate).
4. `src/adapters/mcp/McpServer.ts` — a `requireShape` arg-guard case **and** a `callTool` dispatch
   case (+ the type import). A *pre-game* tool also goes in `HttpMcpServer`'s `SANDBOX_CREATING_TOOLS`.

**The static gates do NOT catch a missing #4** — dependency-cruiser only checks Vault edges, the
lever-manifest drift test only checks prose — so a write-back with steps 1–2 done but 3–4 missing
typechecks, passes `test:arch` + the manifest test, and is **dead at runtime**. `recordCastProfile`
and `recordWorldSnapshot` both shipped exactly this way and silently no-op'd for a long time. The fix
is a **boundary test that dispatches the tool through `McpServer.callTool`** for every write-back
(`tests/unit/castPrewarm.test.ts`, `tests/unit/worldSnapshotBoundary.test.ts` are the templates).

The FE driver is a best-effort, **idempotent, fail-soft background task** in `frontend/src/`
(`orwell_cast_authoring.py`, `orwell_prewarm.py`, `orwell_zeitgeist.py` — each: resolve a utility LLM
via `_resolve_llm_fn`, optionally `web_search`, synthesize JSON, write back; **no model/provider ⇒ the
engine's deterministic floor stands ONLY for the lanes that are not required**: the cast skeleton (genesis) and the deeper backstories (cast authoring) are REQUIRED under the default `strict` enrichment policy — Ryne, BDD card 30, 2026-11-11: "if it fails, it fails. I don't want a fallback" — so a failure latches the loud pre-finalize gate in `do_create_character` and the game does not start on a fallback cast; the world snapshot and the off-screen scene detail stay fail-soft, admin alert only). Kicked from `do_create_character`
(`tool_implementations.py`); the required lanes can refuse game start, the rest never block it.

### The mirror gotcha: a prompt-advertised MODEL lever needs FE tool-wiring too (the lever-drift trap)

The four-place rule above is for FE-driven **write-backs** (they go in `INFRA_LEVERS`, kept OUT of the
model's manifest). The **mirror case** is a tool the **narration model calls** — a read like
`dailyRecap`/`seasonRecap`, or any player lever **named in the narrator prompt**
(`BASE_GAME_MASTER_PROMPT` glossary in `src/engine/momentPrompts.ts`). If the prompt *advertises* a
lever, it MUST be **agent-callable through the FE tool layer** — a **five-place FE wiring**, mirroring a
sibling read tool (`seasonRecap`) end to end:

1. `frontend/src/tool_schemas.py` — the tool schema **+** add it to `ORWELL_GAME_TOOLS`.
2. `frontend/src/agent_tools.py` — `TOOL_TAGS` **+** `GAME_TOOL_KEEP` (so the game build keeps it).
3. `frontend/src/orwell_engine.py` — the MCP-call wrapper.
4. `frontend/src/tool_execution.py` — the dispatch branch.
5. `frontend/src/tool_implementations.py` — the `do_*` impl (null-safe if the read can be empty).

(+ `frontend/static/js/orwellToolBeats.js` — a diegetic beat label / `ORWELL_SILENT_BEATS` entry, or the
D5/W6 keep-set-label gate fails once the tool joins `GAME_TOOL_KEEP`.)

The gate is **`frontend/tests/test_c13_lever_drift.py::test_every_prompt_advertised_lever_is_agent_callable`**
("prompt advertises a lever the agent cannot call"). **The trap: it runs in `fe-unit`, which an
engine-only PR SKIPS** (CI path-filtering) — so an engine PR that adds the tool to the prompt +
`registry.ts` + `McpServer.ts` (all engine-side, all green, FE lanes skipped) lands a **latent** break
that only erupts on the *next* FE-touching PR, echoing as an identical `fe-unit` red across **every**
open FE PR until it's fixed. 0102's `dailyRecap` shipped exactly this way (advertised + engine-wired in
#1217, but the FE wiring was missing; it surfaced simultaneously on #1222/#1223/#1224 and was fixed in
#1226). **If you add a model-callable tool to the narrator prompt, do the FE wiring in the SAME change**
(or don't name it in the prompt).

## The event / visibility model (build this carefully — it caused real bugs before)

There is **one `EventStore`** holding every interaction. **Visibility is per-event metadata —
a witness set + a hidden flag — not a function of which store the data lives in.**

- **Player-witnessed = not secret.** If the player is in an event's witness set, it is the
  player's knowledge (Journal-visible). Do **not** mislabel witnessed events as off-screen/
  secret — that was a concrete past bug where the Vault wrongly logged events the player was
  present for.
- **The Vault holds only genuinely off-screen/hidden content** — NPC-to-NPC scenes whose
  witness set excludes the player, plus hidden attributes and confessionals.
- **Propagation only via in-game pathways.** A hidden fact reaches the player only when an NPC
  tells them, they overhear, etc. — modeled explicitly in `KnowledgeService`. The Vault Wall
  stays intact because surfacing is an explicit, traceable event. A houseguest can only know
  what they witnessed or were told; if there's no pathway, they don't know it (they may
  *suspect*, but cannot *know*). Hidden facts also **diffuse NPC-to-NPC along the social graph**
  (gossip), drifting with each retelling, so what reaches the player can be a distorted belief
  held with a source + confidence — diffusion runs in the hidden layer and only updates the
  player's knowledge when a pathway terminates at the player (ties to `docs/decisions/0002`).
- **Diary Room / confessionals are events too.** NPC confessionals are Vault-only content
  (off-screen, witness set excludes the player). The player's Diary Room is a *player-level,
  OOC* channel: its content is the **player's own knowledge** but has **no in-game pathway to
  any NPC** — it may inform the engine's read of player strategy, **never** NPC behavior. (DR
  mechanics are concrete in the legacy Bible §6–§7; the provisional domain model is spec §11.)

## The consequence & memory loop (the MVP-1 backbone — feature 0023)

Recording an event is only half the loop. Every happening — a conversation, a competition win, a
vote, a scheme — must also **fold its hidden impact into the relationship/soul layer** and
**persist**:

```
happening → recorded event (witness set + hidden flag)
          → engine applies its HIDDEN impact to the relationship/soul layer
            (trust/affinity/threat move — the player's action changes how they feel about them)
          → persisted to long-term memory: every event detail + the derived hidden state
          → recalled in full on return / restart — the house still remembers.
```

The opinion change lives in the **hidden layer** (Soul/Vault) — the player **never sees the
numbers**, only the later behavior. That is the Vault Wall working: the change is real, recorded,
and invisible. **This is the point of the game.** It is now **green** (feature 0023): the live
game wires events (0002), relationships (0017/0026), and persistence (0007/0030) together —
the **live** folds happen in the adapters: `EngineCommandsAdapter.recordInteraction` records the
event and folds its hidden impact, and `GameSessionAdapter` folds ceremony beats
(`foldCeremonyConsequence`) and soul evolution (`evolveFromBeat`); `src/engine/consequence.ts` is
the older 0023 module (off-screen-sim path). The orchestrator (`src/composition/orchestrator.ts`)
persists each turn with a fail-closed integrity checkpoint (0031). **The checkpoint splits faults by
KIND (#1106):** only *state-integrity* faults (degradation / vault-leak / no-daily-event) advance the
consecutive-fault streak that opens the corruption circuit at `BREAKER_THRESHOLD`; a *persist-failure*
(a disk blip) is still fail-closed + typed + recorded but **never** advances or resets the streak (a
sick disk must not light the God-Mode corruption alarm), and a read-only `audit` can never close the
circuit — only a clean state-changing commit does. A supplementary off-screen tick whose save fails
rolls back to the committed baseline and the **player turn still stands** (the tick is enrichment, not
the turn); the capped fault ring survives clean commits so `sandboxHealth` can reconstruct a burst.
Hold the line that made it work: **never ship an action that is narrated but never recorded** — it has
no consequence and no memory.

**The front-end error-corrects the model (`frontend/src/agent_loop.py`).** A real, recurring gap:
the narration LLM reliably **under-calls** the engine tools — it won't `advanceGame` (the game
freezes at a beat) and won't `recordInteraction` for the player's social scenes (they fold zero
impact). The engine is fine; the *model* skips the call. So the FE agent loop carries two in-loop
guardrails (the owner's ruling: keep the dynamic DM, error-correct the omission — never engine-
author content): (1) a **progression stall-nudge** that, when the live game sits in an advance-
phase and the player turn is a *lull* (engagement-driven, never a turn count — pacing is "seize the
lull, let substantive play run"), nudges the model to `advanceGame`; and (2) **`_auto_record_scene`
(feature 0055)** — when an engaged player↔houseguest turn recorded nothing, the FE makes a
constrained extraction call (`{withIds, kind, content}`, model-proposed direction) and calls
`recordInteraction` itself, GUARANTEEING the social play moves the hidden weights. Model-driven
recording always takes precedence. When debugging "the game won't advance" or "social play has no
consequence," look here, not only at the engine. The **same under-call bites the game-start and premiere
seams**, error-corrected by the same family (audit 2026-06-20): the casting framing (`apply_game_framing`
in `routes/chat_helpers.py`) tells the model the **headshot is already on file** so it stops re-asking and
finalizes; a **`createCharacter` finalize fallback** starts the season when casting is engine-`ready` and
the player signals readiness; the advance stall-nudge **escalates to a forced `advanceGame` (L39b)** when
the model ignores every rung; and a **premiere `markHouseguestMet` auto-belt** keeps the #380
meet-everyone gate progressing. These guardrails fire only where the model SKIPS a call — the engine is
fine; never engine-author content. **The whole belt family is inventoried in
`docs/design/undercall-seam-structural.md`** (trigger / what the model skipped / failure-mode-if-broken,
across the progression, consequence-loop, and game-start families), which also holds the *forced
tool_choice* rung (a per-round wire directive that GUARANTEES a single-legal-lever closed-set beat —
the live comp/ceremony beats and the casting finalize — gets called; never forces `submitDecision`,
suppressed on open pendings/social holds) and the **belt-fire telemetry** (`orwell_sync_ledger.note_belt_fire`
→ per-turn `beltsFired` → `get_belt_totals`). **The telemetry contract is success-gated, not
attempt-counted: a belt fire means an APPLIED correction — the awaited helper produced a real update
(a recorded scene, an applied move, an OBSERVED forced tool event) — never a mere selection or a
no-op/failed extraction.** `frontend/tests/test_belt_telemetry.py` pins it.

**Sync work must never flatten creative play (`docs/decisions/0005`).** Authority splits by
*openness*, not by *layer*: the **closed set** (outcomes, eligibility, state truth, persistence,
the Vault) is engine-dictated — *no dynamism to lose* — while the **open set** (the meaning/texture
of social play) is recorded faithfully and **never normalized** into a closed bucket in a way that
changes what can be narrated or played next. Concretely (PR #355): `recordInteraction` / the 0023
`ConsequenceEngine` take an optional, Vault-free `consequence` descriptor — the model proposes the
*shape* (which edge moves, which direction, relative `emphasis`); the engine keeps the bounded,
seeded *magnitude* (no raw number crosses; `kind` is the floor, so no descriptor ⇒ byte-identical
fold). `tests/unit/expressiveNonCollapse.test.ts` + `frontend/tests/test_expressive_non_collapse.py`
are the permanent gate, and the FE desync guard may fire only on closed-set board claims, never on
creative prose.

**The closed-set sync spine (feature 0065) hardens the above.** ADR 0005's closed-set counterpart:
the engine issues a monotonic **`beatSeq`** on every read/advance (owned by `GameSessionAdapter`,
bumped once per committed mutation in the registry commit funnel, persisted in the snapshot). Mutating
tools take an optional **`expectedBeatSeq`** (stale ⇒ typed `StaleBeatError` → HTTP **409 `stale-beat`**,
refused *before* any write) and **`idempotencyKey`** (at-most-once progression). The FE holds last-seen
`beatSeq` per canonical session, attaches it, refreshes from every response (no self-409s), and
reconciles a 409 through the existing desync mechanism. A **pre-emission outcome guard** corrects a
phantom board claim *before* the player sees it (closed-set claims only — `chat_helpers.py`); a Vault-free
per-turn **divergence ledger** (`frontend/src/orwell_sync_ledger.py`) records the sync activity; and a
`beatSeq`-keyed **`stateDelta`** read feeds the model a tight O(Δ) "what changed since your last turn"
delta. Every part is opt-in/back-compatible (absent field ⇒ byte-identical) and closed-set only — it
never touches creative prose (the `expressiveNonCollapse` gates stay the proof).

## Front-end client conventions (non-obvious — verify before editing `frontend/static/js/`)

The sections above govern the engine/closed set; these are the **player-tier client** conventions
that span several JS files, aren't captured elsewhere, and have each caused a real regression. Read
them before touching the chat stream or the HUD.

- **`orwell:gamechanged` has exactly ONE dispatcher (the g15 freshness seam).** The HUD/sidebar
  panels are poll-based (20–30s) and stay fresh by *listening* for the debounced `orwell:gamechanged`
  window event whose **only** dispatcher is `orwellGameChanged(reason)` in
  `frontend/static/js/platform.js` (~250ms trailing debounce, also `window`-exposed). Every FE
  mutation seam **calls that helper** — the chat tool-result seam (each game-mutating tool) and the
  decision-card POST success — and **nothing** may `new CustomEvent('orwell:gamechanged')` ad-hoc.
  `frontend/tests/test_g15_gamechanged.py` enforces "exactly one dispatcher" + that every mutating
  tool routes through it. Cross-**device** reconcile is a *separate* seam: `_publish_game_updated`
  (feature 0064, server-push) in `frontend/routes/orwell_routes.py`. Wiring a new mutation? Call the
  helper; don't add a poll or an ad-hoc dispatch.

- **Two-window realtime parity rides on a LIVE canonical-session binding (ADR 0008/0012).** Two
  windows on one game mirror each other only when the *canonical game-session id*
  (`GET /api/orwell/game-session`, stored in `frontend/src/orwell_game_session.py`) resolves to a
  **live FE chat-session row**: in the game build the mirror rides the WebSocket (`/ws`, `state`/`chat` channels; the SSE
  mirror and resume endpoints `GET /api/chat/events/{id}` / `GET /api/chat/resume/{id}` and `chat_stream` answer **426** there),
  the non-game build keeps SSE/poll where those two both 404 a non-row id, and `_resolve_canonical_session`
  (`routes/chat_helpers.py`) is the server run-key. Convergence is gated on `started !== false` — a
  started game mirrors; casting stays per-tab by design. Two regressions to never reintroduce (both
  fixed): a session-delete that doesn't **unbind** the canonical id leaves the mirror subscribed to a
  dead channel and *collapses the window* (#1085), and resolving the canonical id during casting
  causes a settle-time session switch that *strips the just-streamed reply* (#1086). Always validate
  the binding resolves live before subscribing, and unbind on delete. The multi-window airtight bar
  (F1–F5) is the authoritative gate: `docs/audits/2026-06-27-ship-gate.md`.

- **The live stream splits by channel — reasoning must NEVER reach the public bubble.** In
  `frontend/static/js/chat.js` the streaming loop keeps two per-round buffers: `roundReplyText`
  (deltas with `json.thinking` falsy) and `roundReasoningText` (truthy). The message **body** renders
  ONLY `roundReplyText` through `markdown.js processWithThinking` (which, in the game build, also
  scrubs operator-aside / raw `npc:<id>` leaks); the live **"Thinking" accordion** renders
  `roundReasoningText`. Reasoning is kept out of the body *by construction* — do not reintroduce
  regex extraction of the reply from a merged buffer. Reset both buffers in lockstep with `roundText`
  (at `agent_step` / `teacher_takeover`); the merged `roundText` / `accumulated` stay intact for the
  other consumers (doc-fence, TTS, persistence `dataset.raw`, background streams, `<think time=…>`).
  The **stall watchdog (`_startStallWatchdog`) is deliberately DISABLED** — the server-side stall
  detector + auto-continue loop-breaker supersede the old "still working?" banner; don't re-enable it.

- **On narrow viewports, kit windows present as bottom SHEETS, not floating windows (#893).**
  `frontend/static/js/orwellWindow.js` takes a `sheet: 'auto'|true|false` option (default `'auto'`),
  resolved per-open like docked-vs-floating: on ≤768px **modal dialogs sheet automatically** and
  non-modal windows opt in; crossing the breakpoint re-homes live windows through the same `_rehoming`
  teardown/rebuild hinge the dock toggle uses. Sheet mode is a *presentation mode of the window kit
  itself* (NOT a second window family — avoids F-CHROME-1 II) kept in gesture/visual lock-step with
  the sibling `orwellSheet.js` (the detent fractions are a shared pin — never let them drift). Sheet
  mode skips slots/drag/resize and mints **no** geometry key, so F5 holds and g15 stays silent.

- **The send outbox is reload-durable, session-bound, and self-continuing (#891 P0s).** In
  `frontend/static/js/chat.js` a queued/offline send persists to **sessionStorage** (per-tab by the
  ADR 0008/0012 ruling — localStorage would let two tabs double-send) and stays until a server row
  carrying its `clientMsgId` is observed. Non-obvious invariants, each a fixed regression: (1) a
  restored item drains **only** while ITS `item.sessionId` is the selected session, and dedupe checks
  `item.sessionId`'s history — never the current session's — or a restored item bleeds into the wrong
  chat; (2) the drain is **self-continuing** — each dispatch settle re-schedules the flush if eligible
  items remain, or a second queued item starves behind the single-flight guard. `selectSession`
  (`sessions.js`) nudges the drain so a bound item dispatches on selection.

- **Run the WHOLE FE suite before pushing FE changes.** `cd frontend && python3 -m pytest tests/`
  (venv at `frontend/.venv`). Many gates are source-pinned convention checks (g15, the reasoning
  scrub, the render contract) that live outside obvious keywords — a `-k` subset can pass green while
  the real gate fails (the CI `frontend` job runs the full suite).

## Characters, souls & per-moment temperature

- **Only the player's profile is human-authored** (first-run OOBE). **All NPC profiles are
  generated** by `CharacterFactory`, constrained to plausible _BB_ contestant archetypes
  (internally consistent, reality-TV-plausible). Generate **tons of hidden elements** per
  character; public persona may match or wildly diverge from hidden attributes; hidden
  elements surface **rarely** (gated by the temperature roll) and profiles **evolve** as the
  game proceeds. Souls may be md and/or vector-backed.
- **Static `CHARACTER` vs dynamic `SOUL`.** A houseguest's stable baseline (archetype, core
  competition aptitudes, identity, backstory, baseline temperament) is **static `CHARACTER`**
  ("facts"); evolving state — current **emotional** state, accumulated memory, leanings, and
  **relationship beliefs** — is the **dynamic `SOUL`** (md + vector). Relationships are **not**
  binary ally/enemy flags: they are directed, graded, asymmetric, uncertain beliefs
  (trust/affinity/threat…) computed from event history, and any "ally / best-friend / enemy"
  label is **organic and emergent** — read through the holder's own character framing, never
  stored (`docs/decisions/0002`). The competition **emotional modifier** (a baseline that grows
  more or less volatile with circumstances + temperature) and the veto "Houseguest's Choice"
  both read the dynamic soul. See `docs/decisions/`.
- **The player forms their own reads (human-driven).** The engine computes both `NPC→player` and
  `player→NPC` relationship edges from history — but **never shows the player a number** and never
  asserts how they feel ("you trust them"). Player-facing surfaces show **facts the player knows +
  observable houseguest behavior**; the player **infers** trust and threat themselves. Paranoia and
  loyalty are the human's to form (features 0017/0020/0023). The model is computed and hidden; the
  *feeling* is theirs.
- **Temperature is per-moment, not a global knob.** Each gameplay moment rolls temperature
  across *all* involved variables (outcomes, expression, NPC initiative, which secret
  surfaces, alliance shifts, volatility…). It governs variance/surprise but **never** overrides
  hard rules (eligibility, the Vault Wall) or archetype-grounded outcome weighting. Drive it
  through the seedable `RandomnessSource` so distributions are testable.
- **Bidirectional scenes.** NPCs hold goals from their profiles that make them approach the
  player, *and* the player can initiate. Neither side initiates everything.

## Canonical game mechanics (from the legacy Game Bible — still authoritative)

- **Cast:** 16 houseguests (player + 15 NPCs). **Jury of 9. Final 2.** Classic format, no
  core-structure twists (one or two production twists may be held in reserve).
- **A "week" = one HOH reign** (HOH comp → eviction), not seven calendar days.
- **Veto competition:** **six** players — the HOH, the two nominees, and **three by chip
  draw**. One chip is **"Houseguest's Choice"**: whoever draws it picks the sixth player
  instead of a random name (NPCs choose by soul motivation — their strongest available bond
  per the relationship model, `docs/decisions/0002`). The player can't influence which chips
  are drawn, but may hold Houseguest's Choice if drawn.
- **Eligibility/legality (hard rules):** the **outgoing HOH cannot play** for the next HOH;
  the **veto winner cannot be named replacement nominee**; all houseguests except the HOH and
  the two nominees vote at eviction (HOH breaks ties).
- **Eviction votes are secret ballots** (audit E12): the staged reveal reads anonymized ballots
  ("a vote to evict …"); per-voter attribution unseals **only** in the 0048 post-season
  retrospective. The player authors their **own goodbye messages** (a `goodbye-message` pending —
  tone is the player's choice; the engine never speaks for them, E34), and a player-juror asks
  their **own finale question** (E37).
- **Competition stats:** **Physical, Mental, Social** (no Luck stat). Outcomes are weighted by
  relevant stat vs. competition type + **temperature** plus an **emotional modifier** sourced
  from the houseguest's soul — **never** story convenience; the engine never protects the
  player. Emotional state is a *character/soul* attribute, not a fourth competition stat. The
  player may declare intent (compete / throw / play safe) before a comp and cannot change it
  retroactively.
- **Staged competitions (0006) are presentation over ONE roll.** An endurance comp resolves as a
  single calibrated `resolveCompetition` roll **up front** (byte-identical to the non-staged model),
  then plays out as a **presentation-only** staged elimination: the crown and the full drop order are
  fixed, and the per-round `comp-elimination` beats are **inert** (no rng, no fold, no soul inflection),
  so the staging can never perturb the winner or any downstream seeded roll. **Changing the staging is a
  calibration footgun** — `tests/unit/stagedTrajectoryNeutral.test.ts` is the byte-identity guard. Drops
  are **batched to ~4–8 rounds/comp** (`STAGED_TARGET_ROUNDS` in `liveSeason.ts`; owner ruling
  2026-06-20), and **only the first `comp-round` approach binds** — later rounds are non-binding flavor
  (the `binding` flag on the pending/`PendingDecisionView` drives the FE to render them as color, not a
  fresh decision). Lives in `src/engine/liveSeason.ts` (`advanceCompetition`) + `competitionOutcome.ts`.
- **Daily-event invariant:** every in-game day contains ≥1 meaningful event
  (comp, nomination/veto ceremony, vote/eviction, or significant house event).
- **Standard weekly cadence:** Day 1 HOH comp → Day 2 nominations → Day 3 veto comp →
  Day 4 veto ceremony → Day 5 eviction, with the next HOH beginning immediately. A genuine
  rest day is a rare producer judgment call, **not** the default.
- **In-game time of day & sleep (feature 0066 / ADR `docs/decisions/0006`; opt-in).** Time-of-day
  (morning → afternoon → evening → night → late-night) is first-class live-season state. Presence (0049)
  is **time-driven**: as the night gets late, NPCs turn in per character, the *awake set* shrinks, and play
  runs out of *people*, not a timer — the player owns their **own** bedtime (no forced curfew). **Sleep is
  consequential:** staying up late applies a **hidden, bounded** rest penalty in `resolveCompetition`
  (`src/domain/competitionOutcome.ts`), beside the soul emotional modifier — the player never sees a number,
  only the later behavior. Time-of-day is a Vault-free projection (a HUD + the player's own rest cue); NPC
  fatigue stays hidden. Governed by ADR 0006 (diegetic, character-driven bedtimes; the bound is the
  emptying house + escalating cost, never a curfew).
- **Jury & endgame:** the final **9 evictees** form the jury; how the player treats houseguests
  on the way out genuinely influences their later vote (jury management is a real mechanic). At
  Final 2 each finalist gives a statement and takes one question per juror. **Ties:** the HOH
  breaks an eviction-vote tie; the **last-evicted juror** breaks a tied jury vote.

## Workflow (BDD/TDD — follow strictly)

1. Translate the `bb-sim-spec.md` §12 invariants into **failing `.feature` files first**;
   implement to green; refactor.
2. **Strict priority order:** Vault isolation (incl. God Mode) → event visibility &
   propagation → behavioral fidelity → replayability/naming → competition eligibility →
   outcomes by stats+temperature → persistence non-degradation → daily-event.
3. Domain core under fast unit tests with the **seeded** `RandomnessSource`.
4. **Property-based tests** for randomness/temperature distributions and for behavioral-
   richness thresholds.

Suggested milestones M1–M8 are in `docs/CLAUDE_CODE_INSTRUCTIONS.md` §12 (start: pure domain
core, then ports + in-memory adapters with Vault/God-Mode isolation green).

## Testing rules (HARD)

- **No names in tests — roles only** (HOH, nominee, evictee, veto winner, NPC, player).
- **Sample saves are FORMAT ONLY.** Never ingest their *content* as canonical, seed, or test
  data. This includes the example persona and names in `docs/legacy/`.
- A player-facing **or admin** path isn't done until a test proves it returns **no** Vault data.
- Test that off-screen NPC life **exists** and that witnessed events are **not** secret.

## Hard "do-nots"

- Don't hold game state in a chat context window as the source of truth.
- Don't hard-code a **fixed cast** (ruling #1, 2026-06-10): name corpora are raw material, but no
  full-name+persona pairing may be hard-coded, and the legacy Bible's names stay banned. (NPC names
  are model-authored at casting and validated by the engine (owner kept this, 2026-11-11, card 31); the vendored real-name
  corpora are raw material — never a fixed list, never a paired identity.)
- Don't reference names in tests; don't ingest sample-save content as data.
- Don't rely on prompt wording for the Vault Wall — enforce it in code.
- Don't let the narrative layer decide or alter outcomes.
- Don't expose Vault contents to **anyone** at runtime, including admin/God Mode — with the **single
  owner-ruled DEBUG exception** `producerVault` (the quarantined, out-of-band, admin-only, explicit-unseal
  live-Vault dump; see mandate #2). Never extend Vault exposure beyond it.
- Don't mislabel player-witnessed events as off-screen/secret.
- Don't let persisted detail degrade over time.

## Building & testing

Stack: **TypeScript / Node 22**, hexagonal, pure domain core. Test lanes: **Vitest**
(unit/property), **Cucumber.js** (the executable `.feature` specs), **fast-check** (used
selectively — most "property" suites are seeded fixed-loop distribution tests, which is
adequate for their claims; audit T18), and **dependency-cruiser** (the *structural* Vault-Wall
test — proves no outward module imports `VaultStore`/`VectorIndex`, type-only imports
included). Datastore: the default runtime is **in-memory + file**; a **SQLite (`better-sqlite3`) +
sqlite-vec** save store is **built and opt-in** (`ORWELL_STORE=sqlite`, engine-only, #330). **Postgres
+ pgvector** are the next tier behind the same ports (still deferred).

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (dev toolchain + three pinned-exact runtime deps: `fastembed`, `better-sqlite3`, `sqlite-vec`). |
| `npm test` | Full gate: `typecheck` → `build` → unit/property/arch → BDD. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | Bundle the engine to `dist/main.js` + the embedding worker to `dist/embedWorker.js` (esbuild; `fastembed`, `better-sqlite3`, `sqlite-vec` stay external). |
| `npm start` | Run the built engine — the HTTP MCP server: the REST-ish tool API (`/:channel/{tools,call}`) **plus** an additive MCP/JSON-RPC 2.0 envelope (`POST /:channel/rpc` — `initialize`/`tools/list`/`tools/call`, notifications + batch; same auth/isolation guardrails). The SSE server-push stream is unimplemented and unneeded (no server-initiated messages). `ORWELL_ENGINE_PORT`, default 8765; `ORWELL_PORT` / `BBAI_*` are legacy fallbacks. |
| `npm run test:unit` | Vitest — unit, property, and the dependency-cruiser boundary test (the WHOLE suite, incl. the heavy sims). |
| `npm run test:unit:fast` | Vitest minus the two heavy simulation files (`tests/uat/**` + `juryReach`); what CI's `test` job runs via `test:ci`. |
| `npm run test:heavy` | Just the heavy simulation files (the full-game UAT — now three split files — + the juryReach and calibration-gradient gates); CI's parallel `heavy-sims` matrix runs them one-file-per-runner via `test:heavy:{uat-12seed,uat-5seed,uat-decisions,jury,gradient}`. |
| `npm run test:bdd` | Cucumber.js over the **implemented** `.feature` files. |
| `npm run test:arch` | dependency-cruiser CLI (forbidden-edge report). |
| `npm run test:cov` | Vitest with v8 coverage (excludes `src/ports/**`, `src/main.ts`, and the heavy sims — the v8-instrumented re-run of which added no gated-dir branch coverage). |
| `npm run test:ci` | The `test`-job composite: `typecheck` → `build` → `test:unit:fast` → `test:bdd` (the heavy sims run in the parallel `heavy-sims` job). |
| `npm run test:watch` | Vitest watch mode. |

- Single unit file: `npx vitest run tests/unit/visibility.test.ts`.
- Single BDD scenario: `NODE_OPTIONS='--import tsx' npx cucumber-js docs/features/0001-vault-wall-isolation.feature:LINE`.
- `cucumber.cjs` `paths` lists only the **implemented** features; add the next `.feature` there as each is built to green (priority order). It is the canonical list of what is wired into the BDD gate.
- **Test setup:** `tests/support/sandbox.ts` is the canonical test-environment factory — use it (not manual wiring) when adding new unit or integration tests. BDD step definitions use `features/support/world.ts`.
- **UAT lane:** the full-game UAT plays full games to completion; it is split across `tests/uat/fullGameUat.{12seed,5seed,decisions}.test.ts` (shared driver in `tests/uat/fullGameUatHarness.ts`) so its independent blocks fan out across separate CI heavy-sims runners. The 12-seed and 5-seed blocks bypass HTTP (direct callTool) to avoid CI stale-loop flakes; the decisions block drives real HTTP. All run as part of `vitest run`.
- **Runtime env:** `ORWELL_DATA_DIR` is the per-user save dir (default `.orwell-data` — the factory-reset script must scrub it). `ORWELL_STORE=sqlite` selects the built SQLite + sqlite-vec save store (engine-only, #330); unset ⇒ the default in-memory + file path. **Pure turn-driven is the ONLY mode** (ruling 2026-06-10 + **real-time purge 2026-07-10, PO ruling**: the game clock is the player's play-clock; the house lives between the player's own turns via one bounded off-screen tick per turn and does **not** exist while the player is away — NPCs can't leave the house, the player can, so background advances during an absence are a structural disadvantage). **There is NO wall-clock watcher and NO real-world clock** — the old `GameWatcher`/`SystemClock`/`ORWELL_WATCHER_*` surface was **deleted, not disabled** (in no version can the house run in real time); the runtime `Clock` is a pure **`LogicalClock`** (a fixed-epoch play-clock advanced one step per committed mutation, never `Date.now()`), which also makes 0108's golden record/replay deterministic for free. HTTP edge: `ORWELL_ENGINE_HOST` (default loopback), `ORWELL_ENGINE_TOKEN` (shared secret on every tool route), `ORWELL_ENGINE_ADMIN_TOKEN` (a **separate** secret for `/admin/*` — player ⊉ admin, audit E27), `ORWELL_ENGINE_MULTIUSER` (reject a missing `x-orwell-user` instead of routing to "default"). Semantic recall: `ORWELL_EMBEDDINGS=fastembed` (the deploy default; unset ⇒ deterministic fake), `ORWELL_EMBED_CACHE` (model cache dir), `ORWELL_TEST_FASTEMBED=1` (opt-in real-model integration test — tests never depend on real embeddings otherwise).
- **Front-end tests:** `cd frontend && python3 -m pytest tests/` (its own pytest gate, quarantined — never touches `cucumber.cjs` / `npm test`); `frontend/scripts/boot_smoke.py` boots the real app and proves the game-build gating server-side; `frontend/scripts/browser_smoke.py` is the headless-browser keep-set gate; `frontend/scripts/responsive_matrix.py` is the viewport×surface matrix gate (Stream S, ruling #16 — overflow/overlap/tap-target checks with an XFAIL registry). The reduced game surface is controlled by `ORWELL_GAME_BUILD` (default **on**; `=0` restores the full inherited workspace).
- **Running locally (two processes):** the engine and front-end are **separate services**. Engine — `npm run build && npm start` (HTTP MCP on `ORWELL_ENGINE_PORT`, default 8765). Front-end — `cd frontend && python3 -m uvicorn app:app --host 127.0.0.1 --port 7000`, pointed at the engine via `ORWELL_ENGINE_MCP_URL` (default `http://127.0.0.1:8765`); it consumes **only** Vault-free projections (handshake in `frontend/INTEGRATION.md`). `deploy/smoke.sh` boots both and drives a full turn end-to-end (the same path CI's deploy-smoke job runs).
- **Live (real-LLM) manual testing:** every automated gate **stubs the LLM** (`DeterministicNarrator`/`Echo…`),
  so the real player journey (casting interview → in-character narration → the agent loop) is exercised
  **only** by wiring a real model into the FE: `POST /api/model-endpoints` with the provider `base_url` +
  `api_key` (admin-gated, but `require_admin` short-circuits when `AUTH_ENABLED=false`), then set
  `default_model` + `default_endpoint_id` in `frontend/data/settings.json` (read per-request — no restart).
  `GET /api/default-chat` confirms what resolves. This is the path to reproduce LLM-only bugs (tool
  under-calls, narration desyncs) the gates can't see.
- **GitHub API quota (overseers/agents):** every session + GitHub MCP call using the SAME user
  credentials shares ONE per-user REST pool (GitHub App installation tokens have their own bucket) —
  a `403` may be pool exhaustion (rolling hourly window) OR a secondary limit: read the error body +
  `Retry-After`/`x-ratelimit-remaining`/`x-ratelimit-reset` and follow the indicated timing. Verify
  via local git (no REST quota), webhook-wake not tight-poll, pace batched API work, and **serialize
  mutating calls — NEVER fire `create_pull_request`/`merge_pull_request` in parallel in one turn; even
  two at once trips the secondary (abuse) limit regardless of hourly headroom, so issue them one at a
  time** (verified 2026-07-13: two parallel PR-opens 403'd both, the same calls one-at-a-time
  succeeded instantly). Full discipline + escalation paths: `SOUL.md` lesson 23.
- **CI** (`.github/workflows/ci.yml`, #351): **per-job path-filtering** + **sharded heavy lanes** under a single required check. A `changes` job emits booleans; each job gates on the relevant paths (a docs-only/FE-only PR skips the engine + heavy lanes) and a unified **`ci-gate`** (always-runs, `success`/`skipped` ⇒ pass) is the one required check — deadlock-free on an all-skip. Jobs: the engine gate (`npm run test:ci`: typecheck → build → unit/property/arch minus the heavy sims → BDD), the **heavy-sims** lane **sharded** for wall-clock (UAT 12→3 `uat-12seed-{a,b,c}`, `uat-5seed`, `uat-decisions`; **jury** 20→5 `jury-shard` + `jury-aggregate`; **gradient** 6→2 `gradient-shard` + `gradient-aggregate` — each shard plays a disjoint seed slice, the aggregate recombines and asserts the full band; every heavy lane now < ~3 min), the coverage gate (`npm run test:cov`, per-directory **branch thresholds** in `vitest.config.ts`: engine 90 / composition 88 / adapters-engine 82 — ratchet up only; heavy sims **and** the calibration data instrument `tests/calibration/**` excluded), the deploy smoke (`bash -n` every script + `deploy/smoke.sh`, which boots the real engine **and** front-end and drives a full turn), and the front-end jobs — **`fe-unit`** (py_compile → the ~3750 non-browser pytest tests **parallel** under `pytest-xdist -n 4` → JS syntax check; ~1.5 min vs the old ~12.5-min serial run), **`fe-browser-tests`** (the ~100 `sync_playwright` tests — auto-marked `browser` in `frontend/tests/conftest.py` — run **serial with `--reruns 1`** so the known onboarding-scrim flake #925/#1148/#930 self-recovers), plus **`fe-browser`** (boot + browser smoke) and **`fe-responsive`** (viewport matrix). Every job carries a `timeout-minutes` cap and a per-test `pytest-timeout` (`frontend/pyproject.toml`) so a wedged test or a runner blip fails fast instead of hanging. **Runners are gh-hosted `ubuntu-latest`** (2026-07-11, #1360 — the contended self-hosted fleet was retired; free + unlimited on the public repo); each Playwright job installs with `python3 -m playwright install --with-deps chromium` (system libs are no longer pre-baked).

- **The golden-path fixture apparatus was DECOMMISSIONED (2026-07-21, owner directive).** The real-model `golden-path` record/replay gate (0108) and its two screenshot siblings that rode the same committed fixture — `visual-regression` (0113) and `theme-consistency` (0114) — were **removed entirely**: the committed fixture, the record/replay scripts + the `src/golden_path.py` seam, the harness scripts + `src/visual_*` / `theme_probe` modules, the three CI jobs, `golden-nightly.yml`, and their unit gates are all gone. They were advisory / non-gating (excluded from `ci-gate.needs`), perpetually stale (a fixture treadmill on every prompt/tool-schema/casting-finalize change), and hang-prone (#1713 — the casting-finalize → premiere engine-timeout hang). **There is no longer any re-record obligation** — a prompt/schema/casting-flow change no longer stales any fixture. The live model-call chokepoints (`llm_core.stream_llm_with_fallback` / `llm_call_async`) are plain passthroughs again.

- **`live-harness-nightly.yml`** (2026-07-11) runs the LIVE-only player-journey validations the stubbed gates can't see — ADR 0008/0012 two-window mirror + mid-gen join (`_verify_two_window_live.py`, live today), 0080 active-overseer (#766, `_verify_overseer_active_live.py`), and #829 turn-coalescing (auto-arms when its driver lands). Scheduled, **non-blocking** (`continue-on-error` per leg), key-gated on the repo secret **`OPENROUTER_API_KEY`** (a clean skip on a fork / missing secret).
- **`probe-canary-nightly.yml`** (T1-2, this branch) runs the **nightly probe canary** — a ~10-call capability probe (forced-tool_choice honoring, JSON conformance, reasoning-channel separation) plus one scripted ceremony game turn, alarming on a RED or YELLOW overall tier (phantom claims). Non-blocking, **cents-scale**, key-gated on the same **`OPENROUTER_API_KEY`** repo secret (clean skip when absent). This is **NOT** a golden-fixture / record-replay revival (the 0108 apparatus was decommissioned) — it is a live, stateless, per-run probe that saves no replay fixture and carries no re-record obligation.
- **Deploy** (`deploy/`): the repo is **private** (ruling #17) — `orwell.sh` (run on the Proxmox host) creates the LXC, persists the one-time `GIT_TOKEN` PAT into `data/.env` with a git credential helper, and runs `orwell-install.sh` (apt + Node 22 + Python, pinned `requirements.lock.txt`, systemd units from `deploy/systemd/`, hardened per E85; UI ports <1024 get a `CAP_NET_BIND_SERVICE` drop-in; optional `CT_ROOT_PASSWORD` for console login). Maintenance scripts are host-aware (bridge into the LXC via `pct`), run from the **local checkout** (never a GitHub fetch of branch tips), and fall back to a legacy container named `bbai` (ruling #6): `orwell-update.sh` (also `--set-token` for PAT rotation) — **live-game guard (ORW-206):** a plain update first DEFERS while a player has chatted in the last `ORWELL_UPDATE_IDLE_MINUTES` (15), re-checking until idle, capped by `ORWELL_UPDATE_MAX_DEFER_MINUTES` (240); `--force` / `ORWELL_UPDATE_FORCE=1` skips it; status in root-owned `/run/orwell/update-deferred` + the admin Update page + `orwell-doctor.sh --status`; web force flag `data/ops/update-force-requested` (logic: `deploy/orwell-live-game.sh`) · `orwell-doctor.sh` (diagnose/bounce) · `orwell-backup.sh` / `orwell-restore.sh` · **three reset tiers** — `orwell-game-reset.sh` (new season: clears every engine sandbox, **preserves** accounts/sessions/LLM config/`data/.env`, ruling #2) · `orwell-oobe-reset.sh` (back to OOBE, **keeps the API key(s) + provider endpoint; RESETS the selected models to the OOB defaults** — narrator + utility `deepseek-flash` on DeepSeek's own API (PO 2026-11-02/03, #1935; the earlier OpenRouter pair was `z-ai/glm-4.7` + qwen). **Existing-install exception:** an install that already has endpoints but none on a DeepSeek host keeps its prior effective models: at the next startup `pin_legacy_model_defaults` (`frontend/src/deepseek_seed.py`) re-saves `z-ai/glm-4.7` (narrator) + `qwen/qwen3.6-27b` (utility) for whichever of the two is unsaved, so after a reset such an install stays on its existing provider with that pair, not DeepSeek (only new installs, and installs that already have a DeepSeek endpoint, get the DeepSeek default). The portrait default is unaffected., portrait `google/gemini-3.1-flash-image` on OpenRouter — ADR 0016 as amended (this doc previously drifted, still naming the pre-ADR-0016 `deepseek/deepseek-v4-pro` narrator / `gemini-2.5-flash-image` portrait defaults; `frontend/scripts/oobe_reset.py`'s own in-code comment is the source of truth) — via `frontend/scripts/oobe_reset.py`, issue #860; wipes the rest of the FE store) · `orwell-factory-reset.sh` (the host "factory reset" — now **delegates to `orwell-oobe-reset.sh`** so "factory reset" keeps your LLM credentials everywhere, matching the admin **Factory Reset (OOBE)** button + the `orwell-ops-factory-reset` unit; preserves API key(s)/endpoint + `data/.env`, **resets selected models to defaults**, wipes everything else) · `orwell-login-panel.sh` (the interactive-shell health panel, ruling #21 — never blocks a login) · the **`orwell` control panel** (`orwell-menu.sh` + the shared whiptail helpers `orwell-tui.sh`, installed as `/usr/local/bin/orwell`) — a TUI menu wrapping update/doctor/backup/restore/resets/ready; the maintenance scripts also show inline whiptail dialogs (token password box, type-`RESET` confirm, doctor mode picker) on a TTY and stay fully non-interactive (flags/env) for automation/CI/the `pct` bridge — `whiptail` is apt-installed, absent ⇒ plain-prompt fallback · `orwell-ready.sh` · `deploy/smoke.sh` + `smoke_turn.py` (post-deploy checks). Front-end (`frontend/`, Python/FastAPI) is its own quarantined app — see `frontend/INTEGRATION.md`. **(2026-07-13 reconcile hardening.)** The load-bearing invariant: **`orwell-update.sh` must RECONCILE onto an existing box everything `orwell-install.sh` establishes** — the class of bug where install adds something (a flag, a unit, a cap) that update never backfills, so a box installed *before* it silently runs degraded forever (the "embeddings always degraded" + "no scheduled backups / unrotated logs" symptoms were this). `update.sh` now reconciles: the opt-in `.env` defaults (single shared source **`deploy/orwell-env-defaults.sh`**, consumed by BOTH install's `write_config` and update — so drift is structurally impossible), the security keys (`ORWELL_ENGINE_MULTIUSER` backfilled, `ORWELL_ENGINE_ADMIN_TOKEN` **minted-if-absent**, never copied — audit E27), the systemd units + `orwell-backup.timer` + logrotate/journald, ownership (the **code tree is root-owned**; only `data/`/`DATA_DIR`, `frontend/data`, `backups/`, `.orwell-data` go to the service user, via the one `orwell_apply_ownership` function kept byte-identical in install + update — an update migrates an old `orwell`-owned tree; + drop-priv `sqlite3` via `runuser` so no root-owned `app.db-wal`), and the fastembed model prefetch (to the `.env`-resolved `ORWELL_EMBED_CACHE`). **Guarded by a deploy-reconcile drift test** (install opt-in set ⊆ update-reconciled set + shared-source parity) + new `orwell-doctor.sh` warns (backup-timer-absent / logs-unrotated / flags-missing / admin-token-absent / root-owned store). `orwell-restore.sh` is an **atomic move-aside replace** (not an overlay — the old overlay-extract silently no-op'd the monotonic-versioned engine save tier and unioned stale portraits) and **KEEPS the live `data/.env`** (game state rolls back, host exposure/TLS/`GIT_TOKEN` do not); `frontend/scripts/oobe_reset.py` rebuilds `app.db` via `os.replace` (crash-safe). All idempotent/no-clobber; but the **host-only paths (systemd/chown) are `install.sh`-parity-traced, NOT CI-validated** — the owner confirmed (2026-11-02) the deploy runs in production on their Proxmox host, which exercises the `pct`/`pvesh` bridge end to end.

**Source layout:** `src/domain` (pure core, no I/O) · `src/ports` (interfaces — `VaultStore`,
`VectorIndex`, `EmbeddingProvider`, `SoulProvider` are **engine-only**; outward ports include
`EngineCommands`, `GameSession`, `NarrativePort`/`StreamingNarrativePort`, `ImageGenerationPort`
(0051 — **outward by construction**: the engine emits only Vault-free portrait prompts, the FE owns
the concrete provider), `SaveStore`/`UserSaveStore`) · `src/services` (`VisibleStateService` / `SummaryService` — outward-safe) ·
`src/surfaces` (`player/`, `admin/`, `tools/` — no Vault handle by construction) · `src/adapters`
(`inmemory/`, `engine/` (the live `GameSessionAdapter` / `EngineCommandsAdapter`, `FileSaveStore`,
`SoulStore`), `mcp/` (`McpServer` / `HttpMcpServer`), `narrative/` (`LlmNarrativePort`,
`DeterministicNarrator`, `Echo…`), `embedding/` (`FastembedEmbedding` + its worker-thread bridge,
`DeterministicEmbedding` — the test adapter and runtime fallback), `image/`
(`NoopImageGenerationPort` — the null adapter used when no image-capable provider is wired; 0051),
`random/`, `time/`) ·
`src/engine` (the season loop `season.ts` + the live loop `liveSeason.ts`, plus `conversation.ts`,
`relationships.ts`, `consequence.ts` (the original 0023 hidden-impact fold module — the **live**
folds run in `GameSessionAdapter`/`EngineCommandsAdapter`), `gossip.ts`, `offscreen.ts`,
`confessionals.ts`, `deals.ts`, `blocs.ts`, `presence.ts`, `emotionalArc.ts`,
`competitionLibrary.ts`, `houseEvents.ts`, `castingIntake.ts`, `momentPrompts.ts`,
`portraitPrompts.ts` (the Vault-free, public-facets-only portrait-prompt builder) +
`imageConstants.ts` (0051 per-turn/-week generation budget caps), `data/` (the
vendored real-name corpora), and tunable constants) · `src/composition`
(`engineRoot` wires the Vault; `outwardRoot`/`appRoot` never do; `orchestrator.ts` is the
per-sandbox **commit/integrity spine** with a fail-closed checkpoint — game advances also flow
through the session's `advanceGame`/`submitDecision`, with the orchestrator as the commit hook —
over a `registry` of per-user sandboxes; `runtime.ts` composes the pure turn-driven runtime from
`src/main.ts` (**no background watcher, no real-world clock** — the house lives one bounded
off-screen tick per committed player turn, on the fixed-epoch `LogicalClock`; real-time purge
2026-07-10). **There is ONE sanctioned season-restart door**
(audit D1/R1): `registry.resetUser` → `Orchestrator.forgetUser` + save-dir rotation — the
player channel's confirmed `createCharacter` restart delegates through that same hinge, a
refused commit throws typed (409, never 200-then-rollback), and `POST /api/orwell/new-game` is
admin-gated. Never add a second restart path. BDD steps + support in `features/`; unit/property/
architecture/integration tests in `tests/`. The
`.feature` files in `docs/features/` remain the source of truth. The **player-facing tier** is the
vendored **Orwell** front-end in `frontend/` (Python/FastAPI) — its own app, quarantined from the
TS tooling (see `frontend/INTEGRATION.md`).

## Current status

**Built BDD/TDD-first and feature-complete through the originally-drafted spec set (0001–0074).** The eight
priority invariants, the MCP seam, the full weekly loop, per-user sandboxes, durable persistence, the
live off-screen society, the endgame + interactive finale, the character-evolution linchpin (0041),
deep character profiles (0058), seasons-as-levels, multi-device sync (0064), the LLM↔engine sync spine
(0065), in-game time + the sleep economy (0066 / ADR 0006), public-internet exposure (0067/0068 / ADR
0007), the token economy + usage envelope (0069), off-screen texture enrichment (0070), defensive
hardening (0071), the multi-platform gateway (0072), the structural anti-sycophancy game-build wall as
a CI gate (0073), and local & tunable HTTPS (0074 / ADR 0014) are all in. **Past 0074 the spec set runs to 0110**:
**0075–0096, 0099–0102, 0104–0107, 0109, 0110** are built (trust-gated confidences, presence/eyeshot & motivated
movement, the runtime overseer 0079–0081, character voice/campaigns/drives, secrets-as-power,
jury grudge book, season notoriety, named alliances, deal duration, vote deduction, NPC myth-making 0101,
the daily recap 0102/#884, and — shipped in the 2026-07-06 closure session — distorted-gossip
consequences 0094 (scoped: a new `confront` lever, not a nominate/vote retrofit — an owner-flagged
design call), pre-show ties as time-bombs 0095, and emergent nemesis 0096), while **0097/0098/0103**
are **retired and removed** (owner, 2026-11-11: "Retire and remove is fine."; ORW-267; they had been parked "not planned" 2026-06-27) and
**0108** (the real-model golden-path gate) was **DECOMMISSIONED 2026-07-21 (owner directive)** — the fixture, record/replay seam, the `golden-path` PR job, and `golden-nightly` were removed entirely (advisory/non-gating, perpetually stale, hang-prone #1713).
**0022** (the rich game UI / MVP-2) was **removed** in the 2026-06-28 PO review — by ADR 0003 the chat *is*
the UI, and its goals were delivered chat-forward via 0020/0051/0054, so the standalone dashboard spec was cut.

**Since 2026-07-07 (reconciled 2026-11-02):** the drafted spec set now extends to **0132** —
**0111** (the Day-1 experience) and **0112** (LLM-call observability) are **built** (2026-07-10);
**0113** (visual-regression harness) and **0114** (theme-surface consistency) rode the same 0108 golden fixture and were **DECOMMISSIONED with it (2026-07-21, owner directive)**;
**0115–0127** and **0130** are **built** (the Diary Room confessional, model-authored cast genesis, the
in-game-time pivot 0117–0119, strategic cadence, deal depth, deeper confessionals, NPC-initiated deal offers
(amended 2026-11-01: an open, non-blocking offer voiced in chat — never a pop-up), deeper character
evolution, competition variety/mechanics/mixed types, exit interviews); **0128/0129/0131/0132** are
**spec-only**. `docs/features/README.md` is the per-feature source of truth. **Ship-gate F5** (realtime two-window mirror
parity) is **fixed and wired as a required CI gate** (#1276, 2026-07-09) — no longer a launch blocker.
A **WebSocket transport** (ADR 0017/0018; spec `docs/design/websocket-phase1-protocol.md`) is the
**only** live transport of the game build (ORW-44, 2026-11-12): the `ORWELL_WS_TRANSPORT` rollback flag is **deleted**, and the
game build refuses the SSE/poll endpoints (`/api/chat/events`, `/api/chat/resume`, `/api/chat_stream`) with **426 ws-only**.
The non-game build keeps its SSE/poll stack. The two-window mirror gate is WS-only, and browser/e2e turns are driven through
`frontend/tests/_ws_turn_driver.py`. The full client/server/layout stack is merged (#1283–#1287, #1293) and ADRs 0017/0018 are
**Accepted**. The owed Phase-2 item is now the live two-window verification cadence
(`live-harness-nightly.yml`). The **Apple-HIG audit (#694)** shipped all findings bar F-CHROME-1, and the
**#660 game-build window-kit migration** is done (the Theme-window drag, #1289, was the last game-build
residual); the **#738 Liquid-Glass legibility/a11y batch** is substantially shipped (residual tracked
in issue #738). The 2026-07-07 **FE↔BE integration gap review**
(`docs/audits/2026-07-07-fe-be-integration-gap-review.md`) is being executed via the **M1–M4 build
lanes** (`frontend/tests/test_m{1,2,3,4}_*.py`).

**Trust the code over this prose — it drifts.** The authoritative sources, in order:
- `docs/features/README.md` — the per-feature status index, reconciled against the source (built /
  spec-only / deferred, with each feature's verification gate).
- `cucumber.cjs` `paths` — the live list of BDD-gated features.
- `docs/audits/2026-06-10-full-product-audit.md` (the close-out ledger) — the authoritative open-items
  list going forward, and `docs/audits/2026-06-21-open-items-verification.md` — the source-verified,
  tier-organized snapshot of every open item as of **2026-06-21** (which tracker rows were stale then;
  no launch-blockers remain). It predates the entire 0075–0112 batch — for anything after 2026-06-21,
  `docs/features/README.md` is the source of truth, not this snapshot.
- `git log --oneline` for what last merged green; `npm test` for the authoritative pass/fail.

**A few load-bearing invariants worth knowing up front** (enforced in code; easy to violate by accident):
- `runCompetition` is the **single outcome authority** — `resolveCompetition` is not on the player
  channel — and `recordInteraction` requires the player actually witnessed the scene.
- The live engine-side narrator is `EchoNarrativePort`; **narration happens in the front-end** via
  `getMomentPrompt` (the `setNarrator` seam exists if engine-side narration is ever wired).
- Souls evolve live (`src/engine/emotionalArc.ts`) and bend the competition modifier; `CHARACTER` stays
  byte-stable; no number ever crosses to the player.

**Open forward work** (new work starts as a new spec/queue item; the close-out ledger is authoritative).
*A source-verified, tier-organized snapshot of every open item — and which tracker rows are stale — is
`docs/audits/2026-06-21-open-items-verification.md` (no launch-blockers remain):*
- **Calibration tuning — re-measured 2026-06-21, primary goal MET; no change pending.** The
  `JURY_WEIGHTS.gameRespect` 0.9→0.7 drop (PR #364) + engine evolution flipped the old inversion: on
  current main a 30-seed instrument run shows **active wins 20% vs passive 7%** (F2-blowouts 50% vs 63%) —
  playing the game now converts. **Do NOT lower `gameRespect` further** (0.65 would over-correct a solved
  problem). Residual (optional, low-pri): passive still *reaches* F2 about as often (a reach-side lever,
  `decisionConstants.juryManagementWeight` / audit #4, if desired) — reads as emergent realism, not a
  defect. The `tests/property/juryReach.property.test.ts` `EARNED_WINS` guard stays the permanent gate.
  Re-measurement + the stale-doc flags: `docs/audits/2026-06-21-session-observations.md`.
- **ADR 0006 / 0066 Phase-2 — on the PO review list.** Deferred time/sleep extensions: NPC *next-day*
  social fatigue, a compounding multi-night fatigue meter, and per-conversation clock advance (vs. the
  current per-beat) — owner decisions in `docs/features/0066-in-game-time-and-sleep.md` §9.
- **0022** (MVP-2, the rich game UI) was **removed** in the 2026-06-28 PO review (superseded by
  0020/0051/0054 under ADR 0003) — there is no longer a deferred/parked MVP feature. *(0059 hidden seeded
  relationships is **built** — `src/engine/seededRelationships.ts` + `seededRelationships.test.ts`,
  orientation-aware via 0063; this line previously mis-listed it as spec-only. Reconciled 2026-06-21.)*
- **Postgres + pgvector** relational tier — MVP-002 post-launch scale-out (SQLite + sqlite-vec shipped
  opt-in, #330); only matters past a single-host deploy.

## Open decisions (remaining)

**Resolved:** tech stack, datastore, and vector adoption (above); soul storage = markdown +
vector behind `SoulProvider`; non-degradation strategy = superset + monotonic-count + lossless
round-trip (`docs/features/0007-persistence-non-degradation.md`); drop Luck → emotional
modifier; Character/Soul split; organic relationship model; veto "Houseguest's Choice"
(`docs/decisions/`). **Mostly resolved — none block current work:**

1. ✅ **Temperature & emotional-modifier constants** — **resolved**: the *shape* is fixed in
   `docs/features/0006-…` / `docs/decisions/0001`, and the numbers are firmed into the single tunable
   module `src/domain/temperatureConstants.ts` (**feature 0028**). Only fine-tuning remains.
2. ✅ **Relationship-model math** — **resolved** by **feature 0026** (`src/engine/relationshipConstants.ts`):
   signal set, update rule, recency/decay, betrayal-shock, thresholds (promotes `docs/decisions/0002`).
3. ✅ **Jury choreography** — **resolved** by **feature 0037** (the live interactive finale: statements →
   per-juror questions → ordered vote reveal). Reserve twists stay Vault-held (0025).
4. ✅ **Embedding provider** — **decided AND built** (ADR `docs/decisions/0004`; E86a,
   2026-06-11): **fastembed, local ONNX** (the JS port + model both version-pinned) is the
   runtime `EmbeddingProvider` — warmed up at boot (`ORWELL_EMBEDDINGS=fastembed`, the deploy
   default), served synchronously through a worker-thread bridge, with the deterministic fake
   as both the test adapter and the whole-process fallback when the model is unavailable.

5. 🆕 **In-game time, sleep & the nightly presence economy** — ADR `docs/decisions/0006`, built **opt-in** as
   feature **0066** (time-of-day on the live season; presence 0049 made time-driven — the awake set shrinks as
   NPCs turn in per character, the player owns their **own** bedtime, no curfew; a hidden bounded **rest** term
   beside the emotional modifier in `src/domain/competitionOutcome.ts`, never shown to the player). Only *tuning*
   is open — the bound's exact feel, and whether sleep cost reaches past competitions — per ADR 0006's
   "Open / to confirm".

6. ✅ **Public exposure, cross-device consistency, location, token economy, the live mirror & local HTTPS** — ADRs
   **0007–0014**, all **accepted and built** (features 0067/0068 public exposure, 0069 token
   economy/usage envelope, 0074 local & tunable HTTPS (ADR 0014), and the 0008/0011/0012 multi-window seams all shipped). Their *residual* open
   items are **tuning, owed
   verification runs, and post-launch refactor** — **not** unbuilt architecture: the ADR 0010 token-economy
   follow-ons are now mostly shipped — **#1 per-class `max_tokens` runtime-edit** (admin-editable
   `max_tokens_budget` in `token_policy.py`) and **#3 ledger `appliedMaxTokens`/`finishReason`**
   (`orwell_token_ledger.py`) are **DONE (reconciled 2026-07-10)**; still open are **#2 model-aware
   reasoning sizing** and **#4 `Continue ▸` in chat mode**. The ADR 0008/0012 live-LLM two-window
   re-run + mid-gen-join test pin remains owed (the F5 render-parity half is now closed + CI-gated,
   #1276), and the architecture latents filed in `docs/REFACTOR-ROADMAP.md`
   (R1–R7, post-launch — the highest-value being **A-S3**, a stale-409 that can drop a scene's only
   consequence fold). The full source-verified status is
   `docs/audits/2026-06-21-open-items-verification.md`.
