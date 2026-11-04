# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Build priority #8 — Daily-event invariant.
# HARD rule: roles only.

Feature: Daily-event invariant — every in-game day earns its place

  Each in-game day contains at least one meaningful event: an HOH competition, a nomination
  or veto ceremony, a vote or eviction, or a significant house event. A "week" is one HOH
  reign — from an HOH competition to an eviction — not a fixed number of calendar days. Pacing
  is tight and ceremony-driven; a week allows at most one optional social day, and often none.

  Scenario: Each in-game day has a meaningful event
    When an in-game day completes
    Then at least one of {HOH competition, nominations, veto competition, veto ceremony, eviction, significant house event} occurred

  Scenario: A week is one HOH reign, not seven days
    Given a week begins with an HOH competition
    When the week ends
    Then it ends with an eviction
    And the number of in-game days in the week may vary

  Scenario Outline: No empty days over a seeded season
    Given a season is simulated with seed "<seed>"
    Then every completed in-game day contains at least one meaningful event

    Examples:
      | seed |
      | 1    |
      | 2    |
      | 3    |

  Scenario: A week allows at most one optional social day, and often none
    Given a season is simulated
    Then no week (one HOH reign) contains more than one social day (a day with no ceremony beat)
    And many weeks contain none
    And any social day still carries a significant house event

  Scenario: A day whose only event is the ambient daily marker fails the invariant (negative control)
    Given a day whose only recorded event is the ambient daily marker
    Then that day does not count as meaningful
    And a day with the marker plus a real public event does count
