# 0126 — Expanded competition mechanics (a repeat-free season of distinct comps)

> **Current default (AMEND 2026-11-04):** `ORWELL_COMP_MECHANICS_PLUS` is now **default ON** in the engine (`COMP_MECHANICS_PLUS_ENABLED_DEFAULT = flagDefaultOn(...)`) and in `deploy/orwell-env-defaults.sh`; `=0` turns it off. The "default-off" / "opt-in" wording below records how it was built and calibrated (byte-identical OFF), not today's default.

> **Status:** Built. **Expands 0042 (and completes 0125).** 0125's theme layer reskins the *same* ~12
> mechanics, so a season still repeats each **mechanic** ~2× (a BB fan clocks "that's the wall comp
> again, reskinned"). 0126 grows the mechanic pool from **12 → 30** (15 HOH + 15 veto) and widens the
> draw into a **rolling shuffle** so a full season (~14 HOH + ~13 veto comps) runs with **no repeated
> mechanic at all** — genuinely distinct *gameplay*, not just distinct skins. Layered with 0125, every
> comp is a distinct mechanic in a distinct theme.
> **Executable spec:** [`0126-expanded-competition-mechanics.feature`](./0126-expanded-competition-mechanics.feature)
> **Also proven by:** `tests/unit/competitionMechanicsPlus.test.ts`

## 1. Summary

Nine new HOH and nine new veto mechanic definitions join the 0042 library (`COMPETITION_LIBRARY_PLUS`),
each with a governing stat, format, and Vault-free narrative scaffold — exactly the 0042 shape, resolved
through the **unchanged** `resolveCompetition` (0006/0028), so the **engine still decides the winner**. The
new mechanics **preserve the base pool's governing-stat mix per phase** (~physical 33% / mental 53% /
social 13%) so competition balance — and thus the seeded calibration distribution — stays stable. Unlike
the 0125 theme layer (a pure projection, default-on), growing the pool **changes which mechanic a fixed
seed draws** — and the def's `type` selects the resolution stat — so it **changes seeded winners**. It is
therefore **a flag** (`ORWELL_COMP_MECHANICS_PLUS`, now default ON - see the header): with the flag OFF the draw is the bare
base 12 and every seeded gate is byte-identical; the deploy turns it on for real play.

## 2. What exists today (the gap this closes)

- **0042: the base 12** (6 HOH + 6 veto), drawn with a no-immediate-repeat window of 1.
- **0125: themes** reskin those 12 so they *look* distinct — but the underlying mechanic still repeats
  ~2× a season (14 HOH comps ÷ 6 mechanics ≈ 2.3× each).
- **The gap:** real *gameplay* variety. A repeated mechanic is the same competition even under a new skin.

## 3. Scope

**In:** `COMPETITION_LIBRARY_PLUS` — 9 HOH + 9 veto new `CompetitionDef`s (stat-mix-matched, distinct
formats/flavor); a pool-aware draw (`drawCompetition(..., expanded)`) that, when expanded, widens the
no-repeat window to the whole pool minus one — a **rolling shuffle** so no mechanic repeats until all are
used; `competitionById` searching both pools (deferred-veto resume); `SeasonCtx.expandedComps` threaded
from the adapter flag. Now default-**ON** (`ORWELL_COMP_MECHANICS_PLUS`, #1996; `=0` opts out), as in the deploy defaults; pinned off in the
golden driver.

**Out:** the **resolution math** (reused unchanged — 0006/0028); the **theme layer** (0125 — composes
automatically, reskinning whatever mechanic is drawn); making 30 the pool in the *seeded test harness*
(that is a full calibration re-baseline + golden re-record — a separate, larger task).

## 4. Design

- **Distinct concepts (PO polish, 2026-07-13):** the first 0126 cut reused a few archetypes (4 endurance-hangs,
  4 season-quizzes), so several comps read as near-twins. The expanded pool was re-authored so all 30 comps are
  genuinely distinct challenges (endurance → 2 total; the quizzes split into trivia / true-false / ordering /
  anagram; mazes/math/image-memory collapse to one concept each). Six expanded comps were rewritten
  (`The Gauntlet` agility, `Dead Eye` precision, `Spellbound` anagram, `Process of Elimination` deduction,
  `Crack the Safe` code-break, `Total Recall` sequence-memory). Each kept its **exact governing + secondary
  stat**, so the change is **byte-identical** (juryReach re-confirmed) and the base 12 (hence the golden fixture)
  are untouched.
- **`COMPETITION_LIBRARY_PLUS`** — 18 new defs, same `CompetitionDef` shape as 0042. Governing-stat counts
  per phase after expansion: **physical 5, mental 8, social 2** (base was 2/3/1) — the same mental-dominant
  mix, so the stat pressure on the cast is unchanged.
- **Rolling-shuffle draw.** `drawCompetition(phase, week, rng, recent, expanded)`: when `expanded`, the
  avoided set is the last `poolLength − 1` draws, so a season is a seeded shuffle of the pool (repeat-free
  until it cycles). When off, the window is the base `NO_REPEAT_WINDOW = 1` — **byte-identical**.
- **Resolution unchanged.** The drawn def feeds `resolveCompetition` (stats + temperature + emotion +
  intent); the engine still decides the winner (anti-sycophancy held).
- **Flag-gated, calibration-safe.** `ctx.expandedComps` is present only when the adapter flag is on; off ⇒
  the base 12 draw ⇒ every seeded gate (juryReach / gradient / UAT / golden / the fixed-seed 0043 BDD) is
  byte-identical. Proven: `juryReach` re-run green with the flag **off** (the gate) **and on** (balance holds).
- **Composes with 0125.** The theme layer reskins whatever def is drawn — 30 mechanics × 24 themes.

## 5. Contracts (stack-agnostic)

```text
COMPETITION_LIBRARY_PLUS: CompetitionDef[]                          // 18 new (9 HOH + 9 veto), stat-mix-matched
drawCompetition(phase, week, rng, recent, expanded=false)          // expanded ⇒ rolling shuffle; off ⇒ base 12 (byte-identical)
competitionById(id)                                                // searches BOTH pools
SeasonCtx += { expandedComps?: boolean }                           // threaded from ORWELL_COMP_MECHANICS_PLUS
resolveCompetition(...) → winner                                   // UNCHANGED (0006/0042) — engine decides
```

## 6. Definition of Done

- [x] **30-mechanic pool:** 15 HOH + 15 veto; every id unique; each def's governing stat matches the
      resolution map for its type.
- [x] **Repeat-free season (expanded):** a full season draws ~all-distinct mechanics per phase.
- [x] **Balance preserved:** the expanded pool keeps the base governing-stat mix (mental-dominant,
      physical second, social a minority) — `juryReach` band holds with the flag **on**.
- [x] **Engine still decides:** winners come from `resolveCompetition` (unchanged); the pool never picks.
- [x] **Byte-identical off:** with the flag off the draw is the base 12 and the seeded eviction trajectory
      is identical — `juryReach` re-run green (flag off).
- [x] **Vault-free:** the expanded comp result carries no stat/score/ranking.
- [x] Seed-deterministic; name-agnostic; added to `cucumber.cjs`; deploy opt-in; golden driver pinned off.

## 7. Dependencies & traceability

Expands **0042** (the mechanic library), completes **0125** (themes reskin these mechanics), sits on
**0006/0028** (resolution — unchanged), under **0001** (Vault-free result) and ADR **0003**. The default-off
flag is the same calibration-safe pattern as 0122/0123/0124 (byte-identical off, deploy opt-in). Going
default-**on everywhere** (including the seeded gates) is a deliberate follow-on requiring a full
calibration re-baseline + a golden fixture re-record (a live OpenRouter key).

## 8. Implementer-ready (Definition of Ready) — as built

- `src/engine/competitionLibrary.ts` — `COMPETITION_LIBRARY_PLUS` (18), `drawCompetition(..., expanded)`
  (rolling shuffle), `competitionById` (both pools).
- `src/engine/liveSeason.ts` — `SeasonCtx.expandedComps?`, `drawFor(..., ctx)` threading it to all 5 draw
  sites.
- `src/adapters/engine/GameSessionAdapter.ts` — `COMP_MECHANICS_PLUS_ENABLED_DEFAULT` (default-off), the
  `compMechanicsPlusEnabled` field + `setCompMechanicsPlusEnabled`/`compMechanicsPlusEnabledNow`, wired into
  `ctx().expandedComps`.
- `frontend/scripts/_golden_driver.py` — pin `ORWELL_COMP_MECHANICS_PLUS="0"`.
- Deploy: `ORWELL_COMP_MECHANICS_PLUS=1` opt-in in `deploy/smoke.sh` + `deploy/orwell-install.sh`.
- **Tests:** `tests/unit/competitionMechanicsPlus.test.ts` (pure) + `tests/unit/competitionMechanicsPlusLive.test.ts`
  (live + byte-identity guard), `docs/features/0126-*.feature` → `cucumber.cjs`.
