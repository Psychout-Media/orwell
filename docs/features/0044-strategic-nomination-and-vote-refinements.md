# 0044 — Strategic nomination & vote refinements

> **Status:** **Built** (BDD-gated in `cucumber.cjs`; `nominationStrategy` in `season.ts`, `voteChoice` in
> `liveSeason.ts`, tunables in `decisionConstants.ts`). PO-reviewed 2026-07-13 (the earlier "Draft" label was
> stale doc-drift). An **enhancement**, not a new system. The NPC **nomination** and **vote** engines are
> already **built, live, and relationship-driven** (`season.ts` `chooseNominations`, `liveSeason.ts`
> `npcChoice`, `jury.ts` `castJuryVote`) — the engine decides, not the narrator. The audit found two real
> **thinnesses**: nominations key on **`threat` only** (so an HOH always names the two biggest threats — no
> pawns, no backdoors), and eviction votes **ignore the voter's emotional state, bloc, and any deal**. This
> feature enriches both decision functions with those dimensions — still fully **engine-decided** and seeded,
> a sibling to the 0026 relationship constants.
> **Executable spec:** [`0044-strategic-nomination-and-vote-refinements.feature`](./0044-strategic-nomination-and-vote-refinements.feature)

## 1. Summary

The base engines aren't broken — they're flat. A real HOH doesn't just nominate the two scariest people:
they put up a **pawn** beside a target, plan a **backdoor**, or **protect their bloc**. A real voter isn't a
pure threat calculator: a **rattled** houseguest votes self-protectively, a **bloc** votes together, a
**deal** is honored or broken. 0044 layers these strategic dimensions onto the existing `chooseNominations`
and `npcChoice` — gated by personality/disposition so different houseguests play differently — without
rebuilding the loop and without letting the narrator decide anything.

## 2. What exists today (the gap this closes)

- **Nominations = top-2 threat.** `season.ts` `chooseNominations` ranks `active` by `rel.edge(hoh, x).threat`
  and takes the two highest. Correct but one-dimensional — no pawn, backdoor, or bloc protection.
- **Votes = higher-threat nominee.** `liveSeason.ts` `npcChoice` votes for the scarier nominee (HOH tiebreak).
  The voter's **emotional state isn't an input** (it feeds competitions, not votes); **bloc** (0043) and
  **deal status** (0039) aren't factored.
- The jury vote (`castJuryVote`) is already richer (lean + manner + appeal) — left as-is.

## 3. Scope

**In:** a **nomination strategy** layered on `chooseNominations` — a blended score (threat primary) plus
**pawn-beside-target**, **backdoor** (nominate to bait the veto, then target on the replacement), and
**bloc protection** (0043) patterns, **gated by the HOH's personality/disposition** (a strategic archetype
backdoors; a loyal one shields their bloc; an emotional one targets erratically — read from `CHARACTER`/soul);
and a **vote model** layered on `npcChoice` blending **threat + bloc alignment (0043) + emotional state
(0041) + deal honor/break (0039) + jury-management awareness**. Both stay **engine-decided**, **bounded**,
**seeded**, and **tunable from one constants module** (sibling to 0026/0028).

**Out:** rebuilding the weekly loop (0011) or the jury (0014); the relationship math (0026 — reused as the
substrate); the *binding-decision seam* (0034); turning this into a new system (it's a refinement). The new
inputs depend on **0039/0041/0043** — the **threat/trust/political-temperature** parts can ship first, the
**bloc/mood/deal** terms as those features land.

## 4. Design

- **Nomination strategy.** `nominationStrategy(hoh, active, rel, blocs, week)` produces two legal noms (0005)
  from a blended read: threat (primary) + the **week's political temperature** (the house-wide threat
  distribution — is there a runaway threat? a quiet week?) + **bloc protection** (don't nominate bloc-mates) +
  **archetype-gated tactics** (pawn / backdoor / direct). The *which-tactic* choice is gated by the HOH's
  disposition, so HOHs feel distinct. The favorite target still usually goes up — but not always *both*
  biggest threats, and sometimes via a backdoor.
- **Vote model.** `voteChoice(voter, finalNominees, rel, blocs, mood, deals)` blends threat + **bloc alignment**
  (vote with your bloc, 0043) + **emotional state** (0041 — a rattled/distressed voter weights self-protection
  and is more erratic; a confident one steadier) + **deal status** (0039 — honor a vote deal, or break it with
  the betrayal consequence) + light jury-management awareness. Bounded; the HOH still breaks ties.
- **Engine-decided (anti-sycophancy).** Every nomination and vote is computed from these signals + seeded
  temperature — **never** parsed from or decided by narration. Personality/disposition come from the static
  `CHARACTER` + evolving soul; the magnitudes live in **one tunable constants module**.
- **Vault Wall.** All signals are hidden; the player sees only the resulting noms/votes and infers the
  strategy. No score/number on any player surface (sentinel-clean).

## 5. Contracts (stack-agnostic)

```
nominationStrategy(hoh, active, rel, blocs, week): [nomA, nomB]   // legal (0005); threat-primary + pawn/backdoor/bloc, archetype-gated
voteChoice(voter, finalNominees, rel, blocs, mood, deals): nominee // threat + bloc(0043) + mood(0041) + deal(0039) + jury-mgmt
constants: ONE tunable module (sibling to 0026/0028) — no magnitude hard-coded outside it
invariants: engine-decided + seeded; bounded; never overrides 0005; player sees no number
```

## 6. Definition of Done

- [ ] **Strategic nominations:** noms reflect more than raw threat — **pawns, backdoors, and bloc protection
      appear**, gated by HOH disposition — while threat still dominates the target choice; the two biggest
      threats are **not always both** nominated.
- [ ] **Richer votes:** an eviction vote folds **bloc + emotional state + deal status** — a rattled, or
      bloc-aligned, or deal-bound voter votes **measurably differently** than the bare threat model.
- [ ] **Engine-decided (anti-sycophancy):** every nomination and vote is computed from the signals + seeded
      temperature — never narration; the favorite outcome holds in aggregate with strategic variation.
- [ ] **Tunable + bounded + deterministic:** magnitudes live in **one module**; emotion/bloc/deal terms never
      override hard rules (0005); same seed ⇒ same decisions.
- [ ] **Vault-free:** no score/number on any player surface (extend the 0001 canary); name-agnostic; added to
      `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

Enriches the **built** `chooseNominations`/`npcChoice` (0011/0014) on the **0017/0026** relationship substrate,
adding the **0043** bloc, **0041** emotional-state, and **0039** deal signals, all **engine-decided** under
**0001** (Vault Wall) and seeded. Honors the user's two highest-priority asks (NPC nomination & vote engines)
the right way: the systems exist — this gives them the strategic dimensions that keep the game from feeling
one-note, without ever letting the storyteller decide.

## 8. Implementer-ready (Definition of Ready)

**Touch points (exact):**
- `src/engine/season.ts` `chooseNominations(hoh, active, rel)` (L72) — generalize into a blended
  `nominationStrategy(hoh, active, rel, blocs?, week?, constants?)` (keep `chooseNominations` as a
  threat-only fallback so callers compile before deps land). Call site: `liveSeason.ts` L363.
- `src/engine/liveSeason.ts` `npcChoice` (eviction vote, ~L169) — extend into
  `voteChoice(voter, finalNominees, rel, blocs?, mood?, deals?, constants?)`; replacement selection
  also reads the strategy (`selectableReplacements`, L151).
- **New** `src/engine/decisionConstants.ts` — the single tunable module (sibling to
  `relationshipConstants.ts` L47/L68): pawn/backdoor weights, bloc/mood/deal term scales, political-
  temperature weight. **No magnitude hard-coded outside it.**

**Build order / deps (ship in slices — guard new inputs as optional so it compiles early):**
1. **Now (no deps):** threat-primary + **political temperature** (house-wide threat spread) + pawn/backdoor,
   gated by HOH disposition (read `Character` archetype/soul).
2. **+ 0043:** pass `blocs` → shield bloc-mates / target the shared enemy.
3. **+ 0041:** pass `mood` (`emotionalState`) → rattled votes self-protectively.
4. **+ 0039:** pass `deals` → honor/break a vote deal (with the betrayal consequence).

**Test targets:** `tests/unit/strategicDecisions.test.ts` (+ deps' fakes) and
`docs/features/0044-*.feature` → add to `cucumber.cjs`. Assert each DoD bullet (§6): noms beyond raw
threat (pawn/backdoor/bloc, disposition-distinct), votes fold bloc/mood/deal, **engine-decided + seeded**,
one constants module, never overrides 0005, no score on any player surface (extend the 0001 canary).

**No open decisions.** Defaults: threat stays the dominant nomination signal; tactics are disposition-gated;
all terms bounded. Tunable later via the new module / a future God-Mode knob.

## 9. Amendment — 2026-11-02 (PO difficulty rulings)

Measured on the deployed profile, the game was far too easy: a passive player reached the Final 2 in about
a third of seasons. The owner set difficulty targets (`docs/decisions/PO-DECISIONS-LOG.md`, 2026-11-02):

- passive: F2 about 5–10%, win under 5%;
- active: F2 about 12–20%, win about 6–10%.

The owner also asked for three BB staples, **without removing NPC agency**. They extend the existing
tactic layer here; they are not a new system:

- **Floaters make easy nominations ("pawns go home").** `floaterRead` (`season.ts`) is 1 when no one in the
  house holds a bond toward a houseguest above the edge baseline, falling to 0 at baseline +
  `floaterBondSpan`. A pawn seat pulls toward the biggest floater: nobody fights for them.
- **Break up the duo.** `duoRead` scores a houseguest locked in a tight **mutual** pair with someone other
  than the HOH. When the target has such a partner (`duoPartner`), a duo-minded HOH puts the partner up
  beside them.
- **The eviction vote is a referendum on the HOH.** `voteChoice` adds `vote.hohReferendumWeight` × the
  voter's alignment with the HOH (bond above baseline, minus threat) to the HOH's target — a bounded term
  among the others. Aligned voters tend to give the HOH their target; opposed voters tend to keep the
  target and send the pawn home.
- **Per-houseguest NOMINATION STYLE (agency).** No single house-wide rule. Each NPC reads the block through
  a style fixed by archetype for the season (`NOMINATION_STYLES` / `NOMINATION_STYLE_BY_ARCHETYPE` in
  `decisionConstants.ts`). Threat, blocs, bonds and grudges still decide first; a style only weights the
  floater / duo reads that tip close calls. The player can learn each HOH's lens.

  | Style | Archetypes | Lens |
  |---|---|---|
  | threat hunter | comp-beast, hothead, analyst, floater | the biggest competitor; barely weighs floaters |
  | floater cleaner | villain | "you're not doing anything, you're going up" |
  | duo breaker | mastermind, wildcard | splits power pairs, often both halves |
  | loyalist | social-butterfly, underdog, flirt, loyalist, peacemaker | protects their own; the pawn is whoever nobody will miss |

- **Pawn or target as the replacement (PO 2026-11-02).** After a veto, `replacementPick` (`season.ts`) checks
  whether the houseguest still on the block is the HOH's target. If yes (the pawn came down), the
  replacement is a new **pawn**, chosen by the same pawn-seat read. If no (the target came down, or it's a
  backdoor), the replacement is the new **target**. The player's NPC proxy uses the same read.
- **Comp wins raise threat more:** `COMP_WON_IMPACT.threat` 0.14 → 0.20 (`relationshipConstants.ts`).

All of these are engine-decided, deterministic per seed (no new rng draw), hidden (no number crosses to
the player) and tunable from the constants modules. The calibration instrument's active arm now tends two
allies every week. Before, it ran a single burst of premiere scenes that decayed by mid-season.
