# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0038 — Live off-screen society. Tests use a FAKE clock (no real timers). Roles only.
#
# STATUS: BUILT + BDD-gated (B27a varied society · 0041 live souls · B27b gossip→player diffusion with the
# pathway-aware 0031 leak heuristic). All six scenarios run in cucumber.cjs.

Feature: Live off-screen society

  Between the player's turns the house lives a varied hidden life: NPCs scheme, bond, and clash in more
  than one way; information travels NPC-to-NPC and drifts; off-screen scenes deepen the souls; and a
  distorted rumor can reach the player through an in-game pathway — never as a number. It is bounded,
  seed-deterministic, Vault-walled, and isolated per user.

  Scenario: The house lives in more than one way between turns
    Given a started game the player has left idle
    When the off-screen simulation runs several ticks
    Then more than one kind of NPC-to-NPC interaction occurs off-screen
    And none of it is witnessed by the player

  Scenario: Information travels NPC-to-NPC and drifts
    Given a hidden fact known to one houseguest
    When the off-screen society runs
    Then the fact diffuses to other houseguests along the social graph
    And it carries a source and a confidence that decays with distance
    And its content may drift from the original with each retelling

  Scenario: A distorted rumor can reach the player by pathway
    Given the off-screen society has diffused a fact toward the player
    When a diffusion pathway terminates at the player
    Then the player's knowledge gains the belief with its source and confidence
    But the player is shown no opinion number or hidden state

  # Recall gap (accepted, PAT-5 #1982): off-screen moments are held in the soul and survive save/resume (asserted below), but
  # SoulProvider.recall/soulOf have no production caller, so the live game never READS a past off-screen moment back. This scenario
  # therefore asserts retention, not recall; the soul-recall mechanism itself is proven by tests/unit/soul.test.ts.
  Scenario: Off-screen scenes deepen the souls
    Given a started game the player has left idle
    When the off-screen society runs several ticks
    Then each houseguest's soul accumulates the off-screen scenes it lived
    And a specific past off-screen moment is still held in the soul after the game is saved and resumed
    And no previously recorded soul detail is lost

  Scenario: The off-screen society is bounded and deterministic
    Given two games started from the same seed and left idle
    When the same number of off-screen ticks is applied to each
    Then their resulting societies are identical
    And a single committed turn fires at most one off-screen tick

  Scenario: The off-screen society is Vault-free and isolated
    Given two users each have their own idle game whose Vault holds hidden scheming
    When the off-screen society runs across both
    Then no player surface reveals a hidden scene or an opinion number
    And no off-screen activity carries one user's content into the other's game
