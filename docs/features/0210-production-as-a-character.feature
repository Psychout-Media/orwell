# spec-only: 0210 (Theme C, ORW-666) - the foundation (src/engine/production.ts) is built and unit-tested; the slices wire these scenarios (A and B).
# Feature 0210 - production as a character (Ryne approved all three slices 2026-11-18). Design: 0210-production-as-a-character.md. Roles only.

Feature: Production as a character

  # C1 is wired in 0210-host-on-eviction-night.feature (ORW-667).

  # C2
  Scenario: A Diary Room call is visible, its content is not
    Given a houseguest is called to the Diary Room
    Then houseguests in earshot know they were called, whether they were gone long, and how they looked coming back
    And what was said stays hidden until the retrospective
    And when the player is called, the house sees the player go the same way

  # C3
  Scenario: The producer pushes back on the player's own record
    Given the player told a houseguest they were safe and then nominated them
    When the player is in the Diary Room
    Then the producer may ask the player to walk them through it
    And the producer never raises anything the player did not say or do, nor any houseguest's secret
