# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Expands 0042/0126.)
# Feature 0127 — Mixed-type competitions: a HYBRID comp blends a secondary aptitude into its outcome
# (a physical challenge with a puzzle element), so a well-rounded houseguest edges a one-dimensional
# one. Opt-in (default-off); the primary stat still dominates and the base draw stays byte-identical.
# HARD rule: roles only (player, houseguest, favorite, all-rounder). Add to cucumber.cjs when green.

Feature: Mixed-type competitions

  Some competitions are genuine hybrids — a physical challenge with a puzzle element, a social read that
  also rewards a sharp memory. A hybrid competition blends its primary stat with a secondary aptitude, so
  a well-rounded houseguest edges a one-dimensional one. The primary stat still dominates, the engine
  still decides on stats, and with hybrid resolution off the seeded game is byte-identical.

  Scenario: A hybrid competition rewards the well-rounded houseguest
    Given two houseguests equally strong in a competition's primary aptitude
    And one of them is also strong in the competition's secondary aptitude
    When the hybrid competition is resolved many times
    Then the well-rounded houseguest wins more often than the one-dimensional one

  Scenario: The primary aptitude still dominates a hybrid competition
    Given a houseguest who is a monster in the primary aptitude but weak in the secondary
    And a rival who is the reverse
    When the hybrid competition is resolved many times
    Then the primary-aptitude houseguest still wins a strong majority

  # (The OFF path is the pure stat model by construction; the real ON-vs-OFF contrast is the scenario below, and
  #  tests/unit/mixedCompetitionLive.test.ts. The former OFF-vs-OFF "byte-identical" scenario compared a run to a replay of itself.)

  Scenario: Turning hybrid resolution on changes seeded outcomes
    Given a set of seeds played once with hybrid resolution on and once off
    When each pair of games is played to completion
    Then at least one season's eviction order diverges between on and off

  Scenario: Hybrid resolution never leaks a stat or score
    Given a resolved competition under hybrid resolution
    When the competition result is read on a player surface
    Then the hybrid result contains no stat, score, ranking, or Vault sentinel
