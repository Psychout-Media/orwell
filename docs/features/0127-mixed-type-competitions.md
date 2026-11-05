# 0127 — Mixed-type competitions (hybrid comps that reward the well-rounded)

> **Current default (AMEND 2026-11-04):** `ORWELL_COMP_MIXED` is now **default ON** in the engine (`COMP_MIXED_ENABLED_DEFAULT = flagDefaultOn(...)`) and in `deploy/orwell-env-defaults.sh`; `=0` turns it off. The "default-off" / "opt-in" wording below records how it was built and calibrated (byte-identical OFF), not today's default.

> **Status:** Built. **Expands 0042 (and completes 0125/0126).** Every competition resolved on a SINGLE
> stat — a puzzle was pure Mental, an endurance pure Physical. But real _BB_ comps are usually hybrids:
> "crawl through mud, then solve a puzzle," a social read that also rewards a sharp memory. 0127 turns the
> (previously narration-only) `secondary` aptitude into a **real weighted blend** in resolution, so a
> hybrid comp rewards a **well-rounded** houseguest over a one-dimensional one — while the primary stat
> still dominates and the engine still decides on stats.
> **Executable spec:** [`0127-mixed-type-competitions.feature`](./0127-mixed-type-competitions.feature)
> **Also proven by:** `tests/unit/mixedCompetition.test.ts`

## 1. Summary

For a comp def carrying a `secondary` aptitude, the score's stat base becomes
`primary·(1 − w) + secondary·w`, where `w = TEMPERATURE_CONSTANTS.outcome.mixedSecondaryWeight` (0.35).
The **primary still dominates** (0.65), so the winner is mostly the primary favorite — the blend *tilts*,
it never *inverts*. This is the single most calibration-sensitive change in the competition series (it
edits `competitionOutcome.ts`, which holds the "favorite wins ~X%, player never protected" invariants), so
it is **OPT-IN, default-off** (`ORWELL_COMP_MIXED`): with the flag off every comp resolves on its pure
single stat and every seeded gate is **byte-identical**; the deploy turns it on and the band is re-confirmed.

## 2. What exists today (the gap this closes)

- **0042/0126:** each comp def has a `governing` stat and an optional `secondary` — but `secondary` is
  **read nowhere** (narration-only flavor). Resolution keys off the single `RELEVANT[type]` stat.
- **The gap:** no comp is a genuine hybrid. A comp beast is equally safe on a puzzle-heavy veto as on a
  pure endurance one, which isn't how _BB_ comps work.

## 3. Scope

**In:** an optional `secondaryStat` parameter on `resolveCompetition` that blends the two aptitudes (weight
from the tunable 0028 module); `secondary` aptitudes authored onto ~13 naturally-hybrid comps (skill /
crapshoot / social / maze comps — pure endurance / pure-strength / pure-puzzle stay single-stat);
`SeasonCtx.mixedComps` threaded from the adapter flag; the live `resolveComp` passing the secondary only
when the flag is on. Default-**OFF** (`ORWELL_COMP_MIXED`); deploy opt-in (it was also pinned off in the since-decommissioned golden driver).

**Out:** the temperature / emotion / intent / rest terms (unchanged — the blend touches only the stat
base); a per-comp custom weight (one tunable global weight for now); the theme/pool layers (0125/0126 —
compose automatically).

## 4. Design

- **The blend.** In `resolveCompetition`, `effectiveStat = secondaryStat && secondaryStat !== primary ?
  primary·(1 − w) + secondary·w : primary`; `base = effectiveStat · w.stat`. A secondary equal to the
  primary is a no-op; an absent secondary is byte-identical.
- **Which comps are hybrids.** The `secondary` field IS the hybrid marker. ~13 comps carry one (a
  physical skill comp + a mental element, a social read + memory, a puzzle + a physical sort); pure
  endurance / raw-strength / pure-puzzle comps deliberately stay single-stat, for variety.
- **Primary dominance.** `w = 0.35` keeps the primary favorite winning the majority — verified by the
  "primary still dominates" property (a physical monster still beats a mental-only rival on a physical
  hybrid).
- **Flag-gated, calibration-safe.** `ctx.mixedComps` is present only when the adapter flag is on; off ⇒
  pure single-stat resolution ⇒ every seeded gate byte-identical. Proven: `juryReach` re-run green with the
  flag **off** (byte-identity) **and on** (the band still holds — the balance is preserved).
- **Composes with 0125/0126.** The blend is orthogonal to the theme skin and the pool size.

## 5. Contracts (stack-agnostic)

```text
OutcomeWeights += { mixedSecondaryWeight: 0.35 }                    // tunable (0028); 0 disables the blend
resolveCompetition(..., secondaryStat?)                            // blends primary·(1−w) + secondary·w; absent ⇒ byte-identical
CompetitionDef.secondary (0042)                                    // now the hybrid marker (was narration-only)
SeasonCtx += { mixedComps?: boolean }                              // threaded from ORWELL_COMP_MIXED
```

## 6. Definition of Done

- [x] **Hybrid rewards the all-rounder:** on a hybrid comp a well-rounded houseguest beats a
      one-dimensional one that is equal in the primary aptitude.
- [x] **Primary still dominates:** a primary monster still wins a strong majority of a hybrid comp
      (the blend tilts, never inverts).
- [x] **Byte-identical off:** with the flag off every comp is pure single-stat and the seeded eviction
      trajectory is identical — `juryReach` re-run green (flag off).
- [x] **Balance holds on:** `juryReach` band still holds with the flag on (empirical balance proof).
- [x] **Vault-free:** the result carries no stat/score/ranking under hybrid resolution.
- [x] Seed-deterministic; name-agnostic; added to `cucumber.cjs`; deploy opt-in.

## 7. Dependencies & traceability

Expands **0042** (uses its `secondary` field), completes **0125/0126**, edits **0006/0028** (the resolution
math + the tunable weight), under **0001** (Vault-free result). The default-off flag is the same
calibration-safe pattern as 0122/0123/0124/0126 (byte-identical off, deploy opt-in, `juryReach` re-confirmed
both ways). The blend weight (0.35) and the hybrid set are tunable.

## 8. Implementer-ready (Definition of Ready) — as built

- `src/domain/temperatureConstants.ts` — `OutcomeWeights.mixedSecondaryWeight` (0.35).
- `src/domain/competitionOutcome.ts` — the optional `secondaryStat` param + the `effectiveStat` blend.
- `src/engine/competitionLibrary.ts` — `secondary` aptitudes on ~13 hybrid comps.
- `src/engine/liveSeason.ts` — `SeasonCtx.mixedComps?`; `resolveComp` passes `def.secondary` when on.
- `src/adapters/engine/GameSessionAdapter.ts` — `COMP_MIXED_ENABLED_DEFAULT` (default-off), the
  `compMixedEnabled` field + `setCompMixedEnabled`/`compMixedEnabledNow`, wired into `ctx().mixedComps`.
- `frontend/scripts/_golden_driver.py` — pinned `ORWELL_COMP_MIXED="0"` (historical; the golden driver was decommissioned 2026-07-21).
- Deploy: `ORWELL_COMP_MIXED=1` opt-in in `deploy/smoke.sh` + `deploy/orwell-install.sh`.
- **Tests:** `tests/unit/mixedCompetition.test.ts` (pure) + `tests/unit/mixedCompetitionLive.test.ts`
  (live + byte-identity guard), `docs/features/0127-*.feature` → `cucumber.cjs`.
