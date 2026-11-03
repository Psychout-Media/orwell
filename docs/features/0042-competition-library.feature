# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0042 — Competition library: a seeded, curated set of competition definitions (name, governing
# stat, format, Vault-free narrative scaffold) drawn deterministically; the ENGINE still decides the winner.
# HARD rule: roles only (player, houseguest, favorite). (Wired into cucumber.cjs.)

Feature: Competition library

  Competitions are drawn from a seeded, curated library — each with a name, a governing aptitude, a format,
  and a Vault-free narrative scaffold. A season shows real variety, the right aptitude governs each comp, and
  the narrator dresses a specific competition — but the engine still decides the winner from stats and
  temperature, and no stat or score ever crosses the wall.

  Scenario: A season draws a variety of distinct competitions
    Given a started game played across several weeks
    When each week's competition is drawn from the library
    Then more than one distinct competition is used over the season
    And the same competition is not drawn twice in immediate succession

  Scenario: The drawn competition's governing aptitude favors the right houseguest
    Given a competition whose library definition is governed by one aptitude
    When it is resolved over the house many times
    Then the houseguest strongest in that aptitude wins a clear majority

  Scenario: The engine still decides the winner
    Given a clear favorite in a drawn competition
    When it is resolved many times under bounded temperature
    Then the favorite wins a strong majority but loses real upsets
    And the player is never protected from losing

  Scenario: The Vault-free result carries the competition's flavor, never stats
    Given a resolved competition
    When its result is read on a player surface
    Then it carries the competition's name and narrative format and the winner's name
    And it contains no stats, scores, rankings, or Vault sentinel value

  Scenario: Eligibility holds under any drawn competition
    Given any competition drawn for the veto
    Then exactly six houseguests play it by the eligibility rules
    And the structural eligibility invariants still hold

  Scenario: The draw and resolution are seed-deterministic
    Given two games started from the same seed
    When the same weeks are played in each
    Then the same competitions are drawn and resolved identically
