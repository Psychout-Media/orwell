# 0014 — Jury & endgame

> **Status:** Built (see the [README status index](./README.md#index)). The finale — jury of 9, Final 2, the jury vote, and **jury management** as a
> real mechanic.
> **Executable spec:** [`0014-jury-and-endgame.feature`](./0014-jury-and-endgame.feature)

## 1. Summary

The last **9 evictees** form the **jury** (sequestered from the first juror's eviction; they
observe the rest). At **Final 2**, each finalist gives a brief statement, each juror asks **one
question of each finalist** (0037), and the jury votes — revealed one at a time. The winner has the **most votes**; a tie
is broken by the **last-evicted juror**. **Jury management is real:** how the player treated each
houseguest on the way out genuinely shapes their vote.

## 2. Scope

**In:** jury formation/sequester timing; the **jury-management → vote** influence; the Final 2
choreography; the vote tally + tie-break; the winner.

**Out:** the weekly loop that reaches Final 2 (**0011**); the conversation mechanics used for
statements/answers (**0012**); the relationship math underlying jury leanings (**decision 0002**).

## 3. Jury formation

The jury is the **last 9 evictees** (16-cast Final-2 → evictions 6–14; the first 5 are pre-jury,
per 0011). Sequester begins at the first juror's eviction; jurors observe the remainder of the
game.

## 4. Jury management (the real mechanic)

Each juror's lean toward a finalist is a function of:
- their **relationship** with that finalist at eviction — trust/affinity/threat (decision 0002), and
- the **manner of their eviction** — a juror who was **blindsided, betrayed, or disrespected** is
  **less** likely to vote for the responsible finalist; one who felt **respected** is more
  persuadable.

So the long game (how you treat people on the way out) is what mostly decides the finale. The
**responsible finalist** is read symmetrically: the **player** counts as a responsible houseguest like
any NPC (live realization + symmetry fixes in **0037**, audit A5/A6), so a juror the **player**
blindsided weighs that against them too.

## 5. Final 2 choreography

1. Each finalist gives a **brief opening statement**.
2. Each juror asks **one question of each finalist** (18 Q&A total, 0037); the player answers in
   **free-text** (hybrid model, 0012); the LLM voices each juror authentically from their history with each finalist.
3. Votes are cast **privately** and **revealed one at a time** for drama.

## 6. The vote model (engine-owned)

> **Current vote terms (AMEND 2026-11-06, from `src/engine/juryConstants.ts`):** five weighted terms, not two: relationship 1.0, eviction manner 0.8, demonstrated loyalty (reliability) 0.4, game respect 0.7 (public comp-win resume, ruling 2026-06-11; Final HOH part wins credit it once each), finale 0.3; plus the 0100 jury-house grudge folded into the bond read, and per-juror profiles when `ORWELL_JUROR_PROFILES` is on (code default off today, ORW-16). **Where the passive-win guard lives:** the PR-blocking jury gate allows `F2_WIN_MAX = 3` of 20 passive seasons with `EARNED_WINS = 2` (`tests/property/juryReachShared.ts`); the owner's "passive win under 5%" band lives in `tests/calibration/poTargetBands.ts` and the non-blocking nightly. The text below describes the original two-term model.

Each juror votes for a finalist based on **(a) accumulated jury relationship — dominant** plus
**(b) the finale performance** (statement + answers), which **sways close/undecided jurors but
rarely overturns a clear lead**. The relative weight is **tunable config** (default:
jury-management-dominant). The **engine decides** the vote; the **LLM voices** jurors but never
decides — the player cannot talk past the model arbitrarily (anti-sycophancy). Most votes wins;
**last-evicted juror breaks a tie**. *(Deliberate: with a jury of 9 — odd — a tied jury vote is
**unreachable in the untwisted format**; the tie-break exists for the returning-juror twist
family, where the jury can become even.)*

## 7. Contracts (stack-agnostic)

```
jury(state) -> [Houseguest x9]                         # the last 9 evictees
juryLean(juror, finalist) -> score                     # relationship (0002) + eviction manner
runFinale(finalists, jury) -> { statements, questions } # player answers via 0012
finalePerformance(finalist, answers) -> score          # tunable weight; sways close jurors
tallyJuryVote(jury, finalists) -> winner               # most votes; tie -> last-evicted juror
```

## 8. Test strategy

- The jury is exactly the **last 9 evictees**.
- A juror **blindsided/disrespected** by a finalist is **less likely** to vote for them
  (cross-checks decision 0002 / jury management) — property over seeds.
- **Jury management dominates:** a well-managed finalist wins more across seeds; a strong finale
  **sways close jurors but rarely overturns a clear lead** (calibrated; weight tunable).
- The winner has the **most votes**; a **tie** is broken by the **last-evicted juror**.
- The **engine decides** the tally; the LLM voices jurors but does not change votes (engine-owned).

## 9. Definition of Done

- [ ] Jury = last 9 evictees; sequester at the right eviction.
- [ ] Jury leans reflect relationship + eviction manner; well-managed finalists win more.
- [ ] Finale sways close jurors within the tunable bound; never arbitrary.
- [ ] Correct tally + last-juror tie-break; vote is engine-decided, LLM only voices.

## 10. Dependencies

0011 (loop → Final 2; eviction order → jury), decision 0002 (relationship/jury leanings), 0012
(statements/answers), 0005 (the last-juror tie-break rule).

## 11. Traceability

`docs/legacy/BB_GameBible.md` §11 (jury & endgame; jury management); `docs/bb-sim-spec.md` §3,
§11; `CLAUDE.md` jury & endgame; decision 0002 (jury leanings).
