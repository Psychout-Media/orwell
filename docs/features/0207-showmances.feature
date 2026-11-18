# spec-only: 0207 (Theme A, ORW-657..661) - the foundation (src/engine/attraction.ts) is built and unit-tested; the slices wire these scenarios (A and B).
# Feature 0207 - showmances and attraction (Ryne approved all four slices 2026-11-18). Design: 0207-showmances.md. Roles only. Never assume the player's gender or orientation.

Feature: Showmances and attraction

  # A1 (ORW-658)
  Scenario: Attraction is real, private and shows only in behaviour
    Given a houseguest with chemistry toward another, within their own orientation
    When they spend days in the house together
    Then the houseguest seeks the other out more and sits near them more than chance
    And no number or label for it reaches the player

  Scenario: Someone may be drawn to the player, once the player has said their gender
    Given the player has told the game how they present
    And a houseguest whose orientation includes that, with chemistry toward the player
    Then that houseguest seeks the player out more, and what the player does about it is the player's own
    And a player who has not said is never anyone's attraction

  # A2 (ORW-659)
  Scenario: The couple is a target
    Given two houseguests the house reads as a couple, from what each reader saw or was told
    Then across seeds, an HOH outside the pair nominates one of them more often than otherwise
    And a couple that hides it (faked distance) is read as a couple only by those who caught them

  # A3 (ORW-660)
  Scenario: Heart against game
    Given a houseguest whose showmance partner and alliance pull opposite ways at a vote
    Then their vote follows whichever tie is stronger for them, and they are shaken either way

  Scenario: A breakup hurts more than a broken deal
    Given a showmance that ends in the house
    Then the bond rupture is deeper than a broken deal's, and the grudge book holds it

  # A4 (ORW-661)
  Scenario: The player is in a showmance only by their own acts
    Given a houseguest drawn to the player
    Then the engine never decides the player is in a showmance
    And when the player starts one and it is answered, the house notices, the partner expects loyalty, and rivals use it
    And a houseguest the player turns down handles it in character
