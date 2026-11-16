# Feature 0154 - caught in a lie, and lying about your vote (theme 2, slice 5; ORW-330).
# Design note: 0154-caught-in-a-lie.md. Plan: the vault note "Theme 2 Slice Plan", slice 5. Builds on 0149 (claims), 0150 (beliefs drive decisions), 0153 (NPCs spread and lie).
# When what someone SAID clashes with what the board then shows, the listener now believes they were lied to: the claim they were told is refuted, the speaker's word counts for
# less with that listener, and a lie that cost them can turn into a goal against the liar. Telling someone how you voted becomes a real move (true or not), and the ballots stay
# secret: a check reads the PUBLIC count only, never a ballot. Everything is engine rules on seeded side streams; the narrator is handed nothing new (no built-in tells, Q3).
# Roles only.

Feature: Caught in a lie, and lying about your vote

  Scenario: A vote claim the public count makes impossible is caught
    Given a started season with claims on
    And an NPC told a houseguest "I voted to keep you"
    And the public vote count makes that impossible
    Then the houseguest believes the NPC lied to them
    And the claim the houseguest was told is refuted
    And the NPC's word counts for less with that houseguest from then on

  Scenario: A nomination after "you're safe" is caught
    Given an NPC assured a houseguest they were safe
    When the NPC nominates that houseguest
    Then the houseguest believes the NPC lied to them

  Scenario: Two claims from one speaker that cannot both be true are caught
    Given an NPC told one houseguest that a second houseguest has a final two with a third
    And told the same houseguest that the second is going after the third
    Then that houseguest believes the NPC lied to them

  Scenario: A claim the board cannot settle is never caught
    Given an NPC told a houseguest "I voted to keep you"
    And the public vote count is consistent with it
    Then nothing is refuted and no one believes they were lied to

  Scenario: A caught lie that cost them can turn into revenge
    Given a houseguest has caught an NPC lying about something that cost them
    Then the houseguest can take up a goal against that NPC, with the caught lie as its reason

  Scenario: NPCs say how they voted, true or not, and the count catches only what it can
    When an eviction is over and houseguests tell each other how they voted
    Then some of what is told is true and some is a lie, decided by the engine
    And a lie the public count rules out is caught, and one it does not is believed

  Scenario: Vote claims never reveal a secret ballot
    When houseguests claim how they voted and lies about votes are caught
    Then no view shows any houseguest's actual ballot before the retrospective
    And the narrator is handed nothing about a caught lie it was not present for

  Scenario: The house mix and the late-game guards still pass
    When seeded seasons play with caught lies and vote claims on
    Then the week-one house mix stays within the agreed reference
    And the late-game guard stays green
