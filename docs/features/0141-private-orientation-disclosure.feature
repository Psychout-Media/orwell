# 0141 — a private orientation can reach the player by the houseguest's own choice (ORW-261). Wired into the BDD gate (ORW-385).
# Built: the confide-press path (`GameSessionAdapter.confide` -> `maybeShareOrientation`), played games only. The player's "ask"
# is the confide press (the engine lever); the wording of an ask never reaches the engine. Roles only: the player, a houseguest.
Feature: A private orientation can reach you by the houseguest's own choice
  The engine decides whether a houseguest tells; the narrator only voices it. Roles only.

  Background:
    Given a live, played season in which a houseguest holds a private orientation sealed in the Vault

  Scenario: A trusted player who presses can learn it, and the same seed reproduces it
    Given the player is trusted by that houseguest and they are alone together
    When the player presses that houseguest to open up across many seeds
    Then on some seeds the houseguest tells the player, and on others they do not
    And the same seed gives the same answer on a repeat

  Scenario: A houseguest who chooses to hold never tells, however often they are pressed
    Given the engine's decision for that houseguest and moment is to hold
    When the player presses them six times in that moment
    Then the player learns nothing about the private orientation
    And the narrator is handed exactly what it gets for a houseguest with nothing to disclose

  Scenario: A distrusting houseguest declines more often
    When the same press is made across many seeds at low trust and at high trust
    Then the share rate at high trust is greater than at low trust
    And below the trust bar the houseguest never tells

  Scenario: When it comes out it is a recorded, witnessed told-by fact
    Given a unique marker as the private orientation
    And a moment in which the houseguest chooses to tell
    When the player presses that houseguest to open up
    Then before the telling the marker was on no player surface and no admin surface
    And the knowledge store holds a told-by fact carrying the marker whose source is that houseguest
    And the fact is the player's own, visible in their journal

  # Scope: this scenario covers the CONFIDE path only (the per-conversation clock is off, which also switches the volunteer path off). The volunteer
  # path, which can record a told-by fact with no press, is not exercised here (review of #2690; left for Ryne on ORW-437 to decide whether it gets its own scenario).
  Scenario: Without a press the confide path puts nothing on the player or the admin surfaces
    Given a unique marker as the private orientation
    When a played season runs many beats without the player ever pressing that houseguest
    Then the marker appears on no player surface and no admin surface
    And the player holds no told-by fact carrying the marker

  Scenario: It moves no competition outcome
    When the same seeded, played season is run with the disclosure open and with it closed, the player pressing that houseguest at every beat
    Then the houseguest told the player in the open run and not in the closed run
    And every competition, nomination and eviction outcome is identical
