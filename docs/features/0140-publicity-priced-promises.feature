# Executable spec - BUILT (retrospective, 2026-11-03) but NOT wired into cucumber.cjs; behavior is gated by unit tests (see the design note). Feature 0140 - Publicity-Priced Promises. Roles only.

Feature: Publicity-Priced Promises

  Retrospective scenarios describing the shipped behavior.

  Scenario: Witnesses present at formation are recorded
    Given a deal made with other houseguests present
    When the deal is committed
    Then those co-present houseguests, excluding both parties, are its formation witnesses

  Scenario: A bigger audience raises the fold only up to the cap
    Given a deal made before a large audience
    When the formation trust fold is applied
    Then it is scaled by audience size and never above the cap

  Scenario: A breach reaches exactly the witnesses
    Given a witnessed deal that is later broken
    When the breach is recorded
    Then each formation witness learns of it and nobody else does
