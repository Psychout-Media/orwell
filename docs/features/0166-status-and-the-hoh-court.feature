# spec-only: Theme 3 draft scenarios, not built and not wired into the BDD gate; they wait for the owner's approval of the Theme 3 plan (the vault "Theme 3 Slice Plan").
# Feature 0166 - status, informal leaders, courting the HOH, power vacuums (Theme 3 slice 11; Theme 3 Slice Plan, owner B). SCENARIOS DRAFTED, NOT BUILT.
# Design note: 0166-status-and-the-hoh-court.md. Rests on the owner's 2026-11-16 Theme 3 ruling, Q4 and the culture leans (ORW-551: "majority bloc" skews
# leaders and lieutenants). The pecking order is HIDDEN: status is never shown as a rank, a score or a list; the player reads it from who courts whom.
# Vault Wall: status, leaders and lieutenants are Vault content until the post-season retrospective. Roles only, plain words.

Feature: The house has a hidden pecking order, courts the HOH, and scrambles when a leader falls

  Scenario: Status rises with wins, allies and respect
    Given a status season where a houseguest wins comps and keeps strong allies
    Then the house holds them higher than a houseguest with neither, across seeds

  Scenario: The house courts the HOH
    Given a status season with a new HOH
    Then houseguests seek the HOH out more than before, the ones in danger most

  Scenario: An informal leader has lieutenants
    Given a status season where one houseguest is held highest by their group
    Then that houseguest holds lieutenants who follow their lead

  Scenario: A leader's eviction leaves a vacuum
    Given a status season where the house's informal leader is evicted
    Then their lieutenants compete to lead, and their group may split

  Scenario: Status can be challenged
    Given a status season where a rising houseguest outwins the informal leader twice
    Then the house's hold on the leader weakens, and on the challenger strengthens

  Scenario: Nothing about status reaches the player as a rank or a number
    Given a status season with a leader, lieutenants and a court at the HOH room
    Then no player or admin view shows a status figure, a rank, a leader marker or a lieutenant list
    And the player may see only who spends time with whom, as they would in the house

  Scenario: The same seed gives the same order, and the mix stays balanced
    Given a status season played twice from the same seed
    Then both runs hold the same leaders and vacuums in the same order
    And courting adds no seeded roll to any other stream, and the jury reach and the gradient are no worse than before

  Scenario: The pecking order survives a save and a load whole
    Given a status season where a leader fell and a new one rose
    When the season is saved and loaded into a fresh session
    Then the loaded session holds the order and its history the saved one held, and a later save never holds less
