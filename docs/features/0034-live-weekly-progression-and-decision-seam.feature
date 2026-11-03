# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0034 — Live weekly progression & binding-decision seam. CODIFIES already-built engine code
# (liveSeason.ts + GameSessionAdapter.advanceGame/submitDecision), driven through the live MCP player
# channel. HARD rule: roles only (player, HOH, nominee, veto holder, evictee).

Feature: Live weekly progression & binding-decision seam

  The live game advances the weekly loop over the live house: NPC beats resolve automatically, the loop
  stops when it is the player's turn to make a binding choice, and that choice applies only through a
  validated seam. Illegal choices are refused, the live position survives a restart, outputs leak no
  hidden state, and the same seed reproduces the same progression.

  Scenario: Advancing auto-resolves NPC beats and stops for the player's binding decision
    Given a live game started for the player
    When the game is advanced to the player's first binding decision
    Then at least one beat resolved automatically before it stopped
    And the pending decision offers a legal set of options
    And advancing again does not skip the pending decision

  Scenario: A binding choice applies only through the validated seam
    Given a live game advanced to the player's first binding decision
    When the player submits a legal choice through the seam
    Then the choice is applied and the loop continues
    And the beats are recorded as player-witnessed events

  Scenario: An illegal binding choice is refused and the decision still stands
    Given a live game advanced to a nomination decision
    When the player submits an illegal nomination
    Then the seam refuses it
    And the same pending decision still stands

  Scenario: An illegal vote is refused and the decision still stands
    Given a live game advanced to an eviction-vote decision for the player
    When the player votes to evict a houseguest who is not a nominee
    Then the seam refuses it
    And the same pending decision still stands

  Scenario: The live position survives an engine restart
    Given a live game advanced several beats
    When the engine restarts and resumes from the durable save
    Then the resumed week and phase match exactly

  Scenario: The advance and status outputs are Vault-free
    Given a live game whose Vault holds hidden content
    When the game is advanced and the status is read
    Then no advance or status output carries a Vault sentinel value

  Scenario: The progression is seed-deterministic
    Given two live games started from the same seed
    When the same advances and decisions are applied to each
    Then their resulting week and phase are identical
