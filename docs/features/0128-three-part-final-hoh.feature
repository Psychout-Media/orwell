# Executable spec - IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Built 2026-11-04 behind ORWELL_FINAL_HOH_THREE_PART; now default ON, #2066.)
# Feature 0128 — Three-part Final HOH: the real BB finale competition. Expands 0045. Default-off flag
# (ORWELL_FINAL_HOH_THREE_PART), calibration-safe. HARD rule: roles only (finalist, part-winner, Final HOH,
# evictee, juror). BUILT 2026-11-04 (spec authored 2026-07-13 during the 0045 PO review); wired in cucumber.cjs.

Feature: Three-part Final HOH (the real Big Brother finale competition)

  When the flag is on, Final 3 crowns the Final HOH with a three-part tournament instead of a single
  competition: an endurance part with all three, a physical-and-mental part between the two who lost it, and
  a final quiz between the two part-winners. The Final HOH wins two parts; the finalist who loses both early
  parts is out of the HOH race. The engine decides every part from hidden aptitudes; the Final HOH still
  personally evicts one of the other two (0045, unchanged). With the flag off, the single-comp path is
  byte-identical.

  Scenario: The Final HOH is decided by three parts
    Given three finalists and the three-part Final HOH enabled
    When the endgame advances through the Final HOH competition
    Then part one is an endurance competition among all three finalists
    And part two is a physical-and-mental competition between the two who lost part one
    And part three is a quiz between the part-one winner and the part-two winner
    And the winner of part three is the Final HOH

  Scenario: The part-one winner skips straight to part three
    Given a finalist who wins part one
    When part two is played
    Then that finalist does not compete in part two
    And they advance directly to part three

  Scenario: Win two parts to win; lose two and you are out of the race
    Given the three-part Final HOH has been played
    Then the Final HOH won part three and one earlier part
    And the finalist who lost both part one and part two never competed in part three

  Scenario: The Final HOH still personally chooses the eviction
    Given a Final HOH decided by the three-part competition
    When it is time for the Final HOH to evict
    Then the Final HOH personally evicts one of the other two
    And the finalist who lost both early parts is not evicted automatically

  Scenario: The player competes in each eligible part
    Given the player is a finalist with the three-part Final HOH enabled
    When each part they are eligible for is played
    Then the player commits an approach before that part resolves
    And if the player wins part one they rest through part two

  Scenario: The engine decides every part, and it persists
    Given an NPC-only Final 3 with the three-part Final HOH enabled
    Then each part's advancement and win is decided by the engine from hidden signals, not narration
    And no score or number is shown for any part
    And the same seed reproduces the same three-part outcome, surviving an engine restart

  Scenario: With the flag off the endgame is the single-competition path (the 0045 baseline)
    Given three finalists and the three-part Final HOH disabled
    When the endgame advances with the three-part flag off
    Then the Final HOH is decided by a single competition exactly as feature 0045
    And the seeded single-competition endgame is deterministic and emits no part events
