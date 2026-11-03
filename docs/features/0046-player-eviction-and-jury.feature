# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0046 — Player eviction & the juror's seat. The most common ending, made faithful + Vault-safe.
# HARD rule: roles only (player, evictee, juror, finalist). Add to cucumber.cjs when green.

Feature: Player eviction & the juror's seat

  When the player is voted out the game does not end abruptly: their projection marks them out, they either
  go home (pre-jury) or take the juror's seat, they watch a paced broadcast of the rest of the season, and
  at the finale they cast their vote. A juror only ever learns the public ceremony outcomes — never the
  house's hidden scheming.

  # Amended by 0133: a pre-jury evictee's path ends with the exit interview, then the spectator-choice card (skip / watch).
  Scenario: A pre-jury eviction reaches a defined end
    Given a started game in which the player is evicted before the jury
    When the eviction resolves
    Then the player's status is marked evicted
    And the player's decisions after the eviction are the exit interview, then the spectator choice
    And the season reaches a defined end state for that player

  Scenario: A jury-phase eviction seats the player on the jury
    Given a started game in which the player is evicted into the jury
    When the eviction resolves
    Then the player's status is marked jury
    And the moment framing switches to the spectator/jury view

  Scenario: A juror only learns public ceremony outcomes
    Given the player is a juror while the house plays on
    And the house schemes off-screen and records confessionals the player did not witness
    When the juror's knowledge is derived
    Then it contains only the public ceremony outcomes broadcast after their eviction
    And it contains no off-screen scheme and no confessional
    And no Vault sentinel value appears on the juror's projection

  Scenario: The juror watches to the finale and casts a vote
    Given the player is a juror
    When the remaining weeks are fast-forwarded to the finale
    Then the player is brought to the finale as a juror
    And the player casts a juror vote through the validated seam

  Scenario: A player evicted at any index completes the season
    Given a seeded game in which the player is evicted at an arbitrary week
    When the season runs to completion
    Then it reaches a winner or the player's defined end state without error
    And the out-of-game state survives an engine restart
