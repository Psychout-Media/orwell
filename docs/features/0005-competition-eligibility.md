# 0005 — Competition eligibility & legality

> **Status:** Built (see the [README status index](./README.md#index)). **Build priority:** #5.
> **Executable spec:** [`0005-competition-eligibility.feature`](./0005-competition-eligibility.feature)

## 1. Summary

The hard, non-negotiable rules of the weekly loop: the **outgoing HOH cannot play** the next
HOH; the **veto winner cannot be a replacement nominee**; the **veto field is `min(6, remaining)`**
— exactly six at a full house, **degrading** to everyone left once fewer than six remain (Final 5 ⇒ 5,
Final 4 ⇒ 4; the Final-3 endgame skips the veto entirely — see **feature 0045**)
(HOH + two nominees + three by chip draw incl. a "Houseguest's Choice" chip the holder uses to
pick — the chip draw is seeded, so the player has no lever on it); at eviction
**everyone except the HOH and the two nominees votes**, and the **HOH breaks ties**. These
are pure-core rules that **temperature never overrides**. The format permits **one or two
Vault-held reserve twists/specials** per season (rare, producer's judgment, never
game-breaking); a special competition is their eligibility hook, and a twist **never** overrides
these hard rules or the Vault Wall and stays secret until it occurs (decision 0001 §4; Vault
Wall #0001).

## 2. Scope

**In:** the eligibility predicates and selectable-set computations; the six-player veto draw
(seeded, incl. the "Houseguest's Choice" chip and its holder's selection); the eviction voter
set and HOH tie-break; the rare explicit special-competition exception (the eligibility hook
for a reserve twist); the invariance of these rules under any temperature roll, and over any
deployed twist.

**Out:** *who* the HOH actually nominates or how houseguests vote (strategy/behavior — #3,
souls); the *outcome* of competitions (→ #6).

## 3. Contracts (stack-agnostic, pure domain core)

```
eligibleForHOH(week) -> Set<Houseguest>            # excludes the outgoing HOH (unless a special comp permits)
vetoParticipants(week, rng) -> Set<Houseguest>     # { HOH, nominee1, nominee2 } ∪ 3 from the chip draw; size == 6
                                                   #   one chip may be "Houseguest's Choice": its holder selects
                                                   #   (NPCs pick their strongest bond per the relationship model,
                                                   #   decision 0002); the player can't influence which are drawn
selectableReplacements(week) -> Set<Houseguest>    # excludes current nominees AND the veto winner
evictionVoters(week) -> Set<Houseguest>            # all except HOH and the two nominees
breaksTie(week) -> Houseguest                      # the HOH
```

## 4. Test strategy

- **Pure unit tests**, no I/O. Assert each predicate directly over constructed week states
  (roles only).
- **Seeded draw:** the three drawn veto players come from the eligible pool; over many seeds
  the draw always yields a six-player field including HOH + both nominees. When a "Houseguest's
  Choice" chip is drawn, its holder selects the slot (an NPC holder picks their strongest bond
  per the relationship model, decision 0002); the player still cannot influence which come out.
- **Invariance:** fuzz the temperature roll and assert eligibility outputs are unchanged.
- **Special-comp exception:** only when explicitly flagged is the outgoing HOH re-included.

## 5. Definition of Done

- [ ] All scenarios pass, name-agnostic.
- [ ] Outgoing-HOH and veto-winner-replacement exclusions enforced.
- [ ] Veto field is provably six (HOH + 2 nominees + 3 seeded-random), player has no draw agency.
- [ ] Eviction voter set + HOH tie-break correct.
- [ ] Hard rules proven invariant under temperature; draw reproducible by seed.

## 6. Dependencies

Pure domain core + seedable `RandomnessSource`. Foundational for #6 (outcomes consume the
eligible/participant sets) and the loop overall.

## 7. Traceability

`bb-sim-spec.md` §3, §12 (Competition legality); `docs/legacy/BB_GameBible.md` §4–§5
(veto of six, voting set, outgoing-HOH rule, special-comp exception);
`CLAUDE_CODE_INSTRUCTIONS.md` §14 (operating rules).
