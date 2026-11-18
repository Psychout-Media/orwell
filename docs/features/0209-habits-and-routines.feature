# spec-only: 0209 (ORW-651) - the foundation (src/engine/routines.ts) is built and unit-tested; the build wires these scenarios (A or B).
# Feature 0209 - habits and routines from the backstory (Ryne approved 2026-11-17). Design: 0209-habits-and-routines.md. Roles only.

Feature: Habits and routines

  Scenario: Routines come from who the houseguest is
    Given a cast whose backstories were written
    Then each houseguest has two to four routines, each a time, a place and something they do, drawn from their own backstory
    And no two casts share a fixed menu of habits

  Scenario: A routine decides where someone usually is
    Given a houseguest with a strong evening routine in the backyard
    Then across days they are in the backyard most evenings, doing it
    And when they are on the block or low, they keep it less often

  Scenario: Mornings come from habits
    Given a houseguest with a strong morning routine and one without
    Then the first is up and about before the wake-up call and the other is not

  Scenario: Routines can be learned and used, both ways
    Given the player has seen a houseguest keep a routine on three separate days
    Then the player can find them there at that time, and the narrator can say they usually are
    And a houseguest who has seen the player in the same place on three separate days can seek the player out there
    And the player's own routine is never assigned, only noticed
