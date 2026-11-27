# Feature 0207 - showmances and attraction (Ryne approved all four slices 2026-11-18; the slow build is Ryne's ruling of 2026-11-20, ORW-736). Design: 0207-showmances.md. Roles only. Never assume the player's gender or orientation.
# Executable since ORW-742 (steps in features/step_definitions/showmances_*.steps.ts): every scenario plays real seasons or real writers; none sets state by hand.

Feature: Showmances and attraction

  # A1 (ORW-658)
  Scenario: Attraction is real, private and shows only in behaviour
    Given a played season in which the player has said how they present
    Then pairs with chemistry between them had romance scenes at a higher rate than pairs without
    And no number or label for attraction reaches the player

  Scenario: Someone may be drawn to the player, once the player has said their gender
    Given a played season in which the player has said how they present
    Then only houseguests whose own orientation includes the player hold chemistry toward the player
    And no houseguest started a romance scene with the player on their own
    And in a season where the player has not said, nobody holds chemistry toward the player

  # A2 (ORW-659)
  Scenario: The couple is a target
    Given a played season in which the player has said how they present
    Then an HOH outside a pair they read as a couple weighs that pair onto the block in some week of the season
    And a houseguest reads a pair as a couple only from romance they saw or were told of

  # A3 (ORW-660)
  Scenario: Heart against game
    Given a houseguest whose showmance tie and alliance tie pull opposite ways at a vote
    Then their choice follows whichever tie is stronger for them, by their own nature, and they are shaken either way

  Scenario: A breakup hurts more than a broken deal
    Given a played game where the player and a houseguest have a showmance from the player's own scenes
    When the player starts a clash with that houseguest
    Then the grudge book holds a heartbreak deeper than a broken deal's grudge, once

  # A4 (ORW-661)
  Scenario: The player is in a showmance only by their own acts
    Given a played game where a houseguest started romance scenes toward the player and the player started none
    Then the engine does not hold the player to be in a showmance
    And the player's own showmance scenes, answered by a houseguest drawn to them, make one
    And a houseguest whose orientation does not include the player does not answer in kind
    And a houseguest with no chemistry toward the player does not answer in kind either

  # ORW-736: the slow build
  Scenario: A showmance builds over days, one step at a time
    Given played seasons with showmances
    Then no pair climbs more than one step at a time
    And each step up came after the least days that step needs
    And a pair's progress rose only on a day they spent time together
    And the pace rule itself, run day by day for a pair together every day, climbs one step at a time and never before the least days

  Scenario: A public couple forms only late
    Given played seasons with showmances
    Then no pair was known house-wide in the first week
    And the pace rule itself, run day by day, makes no public couple before the late day

  Scenario: A showmance is noticed in steps, and known only late
    Given played seasons with showmances
    Then a pair is sensed before it is noticed and noticed before it is known, and none is known before the late day
    And the pace rule itself, run day by day, steps sensed, then noticed, then known, in order

  Scenario: The history of a pair is never lost
    Given played seasons with showmances
    Then every pair's recorded steps only grew, in order, each naming who had caught it
    And the pace rule itself, run day by day, only ever adds to a pair's steps

  Scenario: The player's own romance builds at the same pace
    Given a played game where the player keeps a romance going over many days
    Then the player's pair climbed under the same minimum days as any other pair
    And the player's pair did not move on a day the player spent no time with them
