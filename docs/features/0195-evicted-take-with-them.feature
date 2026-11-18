# Feature 0195 - what the evicted take with them (ORW-628; Ryne OK'd 2026-11-17). Design note: 0195-evicted-take-with-them.md. Flag ORWELL_EVICTED_TAKE (default ON). Roles only.

Feature: What the evicted take with them

  Scenario: An evictee's deals leave with them, and their partners react
    Given a played season with the evicted taking what they held
    And an NPC holds a final two with a partner who secretly planned to break it
    And the same NPC holds a safety deal with another partner
    When the NPC is evicted
    Then both deals lapse, neither kept nor broken
    And the partner who planned to break it is relieved
    And the partner it shielded worries

  Scenario: A favor the player owes passes to the evictee's closest ally
    Given a played season with the evicted taking what they held
    And the player owes an NPC a favor, and the NPC has a close ally in the house
    When the NPC is evicted
    Then the ally now holds the favor the player owes, and can call it in

  Scenario: The player evicted: what they held is never handed on for them
    Given a played season with the evicted taking what they held
    And an NPC owes the player a favor
    And the player holds a final two with an NPC
    When the player is evicted
    Then the favor owed to the player lapses and is not passed on
    And the player's final two lapses
    And the NPC who owed the player is relieved

  Scenario: Once per evictee
    Given a played season with the evicted taking what they held
    And an NPC holds a final two with a partner who secretly planned to break it
    When the NPC is evicted
    And the house settles the eviction again
    Then nothing more changes
