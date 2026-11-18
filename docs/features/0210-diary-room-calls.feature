# Feature 0210 C2 - called to the Diary Room (ORW-668). Design: 0210-production-as-a-character.md. Roles only.

Feature: Called to the Diary Room

  Scenario: Production calls a houseguest and the house sees it, never what was said
    Given a played season in a quiet stretch
    When production calls a houseguest to the Diary Room
    Then the call is a public event the room saw
    And the houseguest is out of every room while they are in the Diary Room
    And they come back, and the house records whether they were gone long and how they looked
    And the call carries no confessional content and no number

  Scenario: The player is invited and goes only by their own choice
    Given a played season in a quiet stretch
    When the player makes a Diary Room entry
    Then the house sees the player go and nothing of what they said
    And no houseguest knows the player's words
