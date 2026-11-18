# 0187 - Promises bind (ORW-586)

Status: slices 1 to 5 built (slice 3 the capture boundary, slice 4 the NPC binding reads, slice 5 the plan seam, below). Flag `ORWELL_PROMISE_TERMS` (default ON, `=0` opts out; needs `ORWELL_ASSURANCES`). Played games only.

## What it does
The open ledger keeps what people said as free text and changed nothing. An entry may now also carry one closed, typed term: who promised (`by`), to whom (`to`), what (`no-nominate`, `no-evict-vote`, `use-veto-on`, `not-use-veto-on`, `final-two`, or open-text `share-info`), an optional `subject` (when it is not the one it was said to) and a `window` (`week`, the default, or `season`). The engine judges a termed promise from public board facts and nothing else: no model decides. A promise with no term, or `share-info`, is never judged.

## Rules
- `judgePromise(term, boardFact)` (`src/engine/promiseTerms.ts`) is pure and deterministic. A `season` window can only be broken (never kept ahead of the end); `final-two` is settled by the final-two fact alone.
- One funnel in the adapter judges every open termed entry on the same hooks that settle casual assurances (nominations, the nominated houseguest, the eviction vote). A verdict closes the entry through `closeOpenEntry` with an engine-written note that names nobody.
- One resolver: "will not nominate you" and "will not vote you out" also write the matching assurance row, and the assurance ledger folds them; the term only closes the visible entry. Any other termed promise is folded by the term itself.
- The fold is `foldBrokenPromise` / `foldKeptPromise` (the assurance break and keep, factored with no behaviour change), using the assurance constants: trust drop 0.12, claim confidence 0.8, memory at the broken or kept severity. A broken termed promise writes a lied-to-me claim with a stable id per wronged houseguest, promiser and entry, so a repeat fold writes nothing new. Nothing acts on the player's hidden read: a promise made to the player closes but folds nothing on the player; a promise the player breaks does fold on the houseguest it was made to.
- Every effect on the wronged side is one function, `applyBreakToWronged`, so a later "learned of the break" gate can wrap it.
- A verdict at the SECRET ballot is pool-split across everyone who could have cast it, names nobody, writes no claim, and leaves the visible entry open (a "broken" line would single the voter out).
- The front end may not mark a termed entry kept or broken (`engine-judged`); it may withdraw it. A term is set once and never edited; a malformed saved term is dropped on load and never locks writes.

## Gates
BDD `0187-promises-bind.feature`, `tests/unit/promiseTerms.test.ts`, `tests/unit/promiseTermsEngine.test.ts`, and the unchanged assurance tests (the refactor is behaviour-identical).

## Amendment 2026-11-18 - slice 4: an NPC promiser's own decisions read their promises
Before this slice the veto and final-two terms were judged by the pure function only: no board hook fired for them and no decision read them. Now:
- The keep-or-break call is the casual assurance one (`decideKeep`): the promiser's keep weight (loyalty, aggression) times the promise's sincerity (an engine-recorded term is sincere) against what breaking would pay them. For `use-veto-on` and `final-two` that is how threatening the promised houseguest reads to them; for `not-use-veto-on` it is how much they trust the one they would be saving. Deterministic, no randomness, only the promiser's own open promises of this week (or a season window). No new store: the open ledger entry's term is read.
- The NPC veto holder's save read takes a 6th bias term (`promiseVetoFor`): a kept `use-veto-on` leans toward saving the promisee and a kept `not-use-veto-on` away from it (`PROMISE_VETO_LEAN`, the scale of the other bias terms; a holder on the block still saves themselves). A promise deliberately broken adds nothing: the holder's own read stands.
- The NPC final HOH at the Final 3 who keeps a `final-two` promise spares the rival they promised, whatever their own read would have sent out (`promiseFinalTwoFor`, recorded as the rule `keeps-final-two-promise`).
- The veto and the Final 2 now settle termed promises on the public fact: the decided veto (used on whom, or not used) when the eviction beat opens, the Final 2 when it is set. Both go through the one funnel, so a broken promise folds once through `foldBrokenPromise` and a kept one through `foldKeptPromise`, with the same magnitudes. Idempotent: a closed entry is never judged again.
- The player is never a promiser in these reads (the engine never acts for the player); a promise the player breaks is judged and folds on the NPC promisee as before.
- Same flag (`ORWELL_PROMISE_TERMS`, default ON, played games only). Off: no hook on the season context, byte-identical.
Gates: `tests/unit/promiseTermsBinding.test.ts`, the new BDD scenarios, and the decision x memory-source tables (`memorySources.ts`).

## Amendment 2026-11-18 - slice 5: the plan seam for improvised NPC promises
Until now an NPC's improvised termed promise was always sincere in the slice 4 reads. It now gets a secret plan the way a formal deal does (0178).
- When an NPC's termed promise is recorded (`recordPromiseTerm`, the one write door), the engine decides the plan with the existing `decidePlan`: the person's cunning, the promises and deals they have made, the bond with who they promised, the house culture, and whether breaking would pay them. The rolls come from a side stream keyed on the seed, the entry and the promiser (never the shared rng). The plan is stored once, append-only, in the same plan store as the deal plans, under its own key namespace (`ledgerPlanKey(entryId)`, `ledger:` plus the entry id), so no reader keyed on a deal id can ever match it.
- The shape of the plan follows the promise: "will not nominate" and the two veto promises plan like the keep-your-hands-off deals (break at the nominations, or hold it a week), "will not vote out" like a vote deal (a flip at the vote), "final two" like the final-two deal (cut at the final three, or break at a later moment). `share-info` is never judged and gets no plan. A promise the player made gets none: the engine never plans for the player.
- The slice 4 reads (`decideKeep` for the veto and final-two promises, the no-nominate and no-evict-vote assurance reads) now read the plan through `dealPlanSource().planOf`, with `PLAN_SEMANTICS`, `isBetrayal` and `momentDue` as a deal does. A betrayal whose moment is due breaks the promise at that decision: the promiser's choice goes against it and the judge folds it once through `foldBrokenPromise`, the same fold as any break. An honest plan, or a betrayal whose moment has not come, keeps (the promise is then sincere, overriding the older per-row sincerity roll). No plan (a flag off): today's behaviour, byte-identical.
- At the sealed ballot a planned flip breaks the promise but, as ever, names nobody: the break is pool-split, no claim, the visible entry stays open.
- Hidden: the plan and its key are Vault-class and never reach the narrator, the player or the admin views. After the crown only, the retrospective lists each plan beside how the engine settled the promise, beside the deal plans (`ledgerPlanRetroRows`; the shared `buildDealPlanRetro` is untouched).
- Both flags must be on: `ORWELL_PROMISE_TERMS` (default ON) and `ORWELL_DEAL_PLANS` (default ON). Off: no plan is made or read.
Gates: `tests/unit/promiseLedgerPlans.test.ts`, the new BDD scenarios, and the unchanged deal-plan tests.
