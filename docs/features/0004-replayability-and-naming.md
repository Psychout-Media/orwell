# 0004 — Replayability & naming

> **Status:** Done — **amended; amendment implemented** (see §8). **Build priority:** #4.
> **Executable spec:** [`0004-replayability-and-naming.feature`](./0004-replayability-and-naming.feature)
>
> ✅ **Amendment satisfied.** `CharacterFactory` now generates the **public appearance/identity**
> fields (appearance, approximate age, presentation/style) into the static `Character` —
> built in `src/engine/characterFactory.ts` (`generateAppearance`, seed-stable, Vault-free) —
> feeding the **Vault-free portrait descriptor** ([0020](./0020-player-experience.md) §5).
> Detail in **§8** (kept as the design record).

## 1. Summary

Every new game is a new save: a player authored at first-run OOBE plus a brand-new house of
**15 generated NPCs** (live casting: model-authored, validated names; the deterministic factory used by tests and the non-strict floor: seeded samples from the vendored real-name corpora) within plausible *Big Brother* archetype bounds, for a
cast of **16**. The cast is a **curated ensemble** — like real BB casting, `CharacterFactory`
deliberately balances archetypes, strategy styles, and backgrounds so every house has built-in
friction and variety (never a clump of near-identical types). **No identity carries over**
between games. **Only the player's profile is human-authored**; all NPC profiles are generated
and internally consistent.

## 2. Scope

**In:** `CharacterFactory` house generation (seeded); the OOBE handoff that produces the
player; cast-size and authorship invariants; **ensemble composition** (a deliberately varied,
balanced cast); name uniqueness and the no-fixed-list rule; the no-carryover guarantee across
seeds; archetype-plausibility constraints; **(amendment)** the **public appearance/identity**
fields each `Character` carries for portraits (§8, 0020).

**Out:** the *depth* and *evolution* of hidden attributes/souls over a game (exercised by #3
richness and #7 non-degradation); the narrative voice (narrative layer).

## 3. Contracts (stack-agnostic)

```
CharacterFactory:
    generateHouse(seed) -> { npcs: [Houseguest x15] }   # randomly named, archetype-bounded, internally consistent;
                                                        #   a curated ensemble — balanced archetype/style spread, no clumping
    runPlayerOOBE(input) -> PlayerCharacter             # the only human-authored profile
SoulProvider:
    characterOf(houseguest) -> Character                # STATIC baseline: archetype, core P/M/S aptitudes, identity,
                                                        #   + PUBLIC appearance/identity (appearance, age, presentation/style)
                                                        #   — the Vault-free facets the portrait descriptor reads (0020)
    soulOf(houseguest) -> Soul                          # DYNAMIC + evolving (md + vector): emotional state, memory,
                                                        #   and relationship beliefs — directed, graded, computed
                                                        #   from event history (NOT binary ally/bff flags; labels
                                                        #   are organic/emergent — see docs/decisions/0002)
```

**Invariants:** exactly 16 houseguests (1 player + 15 NPCs); display names unique within a
house and never drawn from a hard-coded/sample list (live names are model-authored and validated; the corpora feed only the deterministic factory); different seeds ⇒ disjoint identities.
Each houseguest splits into **static `Character`** (baseline: archetype, core P/M/S aptitudes,
identity) and **dynamic `Soul`** (evolving: emotional state, accumulated memory, and
**relationship beliefs** — graded and computed, not binary ally/bff flags) — see
`docs/decisions/0001-competition-stats-souls-and-veto-choice.md` and
`docs/decisions/0002-relationship-model.md`.

## 4. Test strategy

- **Seeded** generation; assert cast size, authorship origin, uniqueness, archetype bounds.
- **No-carryover:** generate two houses with different seeds and assert disjoint identities;
  generate with the same seed and assert reproducibility.
- **Name-agnostic & no-sample-content:** assert deterministic-factory names are not members of any fixed
  list, and tests reference roles only (this feature is itself a guard against name hard-coding).
- **Archetype plausibility:** assert each NPC satisfies the internal-consistency / plausible-
  archetype constraints (a schema/ruleset the factory must honor).
- **Ensemble variety:** across seeds, assert the house spans a spread of distinct archetypes /
  strategy styles and that no single type over-dominates beyond a configured balance (so casts
  don't clump).

## 5. Definition of Done

- [ ] All scenarios pass, name-agnostic.
- [ ] 16-cast, single human-authored player, 15 generated NPCs enforced.
- [ ] Names unique and provably not from any fixed/sample list.
- [ ] No identity carryover across seeds; same-seed reproducible.
- [ ] Generation is seeded via `RandomnessSource`.
- [ ] Each cast is a varied ensemble — archetype/style spread, no over-clumping.
- [ ] **(Amendment)** Each `Character` carries **public** appearance/identity fields (appearance,
      age, presentation/style); seed-stable, internally consistent, and carrying **no** aptitude or
      hidden data — they feed the Vault-free portrait descriptor (0020).

## 6. Dependencies

`CharacterFactory`, `SoulProvider`, seedable `RandomnessSource`. Feeds #3 (the generated deep
characters whose hidden elements surface) and #7 (their persisted, deepening profiles).

## 7. Traceability

`bb-sim-spec.md` §1, §7, §12 (Replayability and naming; Generation constraints);
`CLAUDE_CODE_INSTRUCTIONS.md` §5, §13 (no hard-coded persona/names); `CLAUDE.md` characters.

## 8. Amendment — public appearance fields (for 0020 portraits)

Added after 0004 shipped, so that houseguests **look like who they are**. `CharacterFactory` must
generate, per houseguest, a set of **public appearance/identity** fields as part of the static
`Character` (`character.md`):

- **appearance** (a brief public visual description), **approximate age**, **presentation/style**,
  and the public-persona vibe already implied by archetype/occupation.

These are **public, Vault-free facets**. They are explicitly **not** the P/M/S aptitudes (which
never surface, 0001) and **not** hidden attributes or `Soul` content. The engine builds the
**Vault-free portrait descriptor** (`portraitDescriptorFor`, 0020) from *only* these fields; the
front-end image-gen renders that descriptor and never sees the full `Character`.

Requirements:
- Generated **seeded** and **internally consistent** with the houseguest's archetype/persona
  (a comp-beast vs a social-butterfly read differently), within plausible-contestant bounds.
- **Seed-stable** so the same save yields the same look (ties to 0007 persistence — these fields
  are part of the byte-stable `Character` baseline).
- For the **player**, the equivalent public appearance comes from the authored OOBE profile (0015).

**Test (additions to §4):** every generated `Character` exposes the public appearance fields; they
are seed-reproducible; and they contain **no** aptitude or hidden data (a portrait descriptor built
from them is sentinel-free — cross-checks 0001/0020).
