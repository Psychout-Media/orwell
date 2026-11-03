# 0080 — Active overseer: the reasoning tier as the primary actor (guardrails as the fail-soft floor)

> **Status:** ✅ **Built, shipped DEFAULT ACTIVE** (owner ruling 2026-07-13; 3-state `overseer_mode` in `frontend/src/settings.py`, resolver default `active`; an explicit `off` still disables). The text below is the original scoping spec, which proposed opt-in / OFF by default. *(Original status:)* 📝 **SPEC — scoping; owner rulings open (§10).** A follow-on to **0079**. Today the
> runtime overseer **diagnoses + logs** while the inline heuristic guardrails (the stall-nudge, the
> L39b forced-advance ladder, `_auto_record_scene`, the casting/premiere belts) do the **acting**.
> This feature lets the overseer **act on its own verdict** — its reasoning *decides* the correction —
> with the existing guardrails **demoted to the deterministic fail-soft floor** rather than removed.
> It is **reversible** (as first scoped it was also opt-in and OFF by default; it now ships ACTIVE, see the status above). This is the original "promote the brittle
> heuristics into one reasoning overseer" idea (the first design conversation behind 0079), scoped
> honestly: it is **a live-game behavior change**, not a post-turn bolt-on, and it trades instant
> heuristic decisions for slower LLM-judged ones. **Read §9 (cost & risk) and §10 (open decisions)
> before building — several load-bearing calls are the owner's.**
> **Governed by** ADR 0003 (the conversation is the game; error-correct the model's *omissions*),
> ADR 0005 (act only on the open set; the engine owns the closed set), and the **anti-sycophancy
> mandate** (#3 — the deterministic core decides outcomes; the LLM never authors them).
> **Executable spec:** [`0080-active-overseer.feature`](./0080-active-overseer.feature) *(provisional —
> reflects the recommended Model D; the accepted scenarios are pinned once §10 is ruled).*

## 1. Summary

0079 shipped the overseer as a **post-turn diagnostic**: a sparse gate, a wide-eyed `LlmOverseer`
diagnosis over Vault-free telemetry, a fixed mandate-safe lever set, and a Vault-free admin log — but
it **records** the lever it would pull, it never **executes** it. The inline guardrails remain the
hands. This feature makes the overseer's verdict **drive the correction**, so the scattered tuned
heuristics are superseded by **one reasoning brain** while staying available as the floor.

The change is **not** "add post-turn actions." Acting correctly requires the overseer to **move into
the turn loop** at the points where the guardrails fire, and to **reuse their action code** — the
delta is *who decides* (an LLM-judged verdict) instead of *N standalone heuristics*. That delta is the
whole value **and** the whole risk.

## 2. What exists today (0079) — the starting point

| Piece | Where | Today |
|---|---|---|
| Sparse symptom-gate `should_assess` | `overseer.py` | ✅ pure, deterministic |
| Reasoning diagnosis `LlmOverseer` (+ `DeterministicOverseer` floor) | `overseer.py` | ✅ live, fail-soft |
| The hook | `agent_loop.py` (post-turn, ~L4902) | **diagnose + LOG only** — no lever executes |
| The inline guardrails (the actual hands) | `agent_loop.py` (per-round, ~L4140–4203 + the casting/premiere belts) | ✅ act inline, instant, seed-deterministic, tuned (grace / escalation / first-week) |
| Opt-in toggle | settings `overseer_enabled` / `ORWELL_OVERSEER` | ✅ binary off/on (on ⇒ shadow) |

So the verdict + the action code **both already exist** — they are just not connected. This feature
connects them, under explicit safeguards.

## 3. The central decision (explicit) — which integration model

| Model | What it means | Verdict |
|---|---|---|
| **A — Replace** | Remove the heuristic guardrails; the overseer is the only decider. | ❌ too risky — deletes tuned, battle-tested logic and the deterministic floor. |
| **B — Arbitrate** | Guardrails compute the action; the overseer only vetoes/approves firing. | ❌ awkward hybrid; keeps both brains, clarifies nothing. |
| **C — Backstop** | Guardrails act as today; the overseer acts ONLY on symptoms they missed this turn. | ➖ lowest risk, lowest value — the guardrails are comprehensive, so few gaps. |
| **D — Primary + floor** *(recommended)* | When enabled **and a model resolves**, the overseer's verdict is the **primary** actor inline; the deterministic guardrails are the **fail-soft floor** (they take over when the overseer is unavailable / errors / times out / is disabled). | ✅ real authority for the reasoning tier, reversible, the floor always stands. |

**Recommendation: Model D**, expressed as a **3-state mode** (extends the 0079 toggle):
`off` (default) → `shadow` (0079: diagnose + log) → `active` (this feature: the overseer acts).
**This is owner ruling D1/D3 (§10).**

## 4. The relocation (explicit) — post-turn → inline

To *act* (especially `nudge` = inject a system message and re-prompt mid-turn), the overseer must run
at the **per-round guardrail junction** inside the turn loop, not the post-turn tail. Concretely: at
the spot where the stall block decides to nudge / force-advance / record (`agent_loop.py` ~L4140–4203),
`active` mode replaces the heuristic decision with `verdict = overseer.assess(signals)` and dispatches
on `verdict.lever`.

**Two sub-options:**
- **(i) inline assess at the junction** *(recommended)* — one bounded overseer call when the gate
  trips, replacing the heuristic decision in place. Correct timing; **costs an inline LLM call on a
  symptomatic turn** (see §9 latency).
- **(ii) post-turn diagnosis applied next turn** — cheaper (no inline call), but the correction lands
  a turn late; pacing feels laggy. Rejected unless latency proves unacceptable.

**This is owner ruling D2 (§10).**

## 5. Lever execution (explicit) — reuse the existing action code

`active` mode does **not** write new action code; each lever **routes through the existing,
already-tuned action path**:

| Lever | Executes via (existing code) | Notes |
|---|---|---|
| `nudge` | the stall-nudge system-message injection + re-prompt | the same graduated text rungs; the overseer chooses *whether*, not the wording |
| `force-advance` | `_commit_advance_silently` **+ the L39b double-advance beat-reread guard** | bounded exactly as L39b is — one forced advance, never an auto-resolved pending player decision |
| `propose-record` | `_auto_record_scene` / `_backfill_with_cas` | engine still owns the magnitude (ADR 0005); the descriptor is shape-only |
| `reinject-delta` | re-inject the 0065 `stateDelta` into the next round's context | fixes the input, never the output |
| `escalate` | record a fault to God-Mode health + back off | out-of-toolbox ⇒ surface, never force |
| `hold` | nothing | logged as `observation` |

The change is **the decider**, not the action — so the blast radius is "which existing action fires,
and when," never "a new way to mutate the game."

## 6. Determinism & the seeded lanes (explicit) — the carve-out

The UAT/BDD lanes are **seed-deterministic** and play full games to completion. An LLM-judged actor
breaks that. The tuned guardrails also encode grace/escalation/first-week logic the simple heuristic
verdict does **not** reproduce, so making `DeterministicOverseer` drive actions in seeded mode would
**change the seeded outcomes** and force a full calibration re-baseline (incl. `juryReach` + the
gradient band).

**Recommendation (ruling D4):** **`active` is a LIVE-only behavior.** In seeded/deterministic mode
(no real model wired — every automated gate) the **existing guardrails stay the actor unchanged**, so
the seeded lanes are **byte-identical** and need **no** re-baseline. The overseer-as-actor path is
exercised only with a real model wired (the live-LLM manual-test path in `CLAUDE.md`) and by unit
tests that inject a fake verdict at the dispatch seam. The alternative — porting the grace/escalation
into `DeterministicOverseer` and re-baselining the calibration gates — is a much larger, riskier task
and is **explicitly out of scope** unless the owner wants it.

## 7. Anti-sycophancy & the mandate boundary (explicit)

`active` mode has an LLM making **control decisions** every symptomatic turn. The mandate (#3) is that
the deterministic core decides **outcomes**; the LLM never authors them. Active overseer stays inside
the mandate **iff every one of these holds** (each is a test gate, §8):

1. **Trigger-only, never author.** Every lever only *triggers* a deterministic engine action
   (`advanceGame` / `recordInteraction`); the overseer never chooses a winner, a vote, a magnitude, or
   any outcome. The engine validates and resolves; the overseer decides *whether/when to pull*, never *what*.
2. **The lever set is fixed.** No reply can widen the hand (0079's `verdict_from_reply` already rejects
   an out-of-contract lever to the floor; that guard is load-bearing here).
3. **The floor always stands.** Model unavailable / error / timeout / disabled ⇒ the deterministic
   guardrails resume with **zero** change. Reversible by flipping the mode.
4. **No Vault, ever.** Inputs stay the 0079 Vault-free `Signals`; the structural Vault Wall is untouched.

**The honest new risk (§9):** replacing tuned deterministic *grace* with LLM *judgment* means the
overseer can nudge/advance **more aggressively than the grace intended** — e.g. cutting off legitimate
social play the grace was protecting. Mitigations: the prompt encodes the grace philosophy ("seize the
lull, let substantive play run"); `force-advance` stays bounded by the L39b threshold; the floor
catches a wrong call. **How aggressive the overseer may be vs. the grace is owner ruling D5.**

## 8. Definition of Done

- [ ] **3-state mode** (`off`/`shadow`/`active`) replaces the binary toggle (settings + the status-page
      control); default `off`; `shadow` = exact 0079 behavior.
- [ ] **`active` dispatch seam:** at the inline guardrail junction, `active` mode routes the decision
      through `overseer.assess` and dispatches each lever to its **existing** action path (§5).
- [ ] **Fail-soft floor:** with no model / an error / a timeout / `active` off, the deterministic
      guardrails act **byte-identically** to today (proven on the seeded lanes — they must not move).
- [ ] **Trigger-only:** a unit test at the dispatch seam proves every lever only triggers a
      deterministic engine tool — no outcome/magnitude is ever authored by the overseer; the fixed
      lever set holds (out-of-contract ⇒ floor).
- [ ] **Live-only:** seeded UAT/BDD/calibration lanes are **unchanged** (`active` never engages without
      a real model); `npm`/FE gates green with **no** re-baseline.
- [ ] **Reversibility:** flipping `active`→`shadow`→`off` restores prior behavior live; the diagnostic
      log keeps recording throughout.
- [ ] **Observability:** an executed lever logs to the OVERSEER ring as an `action` with `ok` =
      did-it-apply, distinct from a shadow `observation`; the divergence ledger reflects overseer-driven
      corrections.
- [ ] Name-agnostic tests (roles only); full FE suite green; live-LLM manual run recorded (the gates
      can't see the active path — `CLAUDE.md` live-testing seam).

## 9. Cost & risk (explicit — read before approving)

- **Inline LLM latency.** `active` adds a model call **inside** a symptomatic turn, before the player
  sees the corrected beat. Sparse (only when the gate trips) and bounded (short timeout → fall back to
  the heuristic), but on those turns the player **waits for the overseer**. The guardrails are instant;
  this is the core tradeoff.
- **Live pacing behavior changes.** Tuned grace/escalation is replaced by LLM judgment on the symptomatic
  path. Better *or* worse depending on the model; needs live validation, not just green gates.
- **Anti-sycophancy surface.** An LLM making per-turn control decisions is new (bounded by §7, but real).
- **Testing gap.** The active path is **live-only**, so the automated suite can't fully cover it
  (unit-test the dispatch seam with injected verdicts; the rest is the live-LLM manual path).
- **Bounded blast radius.** Opt-in + reversible + deterministic floor + trigger-only + Vault-free ⇒ a
  bad overseer call is recoverable (the floor resumes) and can never leak or author an outcome.

## 10. Open decisions (owner rulings needed)

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Integration model: D (primary + floor) vs C (backstop-only)? | **D** — real authority, floor stands. |
| **D2** | Position: inline assess (latency) vs post-turn-applies-next-turn (lag)? | **inline** — correct timing; cap latency + fall back. |
| **D3** | Mode shape: 3-state (`off`/`shadow`/`active`) vs binary? | **3-state** — `shadow` stays a first-class diagnostic. |
| **D4** | Determinism: `active` live-only carve-out vs port grace into `DeterministicOverseer` + re-baseline calibration? | **live-only carve-out** — no re-baseline; smaller, safer. |
| **D5** | Aggressiveness: may the overseer override the tuned grace, or stay bounded by the existing thresholds? | **bounded** — prompt encodes the grace; force-advance keeps the L39b threshold; floor catches errors. |

## 11. Dependencies & traceability

Builds directly on **0079** (the gate, `LlmOverseer`/`DeterministicOverseer`, `verdict_from_reply`, the
diagnostic log, the opt-in toggle — all reused). Reuses the inline action paths in **0019**/the FE agent
loop (stall-nudge, L39b, `_auto_record_scene`), **0065** (`stateDelta`/`beatSeq` — inputs + the
`reinject-delta` lever), and **0031** (the integrity checkpoint stays the engine-side floor under
everything). Governed by **ADR 0003** / **ADR 0005** and the **anti-sycophancy mandate** (§7). The
seeded-lane carve-out (§6) keeps **0006/0028 calibration** + `juryReach` untouched. Answers: *"make the
reasoning overseer the actor, not just the observer"* — scoped as a live-only, opt-in, reversible,
trigger-only behavior change with the deterministic guardrails as the floor.
