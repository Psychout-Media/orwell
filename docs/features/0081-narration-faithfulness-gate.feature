# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Design contract — BUILT (PR #778) and shipped DEFAULT ACTIVE (owner ruling 2026-07-13); verified by FE tests, NOT wired into cucumber.cjs. Reflects the answered design (full faithfulness; hybrid detection;
# judge on claim-bearing turns only; folded into the overseer's 3-state mode; correction split on
# ADR 0005 — adopt the open set, reframe the closed set, backend re-ground the un-reframable) + the
# invariants that hold regardless of the §10 owner rulings. (Header corrected 2026-11-12, ORW-286 item 8.) HARD rule: roles only (player, NPC, HOH, nominee, admin).
# The judge's inputs and the Overseer log are Vault-free BY CONSTRUCTION; seeded fixtures only; a
# deterministic stub / injected faithfulness verdict stands in for the model.

Feature: Narration-faithfulness gate — the GM never visibly errs (ground the prose; recover a slip diegetically; never bend the result)

  The overseer's second role watches whether the narration is faithful to engine truth — it must not
  contradict the board, drift persona, leak machinery or hidden facts, or drop a beat. Detection is
  hybrid: the deterministic pre-emission guard corrects regex-able closed-set board claims before the
  stream and flags a turn as claim-bearing; an LLM faithfulness judge runs ONLY on claim-bearing turns and
  catches the semantic remainder post-stream. When a slip is caught, active mode recovers it so it reads as
  intentional — split on ADR 0005: an open-set slip is adopted as canonical (the claim becomes true), a
  closed-set slip is reframed in-fiction (the outcome is NEVER bent). It is reversible (an explicit `off`
  still disables it), live-only, ships active by default, and logs every attempt with context. The Vault Wall and the engine's outcome
  authority are untouched.

  Scenario: The judge wakes only on a claim-bearing turn
    Given a started game with the overseer in shadow mode and a model available
    When a beat narrates pure mood and asserts nothing checkable
    Then the faithfulness judge is not summoned and no Overseer log line is written
    When a later beat asserts a checkable claim about the board
    Then the faithfulness judge is summoned exactly once for that beat

  Scenario: Shadow mode logs a contradiction without correcting it
    Given a started game with the overseer in shadow mode
    And the narration claims a nominee is safe while the board has them nominated
    When the faithfulness judge assesses the beat
    Then the contradiction is logged to the Overseer stream with the claim, the engine truth, and the dimension
    And no correction is applied and the board is unchanged

  Scenario: Active mode adopts an invented open-set detail as canonical
    Given a started game in active mode with a model available
    And the narration invents an open-set detail the engine never fixed
    When the faithfulness judge classifies the slip as open-set
    Then the detail is recorded as canonical through the existing record path so the claim becomes true
    And nothing downstream contradicts the now-canonical detail
    And the adopt is logged to the Overseer stream as an action

  Scenario: Active mode reframes a closed-set contradiction without bending the outcome
    Given a started game in active mode where the narration claimed a veto win that did not happen
    When the faithfulness judge classifies the slip as closed-set and reframable
    Then the next turn is steered to absorb the slip as an in-fiction misbelief
    And the model authors the recovery prose itself — the overseer only chooses the framing
    And the engine outcome and board are byte-identical before and after the recovery

  Scenario: A closed-set claim is NEVER adopted — the anti-sycophancy guard
    Given a started game in active mode
    And the narration asserts a false claim about a closed-set field
    When the faithfulness judge is forced to propose adopting it
    Then the adopt is refused because the claim touches a closed-set field
    And the correction falls through to a reframe or a backend re-ground
    And no closed-set outcome, board value, or eligibility is ever rewritten to match the narration

  Scenario: An un-reframable closed-set slip uses the configurable fallback (default quiet re-ground)
    Given a started game in active mode where a closed-set slip has no plausible in-fiction reframe
    And the un-reframable fallback setting is at its default
    When the faithfulness judge classifies the slip as closed-set and un-reframable
    Then the corrected state delta is re-injected so the false claim dies at the source
    And the violation is logged with full context
    And no visible player-facing retraction is emitted and the engine truth stands going forward
    And every fallback option leaves the engine truth unbent

  Scenario: Faithfulness has its own dial, independent of the pacing role
    Given a started game with the pacing role set to active and the faithfulness role set to shadow
    When a claim-bearing turn produces a contradiction and a separate turn stalls at an advance phase
    Then the faithfulness contradiction is logged but not corrected
    But the pacing stall is still acted on by the active pacing role
    And an admin can move the faithfulness dial to active without changing the pacing dial

  Scenario: A persona or in-bounds violation is reframed
    Given a started game in active mode
    And an NPC narrates knowledge of a vote it never witnessed and was never told
    When the faithfulness judge flags the persona dimension
    Then the claim is reframed as the NPC's suspicion rather than confirmed knowledge
    And the houseguest's stable public persona is preserved

  Scenario: The judge catches a leak without ever reading the Vault
    Given a started game in active mode whose Vault holds a hidden confessional the player was never told
    And the narration asserts that hidden fact in the GM's voice
    When the faithfulness judge assesses the beat using only the player's known projection
    Then the assertion is flagged as ungrounded because it lies outside what the player can legitimately know
    And the judge holds no Vault handle and the leak is caught structurally, not by Vault comparison
    And the flagged claim is reframed so the hidden fact is never confirmed to the player

  Scenario: A dropped beat (omission) is caught as the dual of contradiction
    Given a started game in active mode where the engine recorded a ceremony the narration did not voice
    When the faithfulness judge assesses the beat against the board
    Then the omission is flagged so the player's belief does not silently desync from the board

  Scenario: The gate covers the casting, premiere, and preview-decision junctions
    Given a started game in active mode at the casting interview
    And the narration asserts a houseguest trait that contradicts the generated profile
    When the faithfulness judge assesses the casting beat
    Then the contradiction is caught and recovered with the same detect-and-correct behavior as the in-game loop
    And the same gate applies at the premiere meet-everyone beat and at a preview-decision beat

  Scenario: Active faithfulness is live-only — seeded lanes are unchanged
    Given two games started from the same seed with no real model wired
    When one is run with the overseer in active mode and one with it off
    Then their full-game outcomes are identical
    And the seeded calibration band is unchanged with no re-baseline

  Scenario: Fail-soft — with no judge the existing floor stands
    Given a started game in active mode
    When no model resolves, or the faithfulness judge errors or times out
    Then the deterministic pre-emission guard, the reasoning scrub, and the non-collapse gates behave exactly as today
    And the turn is never harmed by the judge

  Scenario: Reversibility — flipping the mode restores prior behavior live
    Given a started game running with the overseer in active mode
    When an admin sets the mode back to shadow and then off
    Then the deterministic faithfulness floor resumes immediately
    And the diagnostic log keeps recording in shadow throughout

  Scenario: Every attempt is logged Vault-free with full context
    Given a started game in active mode across several claim-bearing turns
    When the faithfulness judge assesses and recovers slips
    Then each attempt is written to the Overseer stream with the dimension, the class, the claim, the engine truth, the lever, and whether it applied
    And the log is sentinel-clean on both the player and the admin canaries
