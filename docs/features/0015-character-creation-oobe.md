# 0015 — Character creation (OOBE)

> **Status:** Built (see the [README status index](./README.md#index)). **The one human-authored profile.** First-run out-of-box experience that
> produces the *player* — the only authored houseguest — and seeds the rest of the house around
> them. Feeds `CharacterFactory` (0004) and the Character/Soul split (decision 0001).
> **Executable spec:** [`0015-character-creation-oobe.feature`](./0015-character-creation-oobe.feature)
> **Also proven by:** `tests/unit/characterCreation.test.ts`

## 1. Summary

When a new save begins, the player authors their houseguest in a first-run **OOBE** (out-of-box
experience): a player-level, **out-of-character** flow. This is the **only** human-authored
profile in the game — every NPC is generated (0004). OOBE produces the player's **static
`Character`** (identity, backstory, baseline temperament, archetype, core P/M/S aptitudes) and an
**initial dynamic `Soul`** (emotional baseline, empty memory, no relationship beliefs yet), then
hands off to `CharacterFactory` to generate the 15 NPCs **around** the player so the cast stays a
curated, balanced ensemble (0004).

The player is a houseguest like any other: **never mechanically protected** (anti-sycophancy,
mandate #3; outcomes feature 0006). Authoring the player sets who they *are*, not how the game
will *treat* them.

## 2. Scope

**In:** the OOBE input schema + validation; the player's Character/Soul split; the
anti-sycophancy bound on player competition aptitudes; the handoff that seeds the house around
the player; the OOC / player-level nature of the flow; the once-per-save / no-carryover guarantee.

**Out:** NPC generation internals (**0004**); how hidden facts about the player become *known to
NPCs* (knowledge model **0002**, Diary Room **0013**); competition resolution (**0006**); the
relationship beliefs that accrue *during* play (**0017**); the narrative voice (NarrativePort).

## 3. The flow (player-level, out-of-character)

OOBE is a **producer-style intake**, not an in-game scene: no NPC witnesses it, nothing in it is
narrated to the house. The player supplies their identity, backstory, public persona, and a
private strategic lean. Required fields are **validated** (a profile can't be half-authored);
optional fields deepen the Soul. The result is a complete, internally consistent player profile.

The player's authored **private** material (their secret strategy, who they *plan* to target) is
**player knowledge tagged `NO_NPC_PATHWAY`** (Diary Room rule, 0013): the player knows it, the
engine's player-strategy read may consume it, and **no NPC starts the game knowing it** — NPCs
learn the player only through witnessed events and gossip (0002).

## 4. Character / Soul for the player (mirrors decision 0001)

- **Static `Character`** — identity, backstory, archetype, **baseline temperament**, the
  **core P/M/S aptitudes** (Physical / Mental / Social — no Luck), and the player's **public
  appearance/identity** (appearance, presentation/style) — the authored counterpart to the NPC
  appearance fields (0004 §8) that feeds the player's **portrait** (0020). Byte-stable for the save
  (non-degradation, 0007): who the player *is* doesn't drift.
- **Initial `Soul`** — emotional baseline + **volatility** (the emotional-modifier seed, decision
  0001), an empty memory, and **no relationship beliefs** yet (those compute from play, 0017).
  The Soul deepens over the game (0007).

## 5. Anti-sycophancy bound on aptitudes (the one real fork — see §9)

The mandate is explicit: the engine **never protects the player**. So OOBE must not let the
player **min-max themselves** into a guaranteed winner. **Default (this draft):** the player
authors persona and identity freely, but their core **P/M/S aptitudes are balanced within the
same bounds `CharacterFactory` uses for NPCs** — derived from the player's authored choices
(archetype, background), not free-allocated. The player can be strong somewhere and weak
elsewhere, like any contestant; they cannot be maxed everywhere. The alternative (a capped
point-buy) is the open decision in §9.

## 6. Seeding the house around the player (handoff to 0004)

OOBE hands the authored player to `CharacterFactory.generateHouse(seed)`, which generates the 15
NPCs **as an ensemble that includes the player** — balancing archetypes/styles so the player
isn't dropped into a clump of near-identical types (0004 ensemble rule). Same seed + same authored
player ⇒ reproducible house; new save ⇒ fresh identities, **no carryover** (0004).

## 7. Contracts (stack-agnostic)

```
CharacterFactory:
    runPlayerOOBE(input) -> PlayerCharacter      # the ONLY human-authored profile
        # input: identity, backstory, public persona, archetype lean, private strategy (optional deepeners)
        # the name is the one required field; a blank name is rejected (everything else has a default or is authored later in the casting interview)
        # -> static Character (identity, backstory, baseline temperament, archetype, balanced P/M/S aptitudes)
        #  + initial Soul   (emotional baseline + volatility, empty memory, NO relationship beliefs)
    generateHouse(seed, player) -> { npcs: [Houseguest x15] }   # ensemble built AROUND the authored player (0004)

# The player's authored PRIVATE material is player knowledge, tagged NO_NPC_PATHWAY (0013):
#   consumable by the engine's player-strategy read; excluded from every NPC's knowledge derivation.
```

**Invariants:** exactly **one** human-authored profile (the player); all 15 NPCs generated; the
player's aptitudes fall **within the cast's balanced bounds** (no self-min-maxing past the NPC
range); OOBE is OOC (no witness set, never narrated to NPCs); runs **once per save**, no identity
carryover (0004); the player carries **no** outcome guarantee (0006).

## 8. Test strategy

- **Single author:** after OOBE, exactly one profile originates from authoring; the other 15 are
  generated (extends 0004).
- **Character/Soul split:** the player has a static `Character` and an initial `Soul` with no
  relationship beliefs; re-serializing leaves the Character byte-stable (ties 0007).
- **Validation:** the **name is required** (a blank name is rejected; ORW-286 item 5 reworded "an incomplete profile is rejected", which promised more than the engine
  checks); a complete input yields an internally consistent profile.
- **Anti-sycophancy bound:** over many authored inputs (incl. adversarial "max everything"), the
  player's P/M/S aptitudes stay within the NPC bounds; assert no input yields out-of-range stats.
- **No outcome protection:** seeded competitions show the authored player can and does lose
  (cross-checks 0006 — the player is unprotected).
- **DR wall:** the player's authored private strategy is player knowledge and reaches **no** NPC
  at game start (extends 0013).
- **OOC / no witnesses:** OOBE produces no witnessed event; nothing from it is narrated to NPCs.
- **No carryover:** two new saves ⇒ disjoint identities; same seed + same authored player ⇒
  reproducible house (extends 0004).

## 9. Open decision (flagged for confirmation — drafted to the recommended default)

**How are the player's competition aptitudes set?** Two defensible options; this draft ships
**A**, the mandate-aligned default. Confirm or switch:

- **A (recommended, drafted):** *Derived & balanced.* The player authors persona/identity; the
  engine derives P/M/S **within the NPC bounds** from those choices. Strongest anti-sycophancy
  guarantee; least "build-craft" agency. *(This is what the spec/scenarios currently assert.)*
- **B:** *Capped point-buy.* The player allocates a fixed stat budget within per-stat caps —
  more RPG agency, still bounded (no maxing everything), but invites optimization. If chosen,
  §5 + the "anti-sycophancy bound" scenario swap to "budget honored, caps enforced."

Either way the hard guarantee holds: **the player is never mechanically protected** (0006).

## 10. Definition of Done

- [ ] All scenarios pass, name-agnostic.
- [ ] Exactly one human-authored profile (player); 15 NPCs generated.
- [ ] Player splits into static `Character` + initial `Soul` (no relationship beliefs yet).
- [ ] Player aptitudes provably within NPC bounds (no self-min-maxing) per the chosen §9 option.
- [ ] The authored private strategy is player knowledge, unreachable by any NPC at start (0013).
- [ ] OOBE is OOC, runs once per save, no carryover (0004); player carries no outcome edge (0006).

## 11. Dependencies

**0004** (`CharacterFactory`, house generation, no-carryover), **decision 0001** (Character/Soul
split; emotional baseline/volatility), **0013** (the `NO_NPC_PATHWAY` tag for the player's private
material), **0007** (Character byte-stable, Soul deepens), **0006** (player unprotected),
**0017** (relationship beliefs accrue from play, not authored).

## 12. Traceability

`docs/bb-sim-spec.md` §1, §7 (the player is the only human-authored profile; OOBE);
`CLAUDE.md` characters ("Only the player's profile is human-authored (first-run OOBE)");
`docs/legacy/BB_GameBible.md` §6–§7 (player persona — **illustrative only**, never hard-coded);
`docs/decisions/0001-…` (Character/Soul, emotional modifier); mandate #3 (anti-sycophancy).
