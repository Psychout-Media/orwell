# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0045 — Endgame structure (Final 5 → Final 2). HARD rule: roles only (HOH, nominee, veto holder,
# evictee, finalist, juror). Add to cucumber.cjs when green.

Feature: Endgame structure (Final 5 → Final 2)

  The late game is legal and modeled: the veto field shrinks with the house, Final 4 has a single eviction
  vote, Final 3 drops nominations and veto for a final-HOH competition whose winner personally evicts one of
  the other two, and the player as final HOH (or sole F4 voter) gets a binding choice. The engine decides
  every NPC outcome from hidden signals; eligibility never breaks and no number crosses the wall.

  Scenario: A seeded season reaches Final 2 with every late ceremony legal
    Given a started game advanced into the endgame
    When the loop runs from Final 5 down to Final 2
    Then every late-week competition, ceremony, and eviction is legal under the eligibility rules
    And no eviction ever resolves from an empty electorate

  Scenario: The veto field shrinks with the house
    Given a veto competition at Final 5
    Then the veto field is the eligible houseguests, not a forced six
    And the structural veto invariants still hold

  Scenario: Final 4 has a single eviction vote
    Given a Final 4 eviction
    Then only the one houseguest who is neither HOH nor a nominee casts an eviction vote
    And there is no tie to break

  Scenario: Final 3 is a final-HOH competition and a personal eviction
    Given three houseguests remain
    When the endgame advances
    Then nominations and the veto are skipped
    And a final Head of Household is decided by competition
    And the final HOH evicts one of the other two, sending the third to Final 2

  Scenario: The player as final HOH makes the binding eviction
    Given the player is the final Head of Household at Final 3
    When it is time to evict
    Then the loop stops and offers the player the two evictable houseguests
    And an illegal choice is refused
    And the player's chosen houseguest is evicted and joins the jury

  Scenario: An NPC final HOH evicts relationship-driven, and it persists
    Given an NPC is the final Head of Household at Final 3
    Then the engine decides the eviction from its hidden relationship signals, not narration
    And the eviction manner is recorded for the jury
    And the same seed reproduces the same endgame, surviving an engine restart
