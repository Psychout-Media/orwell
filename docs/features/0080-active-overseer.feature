# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Design contract — BUILT and shipped DEFAULT ACTIVE (owner ruling 2026-07-13); verified by FE tests, NOT wired into cucumber.cjs. Reflects the recommended Model D (§3) + the invariants that hold
# regardless of the §10 owner rulings. (Header corrected 2026-11-12, ORW-286 item 8: it said provisional, off by default.) HARD rule: roles only (player, NPC, HOH, nominee, admin). The overseer's inputs
# and log are Vault-free BY CONSTRUCTION; seeded fixtures only; a deterministic stub / injected verdict
# stands in for the model.

Feature: Active overseer — the reasoning tier as the primary actor (guardrails as the fail-soft floor)

  When enabled in "active" mode AND a model resolves, the runtime overseer's verdict drives the
  correction inline — routed through the existing, already-tuned action paths — while the deterministic
  guardrails remain the fail-soft floor. It is reversible (an explicit `off` still disables it), live-only, and ships ACTIVE by default, and
  trigger-only: the overseer decides WHETHER/WHEN to pull a deterministic engine action, never WHAT the
  outcome is. The Vault Wall and the engine's outcome authority are untouched.

  Scenario: The mode is three-state and defaults to active
    Given a fresh install with no overseer mode configured
    Then the overseer is active (the owner ruling 2026-07-13); an explicit "off" restores the live loop exactly as before
    And an admin can set the mode to "shadow" (diagnose and log only) or "active" (the overseer acts)

  Scenario: In active mode a diagnosed stall pulls the advance through the existing path
    Given a started game in active mode with a model available
    And the loop is parked at an advance phase the model did not progress
    When the overseer is summoned and diagnoses a stall
    Then it triggers the deterministic advance through the same bounded path the L39b guardrail uses
    And it never names the resulting beat itself — only the engine's returned result is voiced
    And the executed lever is logged to the Overseer stream as an action

  Scenario: A missed social fold is repaired by the overseer's verdict
    Given a started game in active mode where an engaged player and NPC scene recorded nothing
    When the overseer diagnoses a missed fold
    Then it triggers a constrained record through the existing backfill path
    But the engine still owns the magnitude and no raw relationship number is authored by the overseer

  Scenario: The overseer is trigger-only — it never authors an outcome
    Given a started game in active mode
    When the overseer acts on any verdict
    Then every lever only triggers a deterministic engine action (advance or record)
    And the overseer never decides a winner, a vote, a magnitude, or any outcome
    And a verdict proposing a lever outside the fixed set is rejected to the deterministic floor

  Scenario: The deterministic guardrails are the fail-soft floor
    Given a started game in active mode
    When no model resolves, or the overseer call errors or times out
    Then the existing deterministic guardrails take over the correction with no change
    And the turn is never harmed by the overseer

  Scenario: Active is live-only — seeded lanes are unchanged
    Given two games started from the same seed with no real model wired
    When one is run with active mode set and one with it off
    Then their full-game outcomes are identical
    And the seeded calibration band is unchanged (no re-baseline)

  Scenario: Reversibility — flipping the mode restores prior behavior live
    Given a started game running in active mode
    When an admin sets the mode back to shadow and then off
    Then the deterministic guardrails resume acting immediately
    And the diagnostic log keeps recording throughout

  Scenario: The active path never crosses the Vault Wall
    Given a started game in active mode whose Vault holds hidden scheming
    When the overseer assesses and acts across several turns
    Then its inputs and its log carry only Vault-free structural telemetry
    And no Vault data reaches the player or the admin log
