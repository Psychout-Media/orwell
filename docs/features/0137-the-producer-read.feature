# Wired into cucumber.cjs by ORW-300 (steps in features/step_definitions/producer_read.steps.ts); also gated by unit tests (see the design note). Feature 0137 - The Producer Read. Roles only.

Feature: The Producer Read

  Retrospective scenarios describing the shipped behavior.

  Scenario: The player learned and the NPC did not
    Given a recorded scene that added a fact to the player's knowledge and disclosed nothing
    When the next moment prompt is built
    Then it carries a second-person exchange beat favoring the player

  Scenario: The beat is read-and-cleared
    Given an exchange beat already delivered
    When the following moment prompt is built
    Then the beat is not repeated

  Scenario: Flag off is byte-identical
    Given the producer read is disabled
    When a scene is recorded
    Then the moment prompt is unchanged
