# 0002 — Event visibility & propagation

> **Status:** Built (see the [README status index](./README.md#index)). **Build priority:** #2.
> **Executable spec:** [`0002-event-visibility-and-propagation.feature`](./0002-event-visibility-and-propagation.feature)

## 1. Summary

One interaction record; **visibility is per-event metadata** (a witness set + a hidden flag)
**derived from the witness set, never from which store the event lives in**. Player-witnessed
events are the player's knowledge and are *not* secret. Off-screen NPC-to-NPC events are
hidden. Hidden facts reach an entity **only** through a legitimate in-game pathway (told,
overheard, caught), which is itself a recorded, traceable event. Absent a pathway, the
entity may *suspect* but cannot *know*. Hidden facts also **diffuse NPC-to-NPC along the social
graph** (gossip): they flow preferentially along high-trust/affinity edges (the relationship
model, decision 0002), **drift / exaggerate with each hop**, and land as **beliefs** carrying a
*provenance* and a *confidence* — so what reaches the player can be distorted, and the player
may act on it while it is wrong.

This is the area that caused real bugs before (player-witnessed events mislabeled as
off-screen/secret), so the classification rule and its regression guard are central.

> **Live integration → 0023.** This feature is the *record + visibility* model. Wiring it into the
> **live** game so each recorded happening also **updates the hidden relationship/soul layer and
> persists** (act → consequence → memory) is feature **0023** (consequence & memory) — today the
> live `recordInteraction` only logs.

## 2. Scope

**In:** the `EventStore` witness/hidden semantics; the derived `classify()` rule; per-entity
`KnowledgeState` of **beliefs** (content + provenance + confidence); the `surfaceInformationTo`
pathway and its recorded surfacing event; **transitive gossip diffusion** along relationship
edges with **per-hop distortion**; knowledge-vs-suspicion; the player-DR-reaches-no-NPC rule.

**Out:** the *richness/volume* of off-screen life and surfacing **rates** (→ #3); the
narrative *content* of generated scenes (→ #3); Vault-Wall content guarantees (→ #1, which
this complements — #1 forbids Vault content on outward surfaces, #2 governs how facts move
between knowledge states).

## 3. Contracts (stack-agnostic)

```
EventStore:
    record(event{ initiator, witnessSet, hidden, content, ts })
    query(filter) -> [Event]
    classify(event, entity) -> VISIBLE | HIDDEN     # = (entity ∈ witnessSet) ? VISIBLE : HIDDEN
                                                    # derived; never set to contradict the witness set
KnowledgeService:
    knownTo(entity) -> KnowledgeState               # beliefs held: each { content, provenance (source chain), confidence }
    surfaceInformationTo(entity, fact, pathway)     # ANCHORED only (B39/A4): told-by:<id> requires the teller to hold/have-witnessed it, overheard:<id> requires that event to exist — else it is a SUSPICION, never knowledge (returns null)
    propagateGossip(rng)                            # NPCs may retell along relationship edges; content drifts per hop
    suspicionsOf(entity) -> [Suspicion]             # low-confidence beliefs with no direct tell/witness
```

**Invariant:** the hidden flag is a **function of** the witness set. `classify(e, player)`
for an event the player witnessed must **never** be `HIDDEN`. A surfacing only adds to an
entity's knowledge when called with a valid pathway, and it leaves a queryable event trail
(who told whom, when). **Gossip diffusion runs in the hidden layer:** the player's
`KnowledgeState` changes *only* when a pathway terminates at the player, so the Vault Wall
holds even as a fact spreads through the house. A belief is **not** ground truth — it may be a
distorted retelling.

## 4. Test strategy

- **Seeded** runs; classification asserted directly from witness sets (both player and NPC
  perspectives).
- **Propagation:** `knownTo(player)` gains a fact **only** after `surfaceInformationTo` with
  a valid pathway, and a corresponding surfacing event exists; without a pathway the fact is
  absent from `knownTo`.
- **Diffusion:** over seeded game time a fact known to one NPC reaches others via recorded
  tells along relationship edges; the player's belief appears **only** if a chain terminates
  at the player.
- **Distortion grows with hops:** assert a far-hop version can differ from the source, and
  that expected distortion increases (in distribution) with hop count.
- **Beliefs carry provenance + confidence:** each surfaced belief is queryable back to its
  source chain; second-hand beliefs may be factually wrong.
- **Knowledge ≠ suspicion:** an un-witnessed, un-told fact may appear in `suspicionsOf` but
  never in `knownTo`.
- **Regression guard:** generate player-witnessed events and assert none are ever classified
  hidden/off-screen.
- **DR isolation:** player DR content is in the player's knowledge but creates **no** NPC
  pathway.

## 5. Definition of Done

- [ ] All scenarios pass, name-agnostic.
- [ ] Visibility derivation correct for player **and** NPC perspectives.
- [ ] No player-witnessed event can be classified secret (regression guard green).
- [ ] Every surfaced fact has a traceable pathway event; un-surfaced facts are inaccessible.
- [ ] Seeded unit tests for the domain logic.

## 6. Dependencies

Builds on the minimal `EventStore` (witness set + hidden flag) and `KnowledgeState` stubbed
in #1. Gossip diffusion flows along the **relationship model** edges and weights belief
confidence by source trust (`docs/decisions/0002`). Provides the substrate #3 (behavioral
fidelity) measures and #1 relies on for the "legitimately surfaced fact is not blocked" guard.

## 7. Traceability

`bb-sim-spec.md` §6.2–6.4, §12 (Event visibility); `CLAUDE.md` event/visibility model
(incl. Diary Room); `CLAUDE_CODE_INSTRUCTIONS.md` §4, §13 (do-nots: mislabeling, prompt-Wall).

## 8. Also proven by (AMEND secrets wall, 2026-11-04)

The "an NPC knows only what it witnessed or was told" rule (and ADR 0019, `docs/decisions/0019-context-is-not-knowledge.md`) is held on the LIVE game by:
- `tests/unit/knowledgeScoping0019.test.ts` - the `npcVoice.knows` block carries only witnessed / told facts, with a told-NPC positive control;
- `tests/unit/presence.test.ts` - overhearing is presence-gated (a houseguest in another room does not overhear);
- `tests/unit/sleepersDontWitness.test.ts` - a houseguest who has turned in neither witnesses nor overhears (ADR 0006).
