# Feature 0152 - "who told you that?" (theme 2, slice 4b).
# Design note: 0151-what-you-hear.md (covers both halves of slice 4). Plan: the vault note "Theme 2 Slice Plan", slice 4. Builds on 0149 (the claims core).
# When the player is in the room, a houseguest who trusts them can pass on something they BELIEVE (a belief the engine holds for them, mistakes included),
# hedged by how sure they are. The engine decides whether, what and how sure; the narrator only voices it. The player can then ask "who told you that?":
# the engine decides whether the houseguest names their source or protects it, and the answer is the houseguest's BELIEF (their recorded source), which can be wrong.
# The Vault Wall: only a claim the player heard, as its listener, reaches the narrator, as the speaker's words - never whether it is true, never the speaker's reason.
# Roles only.

Feature: Who told you that? - a houseguest names their source or protects it

  Background:
    Given a started season with who-told-you on

  Scenario: "Who told you that?" - the houseguest names their source or protects it
    Given an NPC told the player a claim they heard from a second NPC
    When the player asks who told them
    Then the engine decides whether the NPC names the second NPC or protects them
    And the same inputs always give the same answer
    And a houseguest fond of the source and unsure of the player protects them more often than one who dislikes the source

  Scenario: The answer is the houseguest's belief, which can be wrong
    Given an NPC's recorded source for a claim is not who actually started it
    When the player asks who told them
    Then the NPC names the source they recorded, and the narrator is not told it is mistaken

  Scenario: A source the houseguest saw for themselves is not a person
    Given an NPC tells the player something they witnessed themselves
    When the player asks who told them
    Then the NPC says they saw it, and names no one

  Scenario: Asking changes nothing the player is not told
    Given the player asks who told an NPC something and the NPC names a source
    Then the player now knows that source told the NPC, as something the NPC said
    And no houseguest's belief about the player's own claims changes because of the asking
