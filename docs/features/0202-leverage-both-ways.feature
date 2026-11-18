# Feature 0202 - leverage both ways, sneaky as well as blunt (ORW-645; Ryne approved 2026-11-17). Design note: 0202-leverage-both-ways.md. Flag ORWELL_LEVERAGE_PLAYS (default ON). Roles only.

Feature: Leverage both ways, sneaky as well as blunt

  Scenario: Houseguests lean on each other and on the player, in two registers, and most days nobody does
    Given a leverage-play season where every houseguest holds a fact about the others
    When the leverage days pass
    Then some houseguests lean on the player and some lean on each other
    And both a blunt demand and a sneaky play appear
    And the plays are far fewer than the days in which they could have been made

  Scenario: A play on the player is an approach the player answers or ignores, never answered for them
    Given a leverage-play season where every houseguest holds a fact about the player
    When a houseguest begins to lean on the player
    Then the narrator is handed only who is leaning and in what manner
    And nothing has been done on the player's behalf
    And an approach the player ignores for long enough closes without the player acting

  Scenario: The player can lean sneaky through the same deal lever
    Given a leverage-play season where the player has learned a fact about a houseguest
    When the player makes a deal with that houseguest pressing the fact quietly
    Then the deal forms and the engine records a sneaky play by the player
    And the engine decided whether it was noticed

  Scenario: The secret's content never reaches the narrator, the player or the admin through a play
    Given a leverage-play season where every houseguest holds a fact about the others
    When the leverage days pass
    Then no recorded play and no fact for the narrator carries the planted content
