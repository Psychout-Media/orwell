# 0007 — Persistence non-degradation

> **Status:** Built (see the [README status index](./README.md#index)). **Build priority:** #7.
> **Executable spec:** [`0007-persistence-non-degradation.feature`](./0007-persistence-non-degradation.feature)

## 1. Summary

Persisted detail must **never** be lost across saves/versions and should **accumulate and
deepen** over a game — the exact reversal of the old version, whose secret store thinned out
on every update. A save is `{ domain-core version, Vault store, Journal store }`; the **Vault
and Journal are versioned together**. "Deepen" is **active**, not just "don't lose": the
**dynamic `Soul`** (relationship beliefs, emotional history, memory) grows materially richer
over a game while the **static `Character`** baseline holds — a late-game houseguest is far
deeper than at premiere (decision 0001 §3).

> **Live integration → 0023.** This feature is the *store* (lossless, accumulating, versioned).
> Wiring it into the **live** game — every event detail + the derived hidden state actually saved
> on play and recalled on return — is feature **0023** (consequence & memory). Today the live
> session persists nothing; 0023 closes that.

## 2. Operationalizing "detail must accumulate" (answers open decision §16.5)

The spec leaves "how to operationalize non-degradation" open (`bb-sim-spec.md` §16.5). This
feature proposes the concrete test strategy:

| Guarantee | Test |
|---|---|
| **Lossless round-trip** | `deserialize(serialize(state)) == state`, no field dropped |
| **Cross-version superset** | state at version *n+1* ⊇ state at version *n* (no datum removed) |
| **Monotonic accumulation** | counts of events, knowledge facts, relationship edges, and soul attributes are **non-decreasing** across successive saves |
| **Co-versioning** | a Vault version bump implies a Journal version bump in the same save |
| **Active deepening** | the dynamic `Soul` (relationship beliefs, emotional history, memory) grows **materially** from early to late game; the static `Character` baseline is unchanged |

"Superset" is by stable identity (each event/fact/edge has a durable id), so legitimate
*updates* to a record are allowed as long as nothing is **dropped** and history is retained.

## 3. Contracts (stack-agnostic)

```
GameStateRepository:
    save(state) -> SaveRef{ coreVersion, vaultVersion, journalVersion }   # vaultVersion and journalVersion bump together
    load(SaveRef) -> state
Save = { coreVersion, vaultStore, journalStore }
```

## 4. Test strategy

- **Generated fixtures** with rich, accumulated detail (roles only).
- Round-trip equality; cross-version superset; monotonic counts over a **seeded** multi-save
  game; co-version assertion.
- Property-style across seeds: for every adjacent save pair, superset holds and counts never
  decrease.
- **Deepening:** over a long seeded game, assert soul detail (relationship beliefs / memory /
  emotional-history size) at a late save **materially exceeds** an early save, while the
  `Character` baseline is byte-stable.

## 5. Definition of Done

- [ ] All scenarios pass, name-agnostic.
- [ ] Save/load is lossless; no previously-persisted detail is ever dropped.
- [ ] Detail counts are monotonically non-decreasing across a long seeded game.
- [ ] Vault and Journal versions provably increment together.
- [ ] The dynamic soul provably **deepens** over a long game (material growth) while the static
      character baseline is unchanged.

## 6. Dependencies

`GameStateRepository` (persistence adapter), the `EventStore`/`KnowledgeService` substrate
(#2), and the souls from #4 (whose deepening is what must not regress).

## 7. Traceability

`bb-sim-spec.md` §4, §9, §11, §12 (Persistence integrity), §16.5;
`CLAUDE_CODE_INSTRUCTIONS.md` §7, §15.5; `CLAUDE.md` mandate #4.

## 8. Amendment 2026-11-18 (ORW-682): the belief-store check and the cap's compaction agree

The `beliefs` allowance in `sessionCoreSupersetViolation` (`beliefStoreSuperset`) accepts a lost belief only under the per-holder cap's compaction
(refuted first, else oldest). One commit can refute a belief and then compact it away; the check now accepts a lost live belief when no surviving
already-refuted belief is older than it. A live belief lost ahead of an older refuted survivor, or below the cap, is still refused.
