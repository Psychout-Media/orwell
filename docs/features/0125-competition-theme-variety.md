# 0125 — Competition theme variety (a repeat-free season of skinned comps)

> **Status:** Built. **Expands 0042.** 0042 gave the season a curated library of ~12 mechanic
> definitions (name, governing stat, format, Vault-free scaffold) drawn deterministically — but ~12
> mechanics over an ~11-week season (one HOH + one veto each week) means each is seen roughly twice.
> 0125 lays a **large seeded THEME/skin pool** over those mechanics so the *displayed* competition is
> `mechanic × theme` — an endurance mechanic reskinned as "Zero-Gravity Endurance" one week and "Haunted
> Endurance" the next — giving **100s of visibly distinct competitions** and a **repeat-free season**,
> while the mechanic (and therefore who wins) is unchanged.
> **Executable spec:** [`0125-competition-theme-variety.feature`](./0125-competition-theme-variety.feature)
> **Also proven by:** `tests/unit/competitionThemes.test.ts`

## 1. Summary

The theme is **pure Vault-free NARRATION flavor** — a name transform (theme prefix + the mechanic's
format noun, e.g. "Haunted Trivia") and a scene-setter woven ahead of the mechanic's own premise. It
**never touches resolution**: the governing stat, the seeded roll, and the winner are exactly 0042/0006,
and the theme is chosen on a **dedicated deterministic hash — never the beat rng** — so the seeded game
spine (juryReach / gradient / UAT / golden) is **byte-identical whether themes are on or off**. The theme
is the deterministic FLOOR the narrator dresses; the #1400 model-authored competition fiction still
overrides it when generation is on. This is the same layering the mandate asks for — *structured variety
the engine authors, the narrator voices* (ADR 0003).

## 2. What exists today (the gap this closes)

- **0042: done.** A curated `COMPETITION_LIBRARY` of mechanic defs + a seeded `drawCompetition` that
  avoids immediate mechanic repeats; the engine still decides the winner; the Vault-free result carries
  name/format/narrative.
- **The gap: shallow variety.** ~6 mechanics per phase means a season repeats each mechanic ~twice, and
  the *displayed* comp is the bare mechanic name. There is no theme/skin layer, so a repeated mechanic
  reads as the same competition.

## 3. Scope

**In:** a large seeded **`COMPETITION_THEMES`** pool (24 Vault-free skins: label, adjectival prefix,
scene-setter); a deterministic **`themeForWeek(seed, phase, week)`** that indexes a per-(seed, phase)
**permutation** so no theme repeats within a phase across a season and the two phases diverge; an
**`applyTheme(def, theme)`** that reskins the surfaced name + premise (mechanic beats/winReads kept); the
adapter dressing both the player-facing `runCompetition` result and the #1400 `competitionStagingView`
library in the week's theme, with a Vault-free **`CompetitionResultView.theme`**. Default-**ON** for real
play (`ORWELL_COMP_THEMES`, `=0` to disable), pinned off in the golden driver.

**Out:** the **resolution math** and **mechanic library** (reused unchanged — 0006/0028/0042); growing
the *mechanic* pool (a separate, calibration-costed follow-on — see §7); the narration quality itself.

## 4. Design

- **`CompetitionTheme`** `{ id, label, prefix, setting }` — pure flavor. `label` displays ("Outer
  Space"); `prefix` composes the name ("Zero-Gravity"); `setting` is a scene-setter sentence.
- **Themed name** = `${theme.prefix} ${FORMAT_NOUN[def.format]}` ("Haunted Trivia", "Frostbitten
  Endurance") — coherent because the *format* noun is mechanic-true.
- **Themed premise** = `${theme.setting} ${def.narrative.premise}` — the theme sets the scene, the
  mechanic keeps the action, so the comp stays coherent (a skin, never a new mechanic). Beats + winReads
  are the mechanic's, untouched.
- **Seeded draw.** `themeForWeek` indexes ONE per-seed LCG Fisher-Yates permutation of the pool by week,
  read through a **nonzero seed-derived rotation per same-week beat** → **no repeat within a phase for 24
  weeks** (>> a season), and every distinct same-week beat lands on a distinct theme: HOH/veto rotate by
  different offsets (so same-week comps *always* differ — a nonzero rotation can never map an index to
  itself), and a compressed double-eviction second `cycle` rotates once more (so the night's two
  same-phase crowns never share a skin). A **pure function of (seed, phase, week, cycle)** — no rng draw,
  no persistence, restart-stable.
- **Projection, not state.** The theme is applied only where the def is *surfaced*
  (`runCompetition`, `competitionStagingView`) — it mutates no live state and consumes no beat rng, so
  the seeded winner is provably unmoved.
- **Precedence:** model-authored #1400 fiction > seeded theme > bare 0042 library.

## 5. Contracts (stack-agnostic)

```text
CompetitionTheme: { id, label, prefix, setting }
COMPETITION_THEMES: CompetitionTheme[]                              // 24 curated, tunable skins
themeForWeek(seed, phase, week, cycle=0): CompetitionTheme          // one seeded permutation, rotated per same-week beat; no in-phase repeat
applyTheme(def, theme): { name, theme, narrative }                  // Vault-free reskin; NO stat/score
CompetitionResultView += { theme?: string }                        // the surfaced skin; absent when off
resolveCompetition(...) → winner                                   // UNCHANGED (0006/0042) — theme never crosses
```

## 6. Definition of Done

- [x] **Repeat-free season:** an ~11-week phase draws all-distinct themes (mechanic × theme ⇒ 100s of
      distinct comps), reproducibly by seed, no in-phase repeat.
- [x] **Coherent skin:** the themed name reads as `prefix + format noun`; the premise sets the theme
      scene then keeps the mechanic action; beats/winReads unchanged.
- [x] **Engine still decides (byte-identity):** the seeded winner + eviction trajectory are IDENTICAL
      whether themes are on or off — the theme perturbs no roll.
- [x] **Vault-free:** the themed result carries name + theme + narrative and **no stat/score/ranking**.
- [x] **Flag off is the bare 0042 library** (no theme); default-on for real play; pinned off in golden.
- [x] Seed-deterministic; name-agnostic; added to `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

Expands **0042** (the mechanic library — unchanged); sits on **0006/0028** (resolution — unchanged), feeds
**0018/#1400** (the narrator dresses a specific, themed comp), under **0001** (the result stays
stats/score-free) and ADR **0003** (structured facts to voice, not scripts). **Deliberately does NOT grow
the mechanic pool** — that re-rolls which mechanic a fixed seed draws (its `type` selects the resolution
stat), changing winners and breaking fixed-seed BDD scenarios (0043) — the documented COMP-4 cost that
requires a dedicated calibration re-measurement pass. This feature is the calibration-free half; growing
mechanics is a deliberate, separate follow-on.

## 8. Implementer-ready (Definition of Ready) — as built

- **New** `src/engine/competitionThemes.ts` — `CompetitionTheme`, `COMPETITION_THEMES` (24), `FORMAT_NOUN`,
  `themeForWeek`, `themedName`, `applyTheme`.
- `src/adapters/engine/GameSessionAdapter.ts` — `COMP_THEMES_ENABLED_DEFAULT` (default-on), the
  `compThemesEnabled` field + `setCompThemesEnabled`/`compThemesEnabledNow`, the `themedScaffold(def)`
  helper, wired into `runCompetition` + `competitionStagingView` (precedence: fiction > theme > bare).
- `src/ports/GameSession.ts` — `CompetitionResultView.theme?` + `CompetitionStagingView.library.theme?`.
- `frontend/scripts/_golden_driver.py` — pin `ORWELL_COMP_THEMES="0"` (fixture recorded theme-free).
- **Tests:** `tests/unit/competitionThemes.test.ts` (pure), `tests/unit/competitionThemesLive.test.ts`
  (live + the byte-identity calibration guard), `docs/features/0125-*.feature` → `cucumber.cjs`.
