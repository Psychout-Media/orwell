# Wired into cucumber.cjs by ORW-300 (steps in features/step_definitions/player_dossier.steps.ts); also gated by unit tests (see the design note). Feature 0138 - The Player Dossier. Roles only.

Feature: The Player Dossier

  Retrospective scenarios describing the shipped behavior.

  Scenario: The dossier groups the player's own reads per houseguest
    Given the player recorded Diary-Room reads on two houseguests
    When the dossier is read
    Then the reads are grouped per houseguest in the player's own words

  Scenario: A subject focus narrows the dossier
    Given reads on several houseguests
    When the dossier is read for one subject
    Then only that houseguest's reads are returned

  Scenario: The dossier holds no engine truth
    Given a dossier read on any houseguest
    When the result is inspected
    Then it contains no hidden state or relationship values
