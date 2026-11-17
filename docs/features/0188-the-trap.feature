# Feature 0188 - the trap and the overheard plant (ORW-619, ORW-627; Ryne approved 2026-11-17). Design note: 0188-the-trap.md. Flag ORWELL_TRAPS (default ON). Roles only.

Feature: The trap

  Scenario: A suspicious houseguest who doubts someone's discretion traps them with a made-up secret told to them alone
    Given a played season with traps on
    And a suspicious houseguest who doubts a houseguest's discretion
    When the days pass
    Then the suspicious houseguest tells that houseguest, and no one else, a made-up secret

  Scenario: The secret comes back through someone else, so the setter knows who leaked
    Given a played season with traps on
    And a trap set on a houseguest
    When the secret reaches the setter from someone other than that houseguest
    Then the setter trusts that houseguest less and holds that they talk

  Scenario: The secret never comes back, so the suspect passed
    Given a played season with traps on
    And a trap set on a houseguest
    When the watch runs out with nothing coming back
    Then the setter trusts that houseguest a little more

  Scenario: A houseguest can trap the player, who hears it as an ordinary confidence
    Given a played season with traps on
    And a suspicious houseguest who doubts the player's discretion
    When the days pass and the setter is next with the player
    Then the player is told a made-up secret, with nothing marking it as a test
    And if it reaches the setter through someone else, the setter trusts the player less

  Scenario: A story planted in a room can be overheard, and the player in the room can overhear it
    Given a played season with traps on
    And a houseguest planting a story with another, in a room with others and the player
    Then someone in the room overhears it and holds that the planter talks behind the target's back
    And the player in the room may hear the words, never whether they are true

  Scenario: No trap ever reaches a player or admin view
    Given a played season with traps on
    And a trap set on a houseguest
    Then no player or admin view carries a trap, a canary or a suspect
