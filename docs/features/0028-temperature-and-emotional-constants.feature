# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0028 — Temperature & emotional-modifier constants. Shape fixed (0006); numbers tunable.
# HARD rule: roles only; seeded.

Feature: Temperature & emotional-modifier constants — the sim's swing, calibrated and tunable

  Temperature is the per-moment variance across the whole sim, with a soul-sourced emotional
  modifier and a rare hidden-element surfacing rate. The default calibration matches 0006; every
  number lives in one tunable module.

  Scenario: The favorite wins a calibrated strong majority but loses real upsets
    Given a clear favorite in a competition
    When the competition is run across many seeds
    Then the favorite wins a strong majority of the time
    And genuine upsets still occur
    And the player is never protected from losing

  Scenario: Temperature is bounded and never breaks a hard rule
    When temperature is rolled for any moment
    Then the outcome stays within bounds
    # The legality rules themselves are proven in 0005 and 0006; the Vault Wall is proven in 0001.
    And the winner is an eligible competitor
    And the result carries only ids and numbers

  Scenario: The emotional modifier mean-reverts after a spike
    Given a houseguest whose emotional modifier spiked from an adverse moment
    When several calm moments pass
    Then the modifier settles back toward its baseline

  Scenario: Hidden elements surface rarely
    When a season is played out across seeds
    Then hidden character elements surface at a low, bounded rate
    And they are present but not flooding the game

  Scenario: The swing is retunable from one constants module
    Given the temperature constants module
    When a weight such as the temperature bound is changed
    Then the resulting distribution of outcomes changes accordingly
    And no temperature or emotional number is hard-coded outside that module
