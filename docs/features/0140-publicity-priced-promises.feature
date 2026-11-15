# Wired into cucumber.cjs by ORW-300 (steps in features/step_definitions/publicity_priced_promises.steps.ts); also gated by unit tests (see the design note). Feature 0140 - Publicity-Priced Promises. Roles only.

Feature: Publicity-Priced Promises

  Retrospective scenarios describing the shipped behavior.

  Scenario: Witnesses present at formation are recorded
    Given a deal made with other houseguests present
    When the deal is committed
    Then those co-present houseguests, excluding both parties, are its formation witnesses

  Scenario: A bigger audience raises the fold only up to the cap
    Given a deal made before a large audience and the deal-witnesses flag on
    When the deal is later kept and the honored fold is applied
    Then the fold is scaled by audience size and never above the cap
    And with the deal-depth layer also on, the loyalty-streak multiplier replaces the audience scale

  Scenario: A breach reaches exactly the witnesses
    Given the deal-witnesses flag is on and a witnessed deal that is later broken
    When the breach is recorded
    Then the wronged party learns of it through the existing reveal
    And each formation witness additionally receives a collateral copy
    And the collateral copy goes to no one outside the formation witnesses
