# Feature 0151 - what the player hears (theme 2, slice 4; the "who told you that?" half is 0152).
# Design note: 0151-what-you-hear.md. Plan: the vault note "Theme 2 Slice Plan", slice 4. Builds on 0149 (the claims core).
# When the player is in the room, a houseguest who trusts them can pass on something they BELIEVE (a belief the engine holds for them, mistakes included),
# hedged by how sure they are. The engine decides whether, what and how sure; the narrator only voices it. The player can then ask "who told you that?":
# the engine decides whether the houseguest names their source or protects it, and the answer is the houseguest's BELIEF (their recorded source), which can be wrong.
# The Vault Wall: only a claim the player heard, as its listener, reaches the narrator, as the speaker's words - never whether it is true, never the speaker's reason.
# Roles only.

Feature: What a houseguest tells the player

  Scenario: A houseguest shares a belief with someone they trust, hedged by how sure they are
    Given a started season with claims on
    And an NPC believes a second NPC is targeting them, and trusts the player
    When the player and the NPC are in a scene together
    Then the engine can have the NPC tell the player so, once
    And the narrator is handed that claim to voice with the NPC's own level of certainty
    And the narrator is never told whether it is true or why the NPC is telling

  Scenario: A wrong belief is shared like any other
    Given an NPC wrongly believes a second NPC voted against them, and trusts the player
    When they are in a scene together
    Then the NPC can tell the player, and the claim is recorded as untrue
    And nothing the narrator is handed says it is untrue

  Scenario: A houseguest does not confide in someone they do not trust, or in front of a crowd
    Given an NPC holds a belief about a second NPC
    When the NPC's trust in the player is low, or many others are in earshot
    Then the NPC does not tell the player, across seeds

  Scenario: A claim the player did not hear never reaches the narrator
    Given an NPC tells a third NPC a claim while the player is elsewhere
    Then the narrator is handed nothing about it

  Scenario: The house mix and the late-game guards still pass
    When seeded seasons play with houseguests sharing beliefs with the player
    Then the week-one house mix stays within the agreed reference
    And the late-game guard stays green
