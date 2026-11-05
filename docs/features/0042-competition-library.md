# 0042 — Competition library (structured variety + narrative formats)

> **Status:** ✅ **Built & green** (BDD-gated in `cucumber.cjs`): `src/engine/competitionLibrary.ts` (`COMPETITION_LIBRARY` + the seeded `drawCompetition`) replaced the hardcoded `HOH_TYPES`/`VETO_TYPES` rotation in `liveSeason.ts`; later widened by 0125/0126/0127. *The rest of this note is the original problem statement and design, written before the build.*
> *(Original status, pre-build:)* PARTIAL. The **resolution math is done** (`domain/competitionOutcome.ts`:
> `CompetitionType` → governing stat via `RELEVANT`, `OUTCOME_WEIGHTS`, `resolveCompetition` =
> stat·weight + temperature + emotion + intent). What's **missing** is a competition *library*: comp **type
> rotation is hardcoded by week index** (`liveSeason.ts` `HOH_TYPES`/`VETO_TYPES`), there are **no named
> comp formats / eligible mechanics**, and **narration gets only `{ type, winner }`** — so competitions
> resolve correctly but feel same-y and are dressed by the narrator from nothing. This feature adds a
> **seeded, curated library** of competition definitions (name, stat weighting, mechanic, Vault-free
> narrative scaffold) drawn deterministically each week — keeping variety **structured and testable**, with
> the **engine still deciding the winner** (anti-sycophancy).
> **Executable spec:** [`0042-competition-library.feature`](./0042-competition-library.feature)

## 1. Summary

Competitions are mechanically sound but narratively thin: the same handful of types cycle by week index and
the model is handed only a type + a name to announce. 0042 makes each competition a **defined thing** — a
governing aptitude, a format/mechanic, and a Vault-free narrative scaffold — drawn from a seeded library so a
season has real variety, the right stat governs each comp, and the narrator dresses a *specific* competition
without ever touching stats or scores.

## 2. What exists today (the gap this closes)

- **Math: done.** `competitionOutcome.ts` maps each `CompetitionType` to its governing stat and resolves
  the winner from stats + bounded temperature + the soul emotional modifier + intent (0006/0028). Calibrated
  (favorite ~72%, real upsets, player unprotected).
- **Missing: the library.** `HOH_TYPES`/`VETO_TYPES` are **hardcoded week-index rotations**; there is **no**
  per-comp definition (name, mechanic, secondary stat, narrative format). `runCompetition` returns
  `{ type, winner }` only — the narrator has no comp-specific scaffold to dress, so variety is improvised.

## 3. Scope

**In:** a **seeded `COMPETITION_LIBRARY`** — a curated set of `CompetitionDef`s (id, name, governing +
optional secondary stat weighting, format/mechanic enum, **Vault-free narrative scaffold**: premise + beats +
how a win reads), grouped by eligible **phase** (HOH / veto / special); a **deterministic draw**
(`drawCompetition(phase, week, rng, recent)`) that picks the week's comp avoiding immediate repeats; routing
**resolution** through the existing `resolveCompetition` using the **def's** stat weighting; and a Vault-free
**competition result that carries the comp's name + format + narrative scaffold** (not just the type) for the
narrator (0018) to dress. Tunable, like `richnessConfig` / the temperature constants.

**Out:** the **resolution math** (reused — 0006/0028); **eligibility** (0005 — the six-player veto draw, HOH
exclusion, etc. are unchanged and must hold under any drawn comp); a physics simulation of each comp (the
library carries a **narrative** scaffold, not a mechanic engine); narration quality itself.

## 4. Design

- **`CompetitionDef`.** `{ id, name, phase: "hoh"|"veto"|"special", governing: Stat, secondary?: Stat,
  format: "endurance"|"puzzle"|"quiz"|"skill"|"crapshoot"|…, narrative: { premise, beats[], winReads } }`. The
  governing/secondary stats map into the existing `RELEVANT`/`OUTCOME_WEIGHTS` so resolution is unchanged in
  spirit — the library just makes *which aptitude matters* explicit and varied.
- **Seeded draw.** `drawCompetition(phase, week, rng, recent[])` deterministically selects a def for the
  phase, avoiding the last *k* used (no immediate repeats), so a season shows variety reproducibly.
- **Resolution unchanged.** The drawn def feeds `resolveCompetition` (stats + temperature + emotion + intent);
  the **engine still decides the winner** — the library never picks it (anti-sycophancy held).
- **Narrative carry.** The Vault-free `CompetitionResultView` gains `{ name, format, narrative }` — premise +
  beats + the winner's name — **no stats, scores, or rankings** ever (0001). The narrator (0018) dresses this
  specific comp instead of improvising one.
- **Eligibility intact.** 0005's structural rules (who plays, the six-player veto chip draw incl. Houseguest's
  Choice, HOH exclusion, replacement legality) are orthogonal and **hold under any drawn comp**.

## 5. Contracts (stack-agnostic)

```
CompetitionDef: { id, name, phase, governing: Stat, secondary?: Stat, format, narrative:{ premise, beats[], winReads } }
COMPETITION_LIBRARY: CompetitionDef[]                              // curated, tunable
drawCompetition(phase, week, rng, recent[]): CompetitionDef        // deterministic; avoids immediate repeats
resolveCompetition(field, def.governing/secondary, temp, …): winner   // ENGINE decides (0006/0028) — unchanged
CompetitionResultView += { name, format, narrative }              // Vault-free scaffold; NO stats/scores (0001)
```

## 6. Definition of Done

- [ ] **Variety, structured:** a season draws a **variety of distinct** competitions per phase (not one
      repeated), reproducibly by seed, avoiding immediate repeats.
- [ ] **Right stat governs:** each drawn comp resolves on its **defined** governing stat (a puzzle comp
      favors mental, an endurance comp favors physical, etc.) — asserted via the favored aptitude winning a
      calibrated majority.
- [ ] **Engine still decides (anti-sycophancy):** the winner comes from stats + bounded temperature (favorite
      wins a strong majority but loses real upsets; the player is unprotected) — the library never selects the
      winner.
- [ ] **Narrative carry, Vault-free:** the result exposes the comp's **name + format + narrative scaffold**
      and **no stats/scores/rankings** (extend the 0001 canary to the enriched result).
- [ ] **Eligibility holds:** 0005's invariants (six-player veto draw, HOH exclusion, replacement legality)
      hold under **any** drawn comp.
- [ ] Seed-deterministic; name-agnostic; added to `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

Sits on top of **0006/0028** (the resolution math + temperature — unchanged), feeds **0018** (the narrator
dresses a specific comp), under **0005** (eligibility, orthogonal) and **0001** (the result stays
stats/score-free). Replaces the hardcoded `HOH_TYPES`/`VETO_TYPES` week-index rotation with a seeded, tunable,
testable library — variety the player feels, with the engine still the one who decides who wins.

## 8. Implementer-ready (Definition of Ready)

**Touch points (exact):**
- **New** `src/engine/competitionLibrary.ts` — `CompetitionDef` (id, name, phase: "hoh"|"veto",
  `governing`/`secondary` stat, `format`, `narrative {premise, beats[], winReads}`), the curated tunable
  `COMPETITION_LIBRARY`, and `drawCompetition(phase, week, rng, recent[]): CompetitionDef` (deterministic;
  avoids immediate repeats).
- `src/engine/liveSeason.ts` — replace the hardcoded `HOH_TYPES`/`VETO_TYPES` (L124–125) + their use at the
  HOH draw (L354) and the veto draw with `drawCompetition(...)`.
- `src/domain/competitionOutcome.ts` — `resolveCompetition` (L61) keys off the def's governing stat; the
  type→stat map already exists (`RELEVANT`, L23/L69). **Resolution math unchanged** (0006/0028 reused).
- `src/ports/GameSession.ts` `CompetitionResultView` + `GameSessionAdapter.runCompetition` — carry the comp's
  **name + format + narrative** (Vault-free); **no stats/scores** ever.

**Build order / deps:** none — the resolution math (0006/0028) and eligibility (0005) are reused unchanged.

**Test targets:** `tests/unit/competitionLibrary.test.ts` + `docs/features/0042-*.feature` → add to
`cucumber.cjs`. Assert §6: a season draws **variety** (no immediate repeat), the **governing stat** decides
the favorite, the **engine still picks the winner** (favorite ~strong-majority + real upsets, player
unprotected — reuse the 0006 calibration style), the Vault-free result carries **name+format+narrative and
NO stats/scores** (extend the 0001 canary to the enriched result), **0005 eligibility holds** under any drawn
comp (six-player veto draw etc.), seed-deterministic.

**Player-protection proof (S15):** the tight proof that the player is never favored is `tests/unit/competitionLibrary.test.ts` ("the player is never protected: with identical stats they win no more than their share"); the 0006 calibration style above is the broader check.

**No open decisions.** The library is curated content + a deterministic draw; the winner is still the
engine's (anti-sycophancy). Narrative scaffolds are Vault-free flavor the narrator (0018) dresses.
