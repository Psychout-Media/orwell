# Feature 0149 - the claims core (theme 2, slice 1; ORW-330).
# Design note: 0149-claims-core.md. Plan: the vault note "Theme 2 Slice Plan", slice 1.
# What houseguests say about each other becomes something the ENGINE decides and records (a claim): who said it, to whom, about whom,
# what it says (from a fixed set), whether it is true and what the speaker really meant by it. The narrator only words it, and only a
# claim the player hears as its listener ever reaches the narrator - as the speaker's words, never its truth or the speaker's reason.
# Roles only.

Feature: Claims are engine decisions, and a told claim becomes the listener's belief

  Scenario: A claim told to a houseguest becomes their belief, with its source
    Given a started season with claims on
    When an NPC tells a second NPC that a third NPC is targeting them
    Then the second NPC believes the third NPC is targeting them
    And the belief names the first NPC as its source
    And the belief's confidence follows how much the listener trusts the speaker

  Scenario: A false claim plants a false belief, and the engine knows it is false
    Given a started season with claims on
    When an NPC tells a second NPC something the engine knows is untrue
    Then the second NPC holds it as a belief like any other
    And the engine records the claim as a lie told by the first NPC, with what the first NPC meant by it

  Scenario: The player hears a claim only as its listener, and never its truth
    Given a started season with claims on
    When an NPC tells the player a lie about a second NPC
    Then the claims the narrator may voice hold the NPC's words to the player
    And they never say whether the claim is true or what the NPC meant by it
    And the player is handed no belief: the read is the player's own

  Scenario: Claims are secret engine state, kept whole for the season
    Given a started season with claims on
    And claims have been told between houseguests the player never heard
    Then no player-facing or admin view contains them
    And the claims the narrator may voice are empty
    And every claim survives a save and restore unchanged
