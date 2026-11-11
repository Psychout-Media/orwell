# RETIRED 2026-11-11 (owner ruling, "retire and remove"): not planned, code and tests removed (card ORW-267). Kept as history only; not wired.
# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
Feature: 0098 — Confidence-calibrated reads (bold correct reads pay off; blind faith burns)
  When the player ACTS on a belief, the strength of that belief sets the VARIANCE of the
  outcome — never its direction. The lower the player's hidden confidence in the read they
  act on, the wider the seeded swing: a bold correct read can pay off bigger, and blind faith
  can crater, symmetrically. The engine widens a symmetric, seeded band around an unchanged
  center and lets the existing seeded roll decide — it never aims the result, never rewards a
  correct read or punishes a wrong one (anti-sycophancy). The conviction, the band, and the
  roll are hidden engine state — the Vault Wall holds for the player AND the admin, and the
  player feels only the swing, never a number. The feature is opt-in and byte-identical when
  off or when the read is fully confident — the calibration spine is unmoved.

  # Role-only (testing rule): the-player, a houseguest, an ally, a near-stranger, the admin.

  Background:
    Given a started season with the player in the house

  Rule: Lower confidence in the read being acted on widens the seeded outcome band

    Scenario: Acting on a shaky read raises the variance of the outcome
      Given the player holds a low-confidence belief from a distorted rumor
      When the player takes an action grounded in that belief
      Then the seeded outcome band for that action is wider than the baseline
      And the widening is symmetric about the same center the outcome already had

    Scenario: Variance rises monotonically as conviction falls
      Given a series of actions grounded in beliefs of decreasing confidence
      When the outcomes are measured across seeds
      Then the variance of the outcome rises as the player's confidence falls
      And the mean outcome stays unchanged across the series

  Rule: A confident read is the baseline, and stays byte-identical

    Scenario: A read the player witnessed resolves at the baseline width
      Given the player holds a fully-confident belief they witnessed
      When the player takes an action grounded in that belief
      Then the seeded outcome band for that action is exactly the baseline width
      And the seeded outcome is byte-identical to the no-feature model

    Scenario: A bold correct read can pay off bigger on a good seed
      Given the player acts on a low-confidence read that happens to be correct
      When the wider symmetric band lands on the favorable side this seed
      Then the outcome is bigger than a safe read would have produced
      And the engine never read whether the belief was correct before resolving

  Rule: Blind faith burns harder — symmetrically and bounded

    Scenario: Acting on near-nothing is a coin-flip swing both ways
      Given the player acts on a belief held with near-zero confidence
      When the outcomes are measured across seeds
      Then the outcome has fatter tails on both the winning and the losing side
      And the swing never exceeds the hard variance ceiling
      And a hard legality is never flipped and archetype weighting is never overridden

  Rule: The engine never aims the result (anti-sycophancy)

    Scenario: A low-conviction action has the same expected outcome as a confident one
      Given many seeded runs of a low-conviction action and a high-conviction action
      When the outcomes are averaged across seeds
      Then the low-conviction action's expected outcome equals the high-conviction baseline within tolerance
      And only the variance differs between them

  Rule: Conviction is hidden — Vault-Wall holds for player AND admin

    Scenario: No surface ever reveals the conviction, the band, or the roll
      Given the player takes an action grounded in a low-confidence belief
      When the player views any player-facing surface
      And the admin views any God-Mode surface
      Then neither surface returns the player's confidence in the read
      And neither surface returns the band width or the roll
      And the player experiences only the swing, with no marker that they were unsure

  Rule: The model proposes which belief, never the magnitude

    Scenario: The model grounds an action in a belief and voices the swing
      Given the player takes an action the model reads as grounded in a belief
      When the model proposes which belief the action is grounded in
      Then the engine validates the belief against what the player legitimately knows
      And the engine alone sets the variance band and resolves the seeded roll
      And the model voices the swing as drama with no number and no claim the read was right or wrong

    Scenario: An ungrounded or invalid belief reference falls back to the baseline
      Given the player takes a generic action not grounded in any belief
      When the engine resolves the outcome
      Then no conviction term is applied
      And the seeded outcome is byte-identical to the no-feature model

  Rule: Opt-in and calibration-neutral — byte-identical when off

    Scenario: With the feature disabled, seeded outcomes are byte-identical
      Given the confidence-calibration feature is disabled
      When the same seeded season is played
      Then no conviction band is applied to any action
      And the seeded competition and eviction outcomes are byte-identical to the baseline

    Scenario: With the feature enabled, the mean distribution stays inside the calibrated band
      Given the confidence-calibration feature is enabled
      When a full season is played across seeds
      Then the mean eviction and jury distributions stay inside the calibrated band
      And only the variance of belief-grounded outcomes widens
