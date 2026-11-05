# 0128 — Three-part Final HOH (the real _Big Brother_ finale competition)

> **Current default (AMEND 2026-11-04):** `ORWELL_FINAL_HOH_THREE_PART` is now **default ON** in the engine (`FINAL_HOH_THREE_PART_ENABLED_DEFAULT = flagDefaultOn(...)`) and in `deploy/orwell-env-defaults.sh`; `=0` turns it off. The "default-off" / "opt-in" wording below records how it was built and calibrated (byte-identical OFF), not today's default.

> **Status:** ✅ **Built 2026-11-04** behind `ORWELL_FINAL_HOH_THREE_PART` (default OFF; issue #2045) — authored during the 0045 PO review (2026-07-13). See the README row for the built shape and the calibration result. **Expands 0045** (endgame
> structure). Today Final 3 crowns the final HOH with a **single** competition; the real show runs a **3-part**
> tournament. This spec replaces that single comp with the canonical three parts, behind a default-off,
> calibration-safe flag.
> **Executable spec:** [`0128-three-part-final-hoh.feature`](./0128-three-part-final-hoh.feature)

## 1. Summary

In _Big Brother_ the Final HOH is decided by a **three-part competition**, not one:

1. **Part 1 — endurance** (a *physical* comp): **all three** finalists compete. The winner **skips straight to
   Part 3**.
2. **Part 2 — a physical-and-mental comp** (a *hybrid*): the **two who lost Part 1** compete. The winner
   **advances to Part 3**.
3. **Part 3 — a quiz** (a *mental* comp): the **Part 1 winner vs. the Part 2 winner**. The winner is the
   **Final HOH**.

So the Final HOH always **wins two parts** (their qualifying part + Part 3). The finalist who **loses both**
Part 1 and Part 2 never reaches Part 3 — they are **out of the HOH race** ("win two to win; lose two and
you're out"). The Final HOH then **personally evicts** one of the other two — **unchanged from 0045** (the
two-loss finalist is *not* auto-evicted; the HOH chooses, exactly as the show works).

## 2. What exists today (the gap this closes)

- **0045** models Final 3 as: skip nominations/veto → **one** final-HOH competition (`resolveHohBeat` over the
  3-person field) → the winner is Final HOH → `final-eviction`. Correct and legal, but it collapses the show's
  signature 3-part finale into a single roll, so the finale loses its most recognizable BB structure (the
  endurance-then-quiz arc, the "who did you beat to get here" story).

## 3. Scope

**In:** a **three-part Final HOH** at `active.length === 3`, gated by a new default-off flag
`ORWELL_FINAL_HOH_THREE_PART` (threaded as `SeasonCtx.finalHohThreePart`). Each part is an engine-resolved
competition (0006/0028 — the engine still decides), staged for presentation like every other comp:

- **Part 1** — `endurance` (governing stat *physical*), field = all three finalists; winner → Part 3.
- **Part 2** — a **hybrid** (governing *physical*, secondary *mental* — the same weighted blend 0127 uses,
  passed directly so it does **not** require the 0127 flag), field = the two Part-1 non-winners; winner → Part 3.
- **Part 3** — `quiz` (governing *mental*), field = {Part 1 winner, Part 2 winner}; winner = **Final HOH**.

**Player agency:** the player competes in each part they are eligible for (a `comp-intent`/`comp-round`
approach per part); **winning Part 1 rests them through Part 2** (they are already in Part 3). New persisted
state (which part is live + the Part 1 / Part 2 winners) so a **mid-tournament restart resumes** (0030).

**Out:** the **final eviction choice** (0045 — the Final HOH still personally evicts one of two, unchanged);
the finale/jury vote (0037); the full-house weekly loop; making the three parts the model in the *seeded
calibration harness* (that is a full calibration re-baseline — a separate, larger task, as with 0126).

## 4. Design

- **Flag-gated, calibration-safe.** Three stat-typed comps instead of one **changes which finalist becomes
  Final HOH for a given seed**, so the flag is **default-OFF**: off ⇒ the single-comp 0045 path runs unchanged
  and every seeded gate (`juryReach` / gradient / UAT / the endgame BDD) is **byte-identical**; the deploy
  turns it on. `juryReach` must be re-confirmed **on** (band holds) before shipping — the same bar as 0126/0127.
- **Engine-decided (anti-sycophancy).** Every part is resolved by `resolveCompetition` (stats + temperature +
  emotion + the committed player approach) — the narrator never decides who advances or wins. The player's
  per-part approach is committed **before** the part resolves (the standard committed-before rule).
- **Presentation reuses the staged machinery.** Each part plays out as a staged elimination (the existing
  `beginStaged`/`advanceCompetition`), so the finale still has drop-drama — but Part 1 and Part 2 crowns
  **advance the tournament** instead of transitioning to `final-eviction`; only Part 3's crown sets the Final
  HOH and moves to `final-eviction`.
- **Vault Wall.** Every signal stays hidden; the player sees who advanced/won each part and infers, never a
  number (extend the 0001 canary). NPC advancement is engine-decided from hidden aptitudes + soul.
- **Faithful bracket.** The Final HOH wins exactly two parts; the two-loss finalist is out of the HOH race but
  **not** evicted by rule — the Final HOH's `final-eviction` choice (0045) is untouched.

## 5. Contracts (stack-agnostic)

```text
SeasonCtx += { finalHohThreePart?: boolean }                       // from ORWELL_FINAL_HOH_THREE_PART (default off)
Final 3 (flag ON): part1 endurance(physical, all 3) → winner to part3
                   part2 hybrid(physical+mental, the 2 part-1 losers) → winner to part3
                   part3 quiz(mental, p1Winner vs p2Winner) → Final HOH
persisted: { finalHohPart: 1|2|3, p1Winner?, p2Winner? }           // mid-tournament restart resumes (0030)
then: final-eviction (0045, UNCHANGED) — Final HOH personally evicts one of the other two
invariants: engine-decided + seeded; Vault-free; flag OFF ⇒ byte-identical single-comp 0045 path
```

## 6. Definition of Done (when built)

- [ ] **Three parts, correct fields:** Part 1 = all three (endurance/physical); Part 2 = the two Part-1 losers
      (physical+mental hybrid); Part 3 = the two part-winners (quiz/mental).
- [ ] **Win-two-to-win:** the Final HOH is whoever wins Part 3, and they won a prior part to get there; the
      finalist who loses Part 1 and Part 2 never plays Part 3.
- [ ] **Player agency:** the player competes in each eligible part (committed approach), rests through Part 2 if
      they win Part 1, and — as Final HOH — still gets the binding `final-eviction` (0045, unchanged).
- [ ] **Engine-decided + Vault-free:** every advancement/win comes from `resolveCompetition`; no number crosses
      the wall; a mid-tournament restart resumes (0030).
- [ ] **Calibration-safe:** flag **off** ⇒ byte-identical to 0045 (`juryReach` re-run green); flag **on** ⇒ the
      band still holds. Seed-deterministic; name-agnostic; added to `cucumber.cjs`; deploy opt-in; golden driver
      pinned off.

## 7. Dependencies & traceability

Expands **0045** (endgame structure — the single final-HOH comp it replaces), resolves through **0006/0028**
(competition math — unchanged), reuses the **0127** hybrid blend for Part 2 (passed directly, no 0127 flag
dependency), feeds **0045**'s `final-eviction` (unchanged) → **0037** (finale), persisted by **0030**, under
**0001** (Vault Wall). Default-off flag pattern is the same calibration-safe shape as 0126/0127.

## 8. Implementer-ready (Definition of Ready) — when scheduled

**Touch points (exact):**
- `src/engine/liveSeason.ts` — the Final-3 HOH path (`resolveHohBeat` / `hohField` at `active.length === 3`,
  and the `crownCompetition` `hoh-competition` branch ~L915 that currently sets `s.hoh` + `final-eviction`):
  when `ctx.finalHohThreePart`, run the 3-part sequence, advancing parts 1→2→3 and only crowning the Final HOH
  on Part 3. New `LiveSeasonState` fields `finalHohPart` / `p1Winner` / `p2Winner` (persisted, 0030).
- `src/adapters/engine/GameSessionAdapter.ts` — `FINAL_HOH_THREE_PART_ENABLED_DEFAULT` (default off), the field
  + setter, wired into `ctx().finalHohThreePart`.
- `frontend/scripts/_golden_driver.py` — pin `ORWELL_FINAL_HOH_THREE_PART="0"`.
- Deploy: `ORWELL_FINAL_HOH_THREE_PART=1` opt-in in `deploy/smoke.sh` + `deploy/orwell-install.sh`.
- **Tests:** `tests/unit/finalHohThreePart.test.ts` (pure + live byte-identity guard) + `docs/features/0128-*.feature`
  → `cucumber.cjs`. Assert §6 (three parts / win-two / player agency / engine-decided / calibration-safe).

**Open decision (deferred to build time):** the exact governing stat for Part 2 (pure `mental`, or the
`physical`+`mental` hybrid blend as specced here). Spec picks the hybrid to honor "a physical and mental comp";
revisit if calibration prefers a single stat.
