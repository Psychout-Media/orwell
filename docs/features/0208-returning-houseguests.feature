# Feature 0208 B1 - returning houseguests (ORW-663; Ryne approved 2026-11-18). Split out of 0208-seasons-that-remember.feature when slice B1 was built. Design: 0208-seasons-that-remember.md. Roles only.

Feature: Returning houseguests

  Scenario: A returning houseguest is real and remembers the player
    Given the player returns and has played seasons before
    When a returner is cast
    Then they are a real houseguest from a season this player played
    And nothing the earlier season kept hidden comes back with them
    And they start with the feelings they ended that season with, softened by time but never gone
    And they hold their own account of the player, to be told only through the house's usual pathways

  Scenario: A returner can never be invented
    Given a player who has finished one season
    When someone is proposed to return who is not in that player's own archive
    Then the proposal is rejected and the cast member is a fresh one
    And a player who has never finished a season is never given a returner
