# 0024 — Soul storage & memory recall (markdown + vector)

> **Status:** Built (see the [README status index](./README.md#index)). **How a houseguest's mind is stored and how it recalls the *right* past
> moment.** The dynamic `Soul` is a **markdown narrative** (the evolving inner story — memory,
> emotional history, leanings) **plus an engine-only vector index** for **semantic recall**: the
> most *relevant* past beats, not just the most recent. Recall serves **both** the **narrator** (a
> houseguest vividly remembers a specific moment) and the **mechanics** (the relationship read is
> weighted by relevant history). The engine where "accumulate and deepen" (0007) and "the house
> remembers" (0023) become *intelligent* memory.
> **Executable spec:** [`0024-soul-storage-and-memory-recall.feature`](./0024-soul-storage-and-memory-recall.feature)
> **Also proven by:** `tests/unit/soul.test.ts`

## 1. Summary

The static `Character` (0004/0015) is the byte-stable baseline. The **dynamic `Soul`** is where the
houseguest *changes*, and 0024 specifies its **storage** and **recall**:

- **Markdown narrative** — a growing, human-readable inner story per houseguest: what they remember,
  how they feel, who they lean toward. Appended as events happen; never overwritten away.
- **Vector index (engine-only)** — embeddings over the soul's memories so the engine can **recall
  the most *relevant* past moments** to a current situation (a long-ago betrayal stays salient when
  it matters), not merely the most recent.

Recall feeds **both** halves of the game: the **narrator** gets the relevant memory so an NPC can
reference a specific past beat in their own voice, and the **relationship read** (0017) is weighted
by that relevant history. Both behind `SoulProvider`; the vector index is **Vault-side, engine-only**.

## 2. Scope

**In:** the dynamic `Soul`'s **md + vector** structure; `SoulProvider`; the engine-only
`VectorIndex` + `EmbeddingProvider` (with a deterministic fake for tests); **semantic recall**
serving narration *and* mechanics; the soul's **deepening** (non-degradation); the engine-only /
Vault-Wall boundary.

**Out:** the relationship **math** (0017 — recall *informs* it, doesn't define it); the persistence
**store** mechanics (0007 — the soul is part of the save); the **live wiring** of events → soul
(0023 — consumes this); the narration LLM itself (`NarrativePort`); the **embedding model** choice
at runtime (§9).

## 3. The dynamic Soul (md + vector)

- **`soul.md` (narrative):** a per-houseguest markdown memory — accumulated events as they'd recall
  them, emotional history, evolving leanings. Human-readable (debuggable, and it *is* the soul). It
  **grows** over the game; old memories are kept (they may fade in salience, never deleted).
- **Vector index (per houseguest, engine-only):** each memory is embedded and indexed so the engine
  can retrieve the **semantically nearest** memories to any query/situation. This is the
  `VectorIndex` named since 0001 as **engine-only** — it holds Vault-side soul data.

## 4. Semantic recall (serves narration *and* mechanics)

`recall(holder, context, k)` returns the **k most relevant** memories for `holder` given a
situation `context` — relevance is **semantic** (the deterministic test embedding clusters by
content, so a query about "the veto betrayal" recalls that betrayal, not last night's chat).

- **Mechanics:** the **relationship read** (0017) weights the **recalled relevant** history, so a
  salient old event still shapes trust/threat even when recent interactions were quiet. Recency
  alone would forget the grudge; recall keeps it alive *when it's relevant*.
- **Narration:** the engine hands the narrator the **recalled memories** as candidate context, so a
  houseguest can say "after what you pulled at the veto, why would I trust you?" — a *specific*
  memory, in their voice.

## 5. Engine-only, Vault-side (the boundary)

The vector index and the full `soul.md` are **engine-only** — the `VectorIndex` holds hidden soul
data, so **no outward module may depend on it** (dependency-cruiser, exactly like `VaultStore`).
Recall runs **engine-side** over the *full* (hidden) soul. **What reaches the player is filtered**
by the knowledge/visibility model (0002): an NPC may only *voice* a memory the player legitimately
shares or is told — so a recalled hidden memory shapes the NPC's **behavior** but only surfaces to
the player through a legitimate pathway. Player-facing output stays **sentinel-clean** (0001).

## 6. Deepening (non-degradation, 0007)

The `soul.md` **grows** and the vector index **accumulates** over a game — a late-game houseguest's
soul is materially deeper than at premiere, while the static `Character` stays byte-stable. Memory
counts are **monotonic** (salience may decay; the record does not thin). This is the **active
"deepen"** the mandate demands, made concrete at the soul layer.

## 7. Contracts (stack-agnostic)

```
SoulProvider:
    characterOf(hg) -> Character                       # STATIC baseline (0004/0015) — byte-stable
    soulOf(hg)      -> Soul                             # DYNAMIC: the md narrative + leanings/emotional state
    recordToSoul(hg, memory)                            # append a memory (md) + index it (vector); never deletes
    recall(hg, context, k) -> Memory[]                  # the k semantically-most-relevant past memories

# Engine-only (NEVER injected into any outward adapter/tool) — like VaultStore:
VectorIndex:
    index(hg, memory, embedding)
    search(hg, embedding, k) -> Memory[]
EmbeddingProvider:
    embed(text) -> vector                               # real model at runtime; DETERMINISTIC FAKE for seeded tests
```

**Invariants:** the soul splits into byte-stable `Character` + growing `Soul`; `recall` returns
**semantically relevant** memories (deterministic under the fake embedding + seed); the soul
**deepens** (md grows, index accumulates, monotonic) over a game; **no outward module depends on
`VectorIndex`/the full soul** (dependency-cruiser); player-facing recall output is **sentinel-clean**.

## 8. Test strategy

- **Relevance, not recency:** seed a soul with an old salient memory + many recent trivial ones;
  `recall` for a context matching the old one returns it (the deterministic fake embedding clusters
  by content). Recency-only would miss it.
- **Recall drives mechanics:** the relationship read shifts when a relevant adverse memory is
  recalled vs when it isn't (cross-checks 0017).
- **Recall drives narration:** the narrator's context includes the recalled memory; an NPC can
  reference a *specific* past beat — but only one the player legitimately shares (else it shapes
  behavior silently).
- **Deepening (0007):** over seeded play the `soul.md` length + indexed-memory count grow
  monotonically; the `Character` baseline is byte-stable.
- **Engine-only boundary:** dependency-cruiser proves **no** outward module imports `VectorIndex`
  or the full soul; player-facing recall output is **sentinel-free** under a populated Vault.
- **Deterministic:** same seed + fake embedding ⇒ same recall.

## 9. Open decisions (flagged)

- **Embedding model at runtime** (open decision #4): which model backs `EmbeddingProvider` live; a
  **deterministic fake** covers seeded tests. Flag.
- **`soul.md` structure:** ✅ **RESOLVED — Option B (lightly-sectioned)** (PO ruling 2026-07-06). The
  inner diary renders under three headings — **Memories** (happenings), **Leanings** (trust / alliance
  / target drift), **Feelings** (the emotional log) — instead of one flat stream. Each memory's section
  is DERIVED from its content by a deterministic classifier (`classifySoulSection`, engine-only), with
  an optional explicit override on `recordToSoul`; the authoritative `memories[]` list is unchanged
  (flat, append-only, monotonic), so nothing thins and sections re-derive identically on restore. Built
  & gated (`tests/unit/soul.test.ts`, the "inner diary is organised into sections" `.feature` scenario).
- **Recall `k` + relevance threshold:** tunable config (like the temperature/relationship numbers,
  0006/0017); the *shape* (semantic, relevance-ranked) is fixed.

## 10. Definition of Done

- [ ] The dynamic `Soul` is `md` narrative + an engine-only vector index, behind `SoulProvider`.
- [ ] `recall` returns **semantically relevant** memories (proven with the deterministic fake +
      seed), and feeds **both** the relationship read (0017) and the narrator's context.
- [ ] The soul **deepens** monotonically over a game; `Character` stays byte-stable (0007).
- [ ] **No outward module** depends on `VectorIndex`/the full soul (dependency-cruiser); recall
      output reaching the player is **sentinel-clean** (0001), pathway-filtered (0002).
- [ ] Deterministic under seed + fake embedding.

## 11. Dependencies

**0004/0015** (the static `Character`), **0017** (the relationship read recall weights), **0007**
(the soul persists + deepens), **0001** (`VectorIndex` engine-only — the boundary), **0002** (recall
output to the player is pathway-filtered), **0023** (the consequence loop records to the soul and
calls recall), `SoulProvider` / `EmbeddingProvider` ports. The vector layer named since 0001 finally
gets its feature.

## 12. Traceability

`CLAUDE.md` (Character/Soul split; "souls may be md and/or vector-backed"; the non-degradation
mandate — "accumulate and deepen"); `docs/decisions/0001` (Character/Soul), `0002` ("vector recall
can surface relevant past interactions to inform the read"); `docs/features/0001` (`VectorIndex`
engine-only + `EmbeddingProvider` + deterministic fake); `0007` (the soul deepens); `0023` (memory).

## NPC memory ledger (0024 follow-on, #1967 / #2022 / #2059) - what is built (AMEND 0024 #1, 2026-11-04)

Distinct from soul-vector recall above: a **structured, engine-adjudicated ledger** the strategic decisions read (never `SoulProvider.recall`). `src/engine/npcMemory.ts`; ON by default (`ORWELL_NPC_MEMORY`, `ORWELL_NPC_MEMORY_WRITERS`, and the standalone read `ORWELL_NPC_MEMORY_STANDALONE` all flipped ON with PO ruling 2026-11-03, #2059; `=0` rolls each back).

- **Shape.** `npcMemory[holder][subject] = MemoryEntry[]` on the live state (persisted with the season). Holders are NPCs only; the player never holds a ledger entry.
- **Kinds.** Grudges: `deal-broken` (attributed breaks only), `nominated-by-friend`, `replaced-by-friend`, `nominated-by-hoh`, `veto-withheld`. Favors: `veto-saved`, `deal-kept`. Each entry carries `week` and `severity` (0..1).
- **Per-pair cap of 6** (`maxEntriesPerPair`): over the cap the entry with the lowest *decayed* weight drops first (`severity x 0.5^(age/halfLife)`), so six stale low-severity favors can never evict a fresh betrayal.
- **Salience** = `severity x 0.5^(weeks / (halfLifeWeeks / decayScale))` with `halfLifeWeeks = 4`; combined across entries as `1 - prod(1 - s_i)`. **`decayScale` is the holder's own temperament** (the live *effective* disposition, `dispositionReadOf`): a clash holder (0.5) forgets grudges slower than a bond holder (1.7).
- **Decision term** = `grudgeMax (0.15)` / `favorMax (0.06, weaker on purpose - negativity bias)` x salience. With the standalone read ON (default) it is the memory on its own; with it OFF it is the legacy *residual floor* (memory minus what the relationship edge still carries, so a fresh betrayal is never double counted).
- **Writers.** Ceremonies and deals (`remember(...)` in `GameSessionAdapter`): HOH nominations and replacements (trusted holder => the `-by-friend` kinds; any nominee => `nominated-by-hoh`), veto saves/withheld vetoes, deals kept/broken. **Sealed-ballot deal breaks write nothing** (the vote stays anonymous until the 0048 retrospective; `reveal` records the attribution Vault-side only). Chat betrayals/favors are a planned writer (B7, unified memory), not built.
- **Readers.** Nominations, replacement, veto decisions, eviction votes and the NPC deal-offer gate (`dealOfferGrudge 0.08` stops an NPC offering a safety deal to a player it holds a grudge against). A unified "every decision reads every memory source" interface is the #2017 acceptance requirement (design/npc-memory-inventory.md); the soul-vector index / `recall` and edge `confidence` have **no behavioural reader** today.
- **Live gates:** `tests/unit/betrayalShiftsNominees.test.ts` (a recorded betrayal changes the real nominees of the NPC HOH vs a same-seed control); `tests/unit/soulClashLive.test.ts` (the live temperament wiring reaches `memoryDecayScale`); `tests/unit/ballotAttributionSeal.test.ts` (sealed break: no attribution outward). Still owed: a Gherkin scenario for the sealed-break-leaves-no-ledger-trace case with an NPC as the wronged party.
