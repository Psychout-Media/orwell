# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Expands 0042; completes 0125.)
# Feature 0126 — Expanded competition mechanics: 30 mechanics (15 HOH + 15 veto) drawn as a rolling
# shuffle so a season runs with no repeated MECHANIC. Opt-in (default-off); the ENGINE still decides
# the winner and the base draw stays byte-identical when off.
# HARD rule: roles only (player, houseguest, favorite). Add to cucumber.cjs when green.

Feature: Expanded competition mechanics

  The competition pool grows from 12 to 30 distinct mechanics, and when the expanded pool is on the
  weekly draw is a rolling shuffle, so a whole season runs with no repeated competition mechanic — real
  gameplay variety, not just reskins. The new mechanics preserve the pool's stat balance, the engine
  still decides the winner from stats, and with the pool off the seeded game is byte-identical.

  Scenario: A season drawn from the expanded pool has no repeated mechanic
    Given a started game played across a full season with the expanded mechanic pool on
    When each week's competition mechanic is drawn
    Then nearly every head-of-household and veto mechanic across the season is distinct
    And the new expanded mechanics are actually used

  Scenario: With the expanded pool off the season is the bare base library
    Given one seed played once with the expanded pool off and once with it on
    When both expanded-pool games are played to completion
    Then no expanded-only mechanic is drawn with the pool off
    And the same seed with the pool on does draw expanded-only mechanics

  Scenario: The expanded pool preserves the competition stat balance
    Given the full expanded mechanic pool
    Then each phase stays mental-dominant with physical second and social a minority
    And every mechanic's governing stat matches the resolution map for its type

  Scenario: The engine still decides the winner over the expanded pool
    Given a resolved competition drawn from the expanded pool
    When the expanded-pool result is read on a player surface
    Then the expanded-pool result contains no stat, score, ranking, or Vault sentinel

  Scenario: The expanded draw is seed-deterministic
    Given two games started from the same seed played with the expanded pool on
    When each expanded-pool game on the same seed is played to completion
    Then the same competition mechanics are drawn in both
