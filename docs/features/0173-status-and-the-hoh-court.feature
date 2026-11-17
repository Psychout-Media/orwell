# Feature 0173 - status, informal leaders, courting the HOH, power vacuums (Theme 3 slice 11; Theme 3 Slice Plan, owner B). Design note: 0173-status-and-the-hoh-court.md.
# Rests on the owner's 2026-11-16 Theme 3 ruling, Q4 and the culture leans. Also carries ORW-577 (the wants systems read the agenda; the third-person goal actions move someone) and
# ORW-610 (the player plugged in: the protective pitch and the lobbying cover the player). The pecking order is HIDDEN: status is never shown as a rank, a score or a list; the player reads it
# from who courts whom. Vault Wall: status, leaders and lieutenants are Vault content until the post-season retrospective. Roles only, plain words. Flag ORWELL_HOH_COURT (default ON), played games only.

Feature: The house has a hidden pecking order, courts the HOH, and scrambles when a leader falls

  Scenario: Status rises with wins, allies and respect
    Given a status season where a houseguest wins comps and keeps strong allies
    Then status: the house holds them higher than a houseguest with neither, across seeds

  Scenario: The house courts the HOH
    Given a status season with a new HOH
    Then status: houseguests seek the HOH out more than before, the ones in danger most

  Scenario: An informal leader has lieutenants
    Given a status season where one houseguest is held highest by their group
    Then status: that houseguest holds lieutenants who follow their lead

  Scenario: A leader's eviction leaves a vacuum
    Given a status season where the house's informal leader is evicted
    Then status: their lieutenants compete to lead, and their group may split

  Scenario: Status can be challenged
    Given a status season where a rising houseguest outwins the informal leader twice
    Then status: the house's hold on the leader weakens, and on the challenger strengthens

  Scenario: Nothing about status reaches the player as a rank or a number
    Given a status season with a leader, lieutenants and a court at the HOH room
    Then status: no player or admin view shows a status figure, a rank, a leader marker or a lieutenant list

  Scenario: The same seed gives the same order, and the mix stays balanced
    Given a status season played twice from the same seed
    Then status: both runs hold the same leaders and vacuums in the same order
    And status: with the flag off a played game keeps no record and a headless game is byte-identical

  Scenario: The pecking order survives a save and a load whole
    Given a status season where a leader fell and a new one rose
    When status: the season is saved and loaded into a fresh session
    Then status: the loaded session holds the order and its history the saved one held, and a later save never holds less

  Scenario: The player is plugged in to the court
    Given a status season where the player is the one in danger
    Then status: the player is not pitched for automatically, and their own talk to the HOH counts as a pitch
    And status: when the player is HOH the houseguests who would lobby come to them as approaches

  Scenario: A third-person action moves the listener
    Given a status season where one houseguest campaigns against a third person to a listener
    Then status: the listener's read of the third person turns by a bounded step, and a lobby for them turns it the other way

  Scenario: The wants systems read the agenda
    Given a status season where a houseguest's agenda holds a get-them-out goal
    Then status: their campaign, their drive and their competition intent follow the goal
