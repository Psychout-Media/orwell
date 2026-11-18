# Feature 0210 C3 - the producer who pushes back (ORW-669). Design: 0210-production-as-a-character.md. Roles only.

Feature: The producer who pushes back

  Scenario: The producer is handed the player's own contradiction in the Diary Room
    Given a played season where the player told a houseguest they were safe and then nominated them
    When the player is in the Diary Room
    Then the producer is handed both facts, in kind, to ask about
    And nothing the player typed in the Diary Room is kept or reaches any houseguest

  Scenario: A consistent player is never pushed
    Given a played season where the player kept their word to a houseguest
    When the player is in the Diary Room
    Then the producer has nothing to raise
