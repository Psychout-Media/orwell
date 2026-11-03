# 0023 — Consequence & memory (the living, persisted game loop)

> **Status:** Built (see the [README status index](./README.md#index)). **The MVP-1 backbone — formerly the project's biggest gap, now closed.** Every happening
> (conversation, competition win, vote, scheme) is **recorded as an event**, **folds its hidden
> impact into the relationship/soul layer** (your actions change how houseguests feel about you,
> invisibly), and **persists to long-term memory** so leaving and returning never erases it. The
> building blocks (0002 events, 0017 relationships, 0007 persistence) are now **wired into the
> live game** (durably via 0030; committed through the 0031 orchestrator checkpoint). This
> feature was that wiring — and the tests that prove it works.
> **Executable spec:** [`0023-consequence-and-memory.feature`](./0023-consequence-and-memory.feature)
> **Also proven by:** `tests/unit/consequence.test.ts`

## 1. Summary

The loop a real *Big Brother* game lives on:

```
happening  →  recorded as an event (witness set + hidden flag, 0002)
           →  the engine applies its HIDDEN impact to the relationship/soul layer (0017)
              (trust / affinity / threat move — your action changes how they feel about you)
           →  persisted to LONG-TERM memory: every event detail + the derived hidden state (0007)
           →  recalled in full on return / restart — the house still remembers.
```

The opinion change lives in the **hidden layer** (Soul beliefs / Vault) — the player **never sees
the numbers**, only the later behavior (who seeks them out, who targets them). That is the Vault
Wall working as intended: the change is real and recorded, and invisible.

## 2. Scope

**In:** wiring the **live** game so (a) every happening is recorded, (b) it updates the hidden
relationship/soul layer, (c) all event details + derived hidden state persist to **long-term
memory**, (d) they are recalled on return; the **end-to-end tests** that prove the loop.

**Out:** the relationship **math** (0017 — *which* signals move, by how much); the
event-visibility model (0002); the serialization **mechanics** (0007 — reused); how an utterance
is turned into an interaction *label* (§5 fork); narration (0018/0019). This feature **integrates**
those; it does not re-spec them.

## 3. Record — every happening becomes an event

Conversations, competition results, nominations, votes, schemes — each is recorded in the
`EventStore` with its **witness set + hidden flag** (0002). Player-witnessed ⇒ the player's
knowledge; off-screen ⇒ Vault-only. **Nothing meaningful goes unrecorded** (ties the daily-event
invariant, 0008).

## 4. Apply — the happening changes the hidden layer

The engine folds each event's **impact** into the directed relationship edges / soul of the
houseguests involved (`RelationshipModel.apply` or equivalent, 0017): a kind word nudges
trust/affinity up; a blindside slams trust down and threat up; **being voted against** raises a
juror's threat/▼affinity toward the responsible player. This is where *"if I say a thing and it
changes your opinion of me, it updates in the Vault without me knowing"* actually happens — on
the **live** player's actions, not only the off-screen sim.

## 5. Hide — the change is real and invisible

The updated trust/affinity/threat lives in the **Soul/Vault** (engine-only). It **never** reaches
the player: no surface shows the numbers, no "their opinion of you dropped" message — the Vault
Wall holds (0001). The player infers it from later behavior (the guiding principle, 0020). The
player sees **consequences**, never the **ledger**.

## 6. Persist — all event details, long-term

**Every event detail** (content, initiator, witness set, hidden flag, timestamp, kind) **and** the
derived hidden state (relationships, souls, knowledge) persist to **long-term memory** — the real
store (SQLite per 0007, not the in-memory shell). Persistence is **lossless and accumulating**:
counts only grow, detail never thins (non-degradation, 0007). The save survives a process restart.

## 7. Recall — the house remembers

On return (reload, or a restart of the engine), the **full** event history + hidden state is
restored. A houseguest you wronged three weeks ago **still** holds the grudge; an alliance you
built is **still** there. Recall is a **superset** of what you left with — never a reset, never a
thinning (0007).

## 8. Open decisions (flagged; the tests below are agnostic to both)

The end-to-end guarantees (§9) hold regardless of how these resolve — pick during implementation:

- **Who labels the impact.** The **LLM proposes** an interaction's nature ("that played as a
  betrayal") and the **engine applies** the magnitude (default — keeps the engine the decider, the
  LLM a labeler) **vs** the engine classifies the event itself. Either way the **engine owns the
  numbers** (anti-sycophancy).
- **Update timing.** Apply impacts **eagerly per event** (the stateful `apply` model that exists)
  **vs** **recompute from the full event history** on read (the "computed from history" model,
  decision 0002). Both must pass the same tests; recompute leans harder on persisted events.
  *(**Foreclosed — eager `apply` won.** The as-built game applies impacts eagerly per event, and
  0026 (relationship math), 0039 (deal/betrayal folds), and 0041 (soul evolution) all build on the
  applied model. Switching to recompute-on-read is no longer a live option.)*

## 9. Test strategy (the heart of this feature — roles only, seeded)

1. **An action changes the hidden opinion.** Record a player→NPC interaction (a kind gesture; a
   betrayal); assert the NPC's hidden edge toward the player **moves in the right direction**
   (trust/affinity up, or trust▼ + threat▲). The *same* action, same seed ⇒ same shift.
2. **The change is invisible.** Across seeded play, the opinion shift appears on **no** player
   surface — no numbers, no "opinion changed" text; sentinel-clean (extends 0001).
3. **Wins and votes are consequential.** A competition win and an eviction vote are **recorded as
   events** and **shift relationships** (e.g. being voted against raises the voter→player threat).
4. **Every event detail persists.** Round-trip the save; assert **every** event (content,
   witnesses, hidden flag, ts, kind) survives **losslessly**, and the count is **monotonic** (no
   thinning) across saves (0007).
5. **Recall after leaving / restart.** Persist, drop the in-memory game, reload from the store;
   assert the event history **and** the hidden relationship/soul state are restored as a
   **superset** — the NPC's opinion equals what it was before leaving.
6. **Memory drives behavior.** After a hidden shift, an NPC's later behavior reflects it — who
   approaches the player (`conversation.ts`) and nominations (`season.ts`) track the updated
   opinion. The consequence is **observable in-game** without ever exposing the ledger.
7. **The whole loop, end to end.** A multi-step game: several actions → recorded → applied →
   persisted → reloaded → the house behaves consistently with everything that happened.

## 10. Definition of Done (MVP-1-critical)

- [ ] In the **live** game, a player action updates the hidden relationship/soul layer (no longer
      a no-op log) — `recordInteraction` (and wins/votes) feed the opinion model.
- [ ] The change is **provably invisible** to the player (sentinel-clean; no numbers surface).
- [ ] **All event details + derived hidden state persist to long-term memory** (the real store),
      lossless + monotonic (0007), surviving a restart.
- [ ] Recall restores a **superset** — the house remembers; nothing thins.
- [ ] An NPC's later behavior demonstrably reflects an earlier hidden change.
- [ ] All `0023` scenarios green; existing gates stay green.

## 11. Dependencies

**0002** (events + visibility — the record), **0017** (the relationship model — the apply/math),
**0007** (persistence/non-degradation — the long-term store, reused), **0001** (Vault Wall — the
change stays hidden), **0021** (per-user sandbox — each user's memory is their own), **0011/0014**
(wins/votes the loop consumes), **0020** (the player infers, never sees the ledger). This feature
**wires them into the live game** and tests the result end-to-end.

## 12. Traceability

`CLAUDE.md` non-degradation mandate ("persisted detail must never be lost… accumulate and deepen")
and the event/visibility model; `docs/features/0002`, `0007`, `0017`; the live `GameSessionAdapter`
/ `EngineCommandsAdapter` (where the wiring lands); this session's diagnosis that the loop is the
MVP-1 backbone and not yet wired.
