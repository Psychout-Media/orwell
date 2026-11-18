# Feature 0210 C1 - the host on eviction night (ORW-667). Design: 0210-production-as-a-character.md. Roles only.

Feature: The host on eviction night

  Scenario: The host runs the night from what the house saw
    Given a played season reaches an eviction night
    When the house votes and an evictee goes out the door
    Then the host's manner is the same all night and carries no number
    And the host is handed the open of the night, the public board, the reading and the count in the open
    And the host's questions are about public events and that houseguest's own choices
    And no hidden fact or ballot-caster reaches the host

  Scenario: The player's own public seat reaches the host, and the host never answers for the player
    Given a played season reaches an eviction night with the player on the block
    When the night plays out
    Then the host is told the player's own public seat
    And the game never records an exit interview for the player that the player did not give
