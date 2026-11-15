# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# BUILT 2026-07-05 as the REDESIGNED daily recap (#884, PO ruling 2026-06-27); the original WEEKLY design was superseded before it shipped.
# ORW-285: the scenarios below are now the DAILY ones (fired at the player's own bedtime, `turnIn`); each names the Vitest case in
# `tests/unit/dailyRecap0102.test.ts` that is its executable gate. This file stays unwired from cucumber.cjs.
Feature: 0102 - Daily recap + cliffhanger (the day in review, fired at the player's own bedtime)
  When the player turns in for the night, the game stitches a short, Vault-safe digest of the day that just
  closed - from their WITNESSED events plus gossip that has ALREADY surfaced to them - and ends it on a
  non-committal hook anchored to a thread already in motion. The recap is the record recalled, never narrator
  memory. Each scenario below points at the Vitest case that is its executable gate (this file stays unwired from cucumber.cjs).

  # Role-only (testing rule): the-player, a houseguest, the admin.

  Scenario: The recap retells the day the player actually lived
    Given the in-game clock is running and the player has witnessed events today
    When the player turns in for the night
    Then the result carries a daily recap for the day that just closed, built from witnessed highlights and already-surfaced gossip
    # tests/unit/dailyRecap0102.test.ts - "turnIn's result carries a dailyRecap for day 1 with witnessed highlights and surfaced gossip"

  Scenario: An un-surfaced rumor and the Diary Room never enter the recap
    Given one rumor has reached the player through a pathway and another is still diffusing in the hidden layer
    And the player has written a Diary Room entry
    When the daily recap is assembled
    Then only the already-surfaced rumor may appear
    And neither the hidden rumor nor the Diary Room entry appears
    # tests/unit/dailyRecap0102.test.ts - "already-surfaced gossip appears; a rumor still diffusing in the hidden layer never does" and "excludes the player's own OOC Diary Room"

  Scenario: The Vault Wall holds for the recap and its hook
    Given sealed Vault sentinels exist in the season
    When the daily recap is read on the player and admin surfaces
    Then no sentinel appears
    # tests/unit/dailyRecap0102.test.ts - "no sealed Vault sentinel ever appears in the recap, on the player or admin surface"

  Scenario: The cliffhanger teases a thread in motion and commits to no outcome
    Given a quiet day with no thread in motion
    Then the recap closes with no fabricated hook
    Given an in-motion thread
    Then the hook never asserts a future result
    # tests/unit/dailyRecap0102.test.ts - "a quiet turn with no in-motion thread closes with no fabricated hook" and "a hook, when present, never asserts a future result"

  Scenario: The recap augments play and is reproducible
    When the daily recap is materialized and then re-read
    Then week, phase and ceremony state are unchanged
    And re-reading returns the exact same digest, and the next day's recap does not repeat it
    # tests/unit/dailyRecap0102.test.ts - "progresses no game state", "re-reading dailyRecap() after turnIn reproduces the exact same materialized digest", "day advances and the next day's recap never repeats the prior day's content"
