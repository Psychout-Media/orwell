# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0039 — Promise & deal tracking. The ENGINE decides kept/broken and makes a broken promise hurt.
# HARD rule: roles only (promisor, promisee, wronged party, HOH, nominee). Add to cucumber.cjs when green.

Feature: Promise & deal tracking

  A deal between two houseguests is a first-class, tracked commitment with a condition that a later binding
  action can break. The engine — not the narrator — decides whether it was kept or broken, and a broken
  promise deterministically moves trust, threat, and the jury, recorded as a real event. The player never
  sees the numbers.

  Scenario: A deal is a first-class tracked object
    Given two houseguests make a safety deal
    Then the deal is recorded as an open commitment between them with its terms
    And it persists and survives an engine restart

  Scenario: Honoring a deal leaves it kept
    Given an open safety deal between the player and a houseguest
    When the player takes a binding action that honors it
    Then the engine marks the deal kept
    And no betrayal consequence is applied

  Scenario: Breaking a deal is engine-decided and hurts
    Given an open safety deal between the player and a houseguest
    When the player takes a binding action that violates its condition
    Then the engine marks the deal broken
    And the wronged houseguest's hidden trust drops and threat rises, and lingers
    And the break is weighed against the breaker in that juror's later lean
    But the player is shown no opinion number

  Scenario: The wronged party learns a broken promise as a witnessed event
    Given a deal the player breaks in front of the wronged houseguest
    When the deal is broken
    Then a witnessed reveal event enters the wronged houseguest's knowledge

  Scenario: NPC-to-NPC deals are Vault-held and reach the player only by rumor
    Given two houseguests make a deal off-screen that the player does not witness
    When one of them breaks it off-screen
    Then the deal and its break stay hidden from the player by default
    And the player may only learn of it as a distorted rumor along an in-game pathway
    And no Vault sentinel value appears on any player surface

  Scenario: The engine, not the narrator, adjudicates the promise
    Given an open deal
    When a binding action implicates it
    Then kept or broken is decided from the action and the deal's condition
    And it is never inferred from chat prose

  Scenario: An NPC who distrusts the player refuses a deal and no deal is recorded
    Given a houseguest who distrusts the player
    When the player proposes a safety deal to them
    Then the houseguest refuses the deal
    And no deal is recorded
    And the refusal carries no numbers
