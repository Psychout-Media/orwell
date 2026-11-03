# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0023 — Consequence & memory. The live loop: act -> hidden opinion shift -> persist -> recall.
# HARD rule: roles only. The opinion ledger is hidden; the player sees consequences, never numbers.

# PAT-5 (#1982): `ConsequenceEngine`/`restoreMemory` have no production caller. Every scenario here but one drives the LIVE path
# (`recordInteraction` -> `engine.relationships`/`engine.events`; registry `snapshot`/`restore`/`FileSaveStore`; `nominationStrategy`).
# The exception is tagged @standalone-module (live wins/votes are `house-event`s; see its comment).

Feature: Consequence & memory — actions change the hidden layer, persisted long-term

  In the live game, every happening is recorded, folds its hidden impact into how houseguests feel
  (invisibly to the player), and persists to long-term memory so leaving and returning never erases
  it. The player sees the consequences in later behavior, never the ledger.

  Background:
    Given a running game sandbox with a fully populated Producer's Vault

  Scenario: A player action changes a houseguest's hidden opinion
    Given an NPC's hidden read of the player
    When the player has a warm, bonding interaction with that NPC
    Then the NPC's hidden trust and affinity toward the player increase
    When the player betrays that NPC
    Then the NPC's hidden trust drops and their hidden threat read rises
    And the same actions under the same seed produce the same shifts

  Scenario: The opinion change is invisible to the player
    When the player's action shifts a houseguest's hidden opinion
    And any player-facing surface is produced
    Then no opinion number or relationship value appears
    And no message states that the houseguest's opinion changed
    And no Vault sentinel value appears

  # @standalone-module: exercises ConsequenceEngine.recordCompetitionWin/recordVoteAgainstPlayer, which have no production
  # caller; the standalone module is proven by tests/unit/consequence.test.ts. The live game's win/vote consequences are proven by
  # tests/unit/evictionConsequence.test.ts and tests/unit/ceremonyConsequence.test.ts (and the live 0034/0037 scenarios).
  @standalone-module
  Scenario: Wins and votes are recorded and consequential
    When a competition is won
    Then the win is recorded as an event
    When a houseguest votes to evict the player's ally
    Then that vote is recorded as an event
    And the responsible houseguest's hidden threat read toward the player rises

  Scenario: Every event detail persists losslessly to long-term memory
    Given a game with many recorded events
    When the game is saved and reloaded from the long-term store
    Then every event's content, witnesses, hidden flag, timestamp, and kind survive unchanged
    And the total event count after reload is at least what it was before
    And no event detail is thinned or dropped

  Scenario: The house remembers after the player leaves and returns
    Given the player wronged a houseguest several weeks ago
    When the player leaves and the game is reloaded from the long-term store
    Then the full event history is restored
    And that houseguest's hidden read of the player equals what it was before leaving
    And an alliance the player built is still intact

  Scenario: Recall survives a process restart, not just an in-memory reload
    Given a game persisted to the long-term store
    When the engine process is restarted and the game is loaded fresh
    Then the events and the hidden relationship state are restored as a superset

  Scenario: A hidden change later drives houseguest behavior
    Given the player has quietly earned a houseguest's distrust
    When houseguest behavior is resolved later
    Then that houseguest is more likely to seek the player out warily or target them
    And this happens without any opinion value ever being shown to the player

  Scenario: The whole loop holds end to end
    Given a multi-step game of conversations, a competition, and a vote
    When everything is recorded, applied, saved, and reloaded
    Then the house's later behavior is consistent with everything that happened
    And nothing the player legitimately changed was lost
