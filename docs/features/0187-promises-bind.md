# 0187 - Promises bind (ORW-586)

Status: slices 1 and 2 built (engine). Slice 3 (the front-end capture boundary), 4 (NPC binding reads for the new kinds) and 5 (the plan seam for improvised two-faced promises) are not built. Flag `ORWELL_PROMISE_TERMS` (default ON, `=0` opts out; needs `ORWELL_ASSURANCES`). Played games only.

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

## Not yet
The veto and final-two board hooks do not exist yet, so those terms are judged by the pure function only. The only route that writes a term is the engine call `recordPromiseTerm`; no front-end tool reaches it yet.

## Gates
BDD `0187-promises-bind.feature`, `tests/unit/promiseTerms.test.ts`, `tests/unit/promiseTermsEngine.test.ts`, and the unchanged assurance tests (the refactor is behaviour-identical).
