# 0079 — Runtime loop overseer & diagnostic log (diagnose-and-unstick, wide eyes / small hands)

> **Status:** ✅ **Built** (PRs #717, #741) and **shipped DEFAULT ACTIVE** since the owner ruling 2026-07-13 (the `overseer_mode` resolver default is `active`, `frontend/src/overseer.py`; resolution is settings-first, then env, then the `active` default: an explicitly saved `off` setting, or `ORWELL_OVERSEER_MODE=off` when no saved setting overrides it, disables it, while a saved enabled setting beats an env `off`). The text below is the original 2026-06-24 spec, which scoped it opt-in / default off. *(Original status:)* 📝 **SPEC** (drafted 2026-06-24). A **reasoning overseer for the engine↔LLM IO loop**.
> The boundary is *already* supervised today — but by brittle, scattered deterministic heuristics in the
> front-end agent loop (the progression stall-nudge, `_auto_record_scene` (0055), the L39b forced-advance
> ladder, the `markHouseguestMet` auto-belt, the `createCharacter` finalize fallback) that pattern-match
> **one symptom to one fixed action** and cannot tell distinct root causes apart. This feature promotes
> that supervision into an **intelligent overseer** that is **summoned only when needed** (a cheap,
> sparse, symptom-gated trigger — *never* every turn), then on wake **reads the Vault-free telemetry,
> diagnoses the root cause, and applies the one matching fix from a small, fixed, mandate-safe toolbox**
> — or **surfaces and backs off** when the fix is outside that toolbox. Every wake (reads, diagnosis,
> action, outcome) is written to a dedicated **Vault-free diagnostic log, live in the admin panel** beside
> the existing G1b log rings. **Wide eyes, small hands — and the small hands are the *right* hands, which
> is why they never need to be bigger.**
> **Governed by** [ADR 0003](../decisions/0003-the-conversation-is-the-game.md) (error-correct the model's
> *omissions*, never author content) and [ADR 0005](../decisions/0005-split-authority-by-openness.md) (the
> overseer acts only on the **open set**; the **closed set** stays engine-dictated).
> **Executable spec:** [`0079-runtime-overseer-and-diagnostic-log.feature`](./0079-runtime-overseer-and-diagnostic-log.feature)

## 1. Summary

The narration LLM reliably **under-calls** the engine tools: it won't `advanceGame` (the game freezes at a
beat) and won't `recordInteraction` for the player's social scenes (they fold zero impact). The engine is
fine; the *model* skips the call. Today the front-end papers over this with a pile of hard-coded guardrails
(`frontend/src/agent_loop.py` + `routes/chat_helpers.py`). They work, but they are **brittle, scattered, and
unreasoning** — each maps a single condition to a single fixed action, so they can't distinguish *"the model
under-called and the game should advance"* from *"the player is genuinely mid-scene, leave it"* from *"the
model's view drifted from the board."* Same symptom, three different correct fixes. The L39b escalation
**ladder** exists precisely because a heuristic can't diagnose, so it just nudges harder.

This feature adds a **reasoning layer** over that supervision, structured as **two tiers**:

- **A sparse heuristic gate (the *when*).** A cheap, deterministic **symptom net** decides whether the
  overseer is even summoned. It is **wide across symptom *types*** (so nothing real slips past) but **sparse
  in *time*** (a healthy turn trips nothing → no call, no log line). **Breadth ≠ frequency.**
- **An intelligent diagnosis on wake (the *what*).** When a symptom trips, the overseer reads **only
  Vault-free telemetry** (the transcript window, the 0065 `stateDelta`, the 0031 `HealthRecord`, the sync
  ledger, the G1b rings), **identifies the root cause**, and applies the **one matching lever** from a
  small, fixed, **mandate-safe toolbox** — or, when the right fix is *outside* the toolbox, **surfaces and
  backs off**.

Every wake is written to a **dedicated Vault-free diagnostic log, live in the admin panel** — so the
currently-invisible guardrail decisions become a legible, inspectable, interpreted stream (a debug logger
that doubles as the overseer's own audit trail). The overseer is **fail-soft**: unavailable or erroring, the
existing heuristics + the deterministic floor (0031 checkpoint, 0065 sync spine) stand exactly as today.

## 2. What exists today (the gap this closes)

| Capability | Where | Limit this feature addresses |
|---|---|---|
| Progression stall-nudge | `agent_loop.py` | heuristic; **one fixed action**; cannot diagnose a root cause |
| `_auto_record_scene` (0055) | `agent_loop.py` | a narrow constrained extraction call — **gap-repair only**, no triage |
| L39b forced-`advanceGame` ladder | `agent_loop.py` | a **blunt escalation** standing in for diagnosis ("nudge harder") |
| `markHouseguestMet` auto-belt, `createCharacter` finalize fallback | `chat_helpers.py` | each a **bespoke patch** for one seam; the list only grows |
| Integrity checkpoint (0031) | `orchestrator.ts` | the deterministic **floor** — correct, but it only *refuses*; it never *unsticks* |
| Sync spine: `beatSeq` / 409 `stale-beat` / divergence ledger (0065) | engine + FE | **mechanical** reconcile; raw counters (`nudgesFired`/`autoBackfills`/`desyncDetected`/`staleRejections`), no interpretation |
| Log rings `LIVE` / `IO` / `LLMIO` (G1b) | `log_rings.py` | **raw** telemetry; an operator must interpret it by hand — nothing says *what it means* |
| A reasoning overseer that diagnoses + unsticks + narrates its own work | — | ⛔ **does not exist** |

Net today: supervision is real but brittle and unreasoning; the failure classes *"the game won't advance"*
and *"social play folded zero impact"* recur (CLAUDE.md names `agent_loop.py` as the first place to look).
Nothing interprets the raw telemetry, and nothing diagnoses **root cause** before acting.

## 3. Scope

**In:** the **`OverseerPort`** + a **`DeterministicOverseer`** stub adapter (mirrors `NarrativePort` /
`DeterministicNarrator`, 0027); the **sparse symptom-gate** (cheap, deterministic trip conditions); the
**wide-eyes diagnosis** on wake (Vault-free inputs only); the **small-hands lever set** (each lever mapped to
one failure mode **and** its mandate boundary); the **escalate/surface** path; the **`OVERSEER` log ring** +
`record_overseer(...)` + the admin `/api/admin/logs` source wiring (live in the panel beside `LIVE`/`IO`/
`LLMIO`); **fail-soft** behaviour; **determinism** (seeded lanes never call a model).

**Out (hard line):** any **closed-set authority** — outcomes (`runCompetition` stays the single authority),
eligibility, the Vault, **persistence integrity** (the 0031 checkpoint stays the floor; the overseer **never**
overrides its rollback); **authored narration / content** of any kind; the narration **faithfulness gate**
(checking that prose doesn't contradict engine truth — a *separate, future* role, deliberately not in this
feature — this one is **pacing + gap-repair + diagnostic logging only**); **replacing** the deterministic
guardrails wholesale (the overseer rides *on top* — the cheap heuristics remain both the gate and the
fail-soft fallback). A durable on-disk `overseer-log.jsonl` archive is **optional** (§4.4) — the live ring is
the floor.

## 4. Design

### 4.1 Two tiers — sparse gate (when) + intelligent diagnosis (what)
**Breadth ≠ frequency.** The gate is a **wide net of cheap, structural symptoms** so no real situation is
filtered out before the smart layer sees it — but each symptom is only *present* sometimes, so a normal
healthy turn trips none and the overseer never wakes (no model call, no log line). Expense relaxation buys
**depth per wake**, not a per-turn tax: **wide net, sparse firing, deep per wake.**

The gate watches **structural facts**, **never the fuzzy judgment the overseer exists to make** (so it can't
become a "dumb bouncer" that only fires when it already agrees with the heuristic it is meant to second-guess):

| Symptom (any one trips a wake) | Cheap source |
|---|---|
| advance-phase pending **and** play has gone quiet | loop phase + engagement signal |
| an engaged player↔NPC scene recorded **nothing** | tool-call tally this turn (the 0055 condition) |
| a flagged desync / 409 `stale-beat` | the 0065 sync result |
| an error or stall on the engine I/O tap | the G1b `IO` ring |
| `beatSeq` didn't move when it should have | 0065 `beatSeq` before/after |
| a repeated tool-skip pattern (Nth this session) | the sync ledger counters |

A symptomless turn → **sleep**. Any symptom → **wake** (one diagnosis pass).

### 4.2 Wide-eyes diagnosis (Vault-free inputs only)
On wake the overseer reads **only Vault-free projections** — the same diet the FE always holds, so it
**cannot leak what it never receives**: the **transcript window**, the 0065 **`stateDelta`** (the O(Δ) "what
changed"), the 0031 **`HealthRecord`** (faults, `circuitOpen`), the **sync-ledger** slice, and the G1b
`IO`/`LLMIO`/`LIVE` tails. It identifies the **root cause** — the value a *reasoning* layer adds over a
heuristic: the **same** symptom has distinct causes that need **distinct** fixes.

### 4.3 Small-but-right hands (the fixed, mandate-safe toolbox)
Each lever is the **correct** fix for **one** diagnosable failure mode, and **conservative** to apply (broad
eyes, careful hands):

| Diagnosis | Lever (the right hand) | Boundary held |
|---|---|---|
| model skipped the advance | nudge → forced `advanceGame` | **triggers** the deterministic advance; **never authors** it |
| engaged scene recorded nothing | propose a constrained `{withIds, kind, content}` record (optionally the Vault-free ADR-0005 `consequence` *shape*) | the **engine still owns the magnitude**; no raw number crosses |
| model's read drifted from the board | re-inject the `stateDelta` | fixes the **input**, never the output |
| symptom present but actually fine | **hold** | does nothing — **and logs *why*** |
| anything else | **surface / escalate** | records a fault to health/log; **backs off** |

**The edge of the toolbox is the same line as the mandate wall.** Every problem the right hands *can* fix is
*"the model skipped a deterministic call"* or *"the model's input drifted."* Every problem they *can't* is, by
construction, **not the overseer's to fix** — an **outcome** (engine's job), a **narration** (authoring), a
**hidden-layer** thing (Vault). So the moment one would ever feel the urge to hand it a *bigger* lever, **that
urge is the signal to escalate**, not a tool that's missing — growing the hand would mean reaching across the
wall, and the right move there was always *surface and hand off*. **No lever authors content, decides an
outcome, or reads/writes the Vault** — the toolbox is mandate-safe *by construction*, because every action in
it is one the FE already pulls and the MCP boundary + the 0031 checkpoint already validate downstream.

### 4.4 The diagnostic log (Vault-free, live in the admin panel)
A **fourth G1b ring** — `OVERSEER` in `frontend/src/log_rings.py` + a `record_overseer(...)` writer — surfaced
as a selectable source in `admin_health_routes.py` (`/api/admin/logs/sources` gains
`{"id": "overseer", "label": "Overseer (live) — diagnoses & corrections"}`; `/api/admin/logs` gains a
`source == "overseer"` branch). It then **inherits** the seq-cursor tail (`Ring.since`), the `require_admin`
gate, the self-contained status-page dropdown beside `LIVE`/`IO`/`LLMIO`, and the debug bundle. Each entry:

```
{ ts, seq, level, kind, reads:[…], diagnosis:"<one line>", lever, beatSeqBefore, beatSeqAfter, ok }
level ∈ { observation, action, anomaly, escalation }
```

- `observation` — a symptom woke it but no action was warranted ("held; player mid-scene")
- `action` — a correction ("diagnosed under-call · nudged · advanced ✓")
- `anomaly` — a handled-but-notable pattern ("model skipped `recordInteraction` — 3rd time this session")
- `escalation` — out-of-toolbox; surfaced and backed off

**Vault-free by construction** — the overseer's *entire input diet* is Vault-free, and the writer **coerces**
its fields (the way `record_io` clips payloads, and exactly as `orwell_sync_ledger.py` coerces to scalars/ids/
names), so the guarantee is **structural, not careful-caller**. It is the **interpretation layer over the raw
rings**: `LIVE`/`IO`/`LLMIO` say *what happened*; this log says *what it meant and whether it was a problem*.
It is a **curated, semantic sibling** to the raw `LLMIO` full-I/O trace — **not** a replacement (the raw model
call, if the diagnosis used one, still lands in `LLMIO`); precedent: `orwell_sync_ledger.py` is the same
curated/turn-grain sibling to PR #406's full-payload archive. **Optional durability:** pair the bounded ring
with an `overseer-log.jsonl` (retention-governed, seeded into the ring at boot) **iff** "log every action"
must survive restarts — mirroring `llm-io.jsonl` ↔ the `LLMIO` ring.

### 4.5 Determinism & fail-soft (the port + stub)
The overseer is **behind a port** with a deterministic test adapter, exactly like `NarrativePort` /
`DeterministicNarrator` (0027): seeded **UAT/BDD** lanes wire `DeterministicOverseer`, which returns the
current heuristic's verdict and **never calls a model** — so the seeded full-game lanes stay **byte-identical**
and green. With the overseer **unavailable or erroring**, the existing FE heuristics + the 0031 checkpoint +
the 0065 sync spine behave **exactly as today** ("no model/provider ⇒ the engine's deterministic floor simply
stands"). The gate itself is cheap and deterministic; only the *diagnosis* is the (optional) model call.

### 4.6 What it never does (the wall, restated)
Never an **outcome** (`runCompetition` is the single authority, mandate #3). Never **authored narration**
(ADR 0003 — error-correct the *omission*, never write the content). Never a **Vault read** — even God Mode is
walled (mandate #2). Never **overrides** the integrity rollback (mandate #4). Its **control** stays on the
**open set** (ADR 0005); its **observation/logging** may be broad, because Vault-free operator-facing
diagnostics are the **sanctioned G1b / God-Mode lane** (0016) — broadening the *eyes* is mandate-safe in a way
that broadening the *hands* would not be.

## 5. Contracts (stack-agnostic)

```
OverseerPort (port):
    assess(signals): Verdict                    // signals + verdict are Vault-free BY CONSTRUCTION
    Signals: { trip, beatSeq, stateDelta, health, syncLedger, transcriptWindow, ioTail }
    Verdict: { level, diagnosis, action, beatSeqAfter? }
    action ∈ { hold, nudge, force-advance, propose-record, reinject-delta, escalate }

DeterministicOverseer (stub adapter):           // seeded lanes; returns the heuristic verdict, no model call

Gate (cheap, deterministic):
    shouldAssess(turnSignals): boolean          // the symptom net — wide across types, sparse in time

Diagnostic log (G1b, FE):
    record_overseer(level, diagnosis, action, beatSeqBefore, beatSeqAfter, ok, reads)   // 4th ring; Vault-free
    GET /api/admin/logs?source=overseer         // admin-gated, seq-cursored like LIVE/IO/LLMIO
    GET /api/admin/logs/sources                 // adds the "overseer" source
```

## 6. Definition of Done

- [ ] **Sparse trigger:** a healthy turn (scene recorded, `beatSeq` advanced, no error) does **not** wake the
      overseer — no model call, no log line; a symptom turn does. (Breadth ≠ frequency.)
- [ ] **Wide-eyes diagnosis distinguishes root causes:** the **same** "stuck at advance-phase" symptom yields
      *nudge/advance* (model under-call) vs *hold* (player mid-scene) vs *re-inject-delta* (drifted read), on
      seeded fixtures (roles only).
- [ ] **Small-but-right hands:** every lever is exercised; **none** authors content, decides an outcome, or
      reads the Vault; an out-of-toolbox case **escalates** instead of acting.
- [ ] **Mandate-safe by construction:** the overseer adapter holds **no `VaultStore`** handle; `npm run
      test:arch` stays green; the diagnostic log is **sentinel-clean** on the player **and** admin canaries (0001).
- [ ] **The diagnostic log is live in the admin panel:** a new "Overseer (live)" source tails through
      `/api/admin/logs` (seq-cursored), admin-gated, and records every wake's reads/diagnosis/action/outcome.
- [ ] **Fail-soft:** with the overseer unavailable, the existing heuristics + the 0031 checkpoint + the 0065
      sync spine behave exactly as today — seeded lanes byte-identical via `DeterministicOverseer`.
- [ ] **Determinism:** seeded UAT/BDD lanes never call a model; same seed ⇒ identical state.
- [ ] Name-agnostic tests (roles only); `npm test` + the FE pytest gate green.

## 7. Dependencies & traceability

Rides on **0031** (the integrity checkpoint stays the deterministic floor the overseer never overrides),
**0065** (`beatSeq`/`stateDelta`/divergence-ledger — the diagnosis inputs **and** the `reinject-delta` lever),
**0055** (`_auto_record_scene` — the gap-repair lever, promoted from a fixed call to a diagnosed one), **0019**
+ the FE agent loop (the stall-nudge / L39b heuristics — now the **gate** and the **fail-soft fallback**),
**G1b** `log_rings.py` + `admin_health_routes.py` (the fourth ring + the admin viewer), **0069 / PR #406**
(`LLMIO` — the raw sibling to this curated log), and **0027** (`NarrativePort` / `DeterministicNarrator` — the
port+stub pattern this mirrors), under **0001** (Vault sentinel — the log is sentinel-clean) and **0016** (God
Mode — the admin-only observability lane). **Governed by ADR 0003** (the conversation is the game; the engine
error-corrects the model's *omissions* and never authors content) and **ADR 0005** (split authority by
openness; the overseer's hands touch only the open set, while the closed set stays engine-dictated). Answers
the product question *"what if an AI agent oversaw the engine↔LLM IO loop?"* — this is it, scoped so the
agent's **eyes are wide, its hands are small and right, and it never reaches across the wall.**
