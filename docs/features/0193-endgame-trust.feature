# Feature 0193 - the endgame changes the rules of trust (ORW-623; Ryne OK'd 2026-11-17). Design note: 0193-endgame-trust.md. Flag ORWELL_ENDGAME_TRUST (default ON). Roles only.

Feature: The endgame changes the rules of trust

  Scenario: At the final four a houseguest pushes out the one they can't beat in front of the jury
    Given a played season at the final four with the endgame on
    And the jury is close to one houseguest
    Then another houseguest reads that one as someone they can't beat, by their own read of the jury
    And that houseguest reads them as someone they can beat in turn

  Scenario: The player's own play makes them harder to beat
    Given a played season at the final four with the endgame on
    When the player wins more competitions
    Then the houseguests read the player as harder to beat than before

  Scenario: Final twos are tested out loud, once a week
    Given a played season at the final four with the endgame on
    And two houseguests hold a final two
    And a houseguest holds a final two with the player
    When the endgame week begins
    Then each of the two houseguests is reassured by the other, for the engine to keep or break
    And the player is asked to their face whether their final two still stands, in words and never a number
    And nothing is said for the player
    And it happens once a week

  Scenario: Before the final four, or with the endgame off, nothing changes
    Given a played season at the final five with the endgame on
    Then no houseguest weighs whether they can beat anyone
