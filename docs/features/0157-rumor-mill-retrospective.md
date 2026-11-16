# 0157 - The rumor mill in the retrospective (theme 2, slice 8)

Card: ORW-525. Executable spec: `0157-rumor-mill-retrospective.feature`. Plan: vault note "Theme 2 Slice Plan", slice 8.

## What it is

The post-season retrospective (0048, alongside "the house you never saw") gains a **rumor mill**: the false beliefs the house held, who
started each, who believed it, and what the house got wrong about the player. It is built only from the engine-only claim log
(0149), so `biggest` covers **claim-planted beliefs only**. `aboutYou` is wider (see below): it also counts beliefs about the player that the
engine formed some other way (witnessed, deduced, gossip, campaigns), when the engine's own records (`truthOf`, 0153) say they are false.

## Definitions (deterministic, no rng)

- A *false belief* is a group of false claims with the same kind, subject and second party.
- *Believers*: the distinct NPCs those claims were told to (the player holds no belief; `toldToYou` says the player heard it).
- *Starter*: the speaker of the earliest false claim in the group (the claim log, never the capped belief store). Later tellers whose
  intent was `inform` are `passedOn` (leaks). Intent and truth are never output; every row is a lie by construction.
- *Biggest*: most believers, then most tellings, then earliest; top 5.
- *About you*: the same ranking over false beliefs whose subject is the player. A belief an NPC holds about the player (held, not refuted,
  with a claim form per `claimFromBelief`) that `truthOf` says is false joins the claim group with the same kind and second party (its
  holder becomes a believer), or forms a belief-only row: starter = the belief's recorded source, else the holder (they worked it out
  themselves); tellings = number of believers; the player's own beliefs never count. Belief-only rows are not added to `biggest`.
- Claim wording covers every kind, including "voted to evict" and "voted to keep" (0153 slice 3).

## The wall

Door: `GameSessionAdapter.seasonRetrospective()`, which returns null until the winner is crowned. It is the 0048 post-season door
(mandate #2, exception 3), not a new door. The module (`src/engine/rumorMill.ts`) is Vault-class in the dependency-cruiser denylist,
is never reached from the producer-vault dump, and only reads the log. A season with no false claim and no false belief about the player has no `rumorMill` field, so the
retrospective is byte-identical to before.

The front-end retrospective window renders it as plain text; the host model's tool result leaves it out, like "the house you never saw".
