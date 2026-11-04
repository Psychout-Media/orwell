# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0037 — Live jury-vote choreography. The LIVE realization of 0014 §5–6 over liveSeason.ts +
# GameSessionAdapter.advanceGame/submitDecision. HARD rule: roles only (player, finalist, juror, evictee).
# The vote is ENGINE-decided; the finale sway comes from the player's STRUCTURED appeal choice, never
# from the LLM grading prose.

Feature: Live jury-vote choreography — the interactive finale

  At Final 2 the live game stages the finale instead of skipping to a winner: each finalist gives an
  opening statement, each of the nine jurors questions both finalists, and the votes are revealed one at a time.
  Jury management (relationship + how each juror was evicted) dominates; the player's engine-legible
  finale appeals sway close jurors but never overturn a clear lead; the last-evicted juror breaks a tie.

  Scenario: The finale plays out as a staged sequence, not a single auto-resolved winner
    Given a live game advanced to Final 2 with the player as a finalist
    When the finale is advanced beat by beat
    Then an opening statement beat is surfaced for each finalist
    And each of the nine jurors questions both finalists
    And the votes are revealed one juror at a time before the winner is named

  Scenario: A finalist answers every juror question through the validated seam
    Given a live game at Final 2 with the player as a finalist
    When the finale is advanced to each player answer
    Then the loop stops for the player to answer with a structured appeal
    And each answer applies only through the submitted decision
    And an answer with no legal appeal is refused

  Scenario: A juror blindsided or betrayed by a finalist is less likely to vote for them
    Given a juror that a finalist blindsided or betrayed on the way out
    When the live jury votes across many seeded runs
    Then that juror votes for that finalist in a reduced share of runs

  # Amended 2026-11-04 (BDD audit AMEND 0037, Ryne-approved): the old Then claimed the player's STRONGEST appeals could not overturn a clear lead but the step
  # played the WEAKEST one, with the player as the leader. Roles are now explicit: the NPC finalist is the LEADER (strong accumulated jury relationships), the
  # PLAYER is the UNDERDOG finalist and plays EVERY legal appeal (including the engine's strongest); the leader must win a clear majority against each.
  Scenario: Jury management dominates and the finale only sways close jurors
    Given a finalist with strong accumulated jury relationships
    When the live jury votes across many seeded runs
    Then that finalist wins the clear majority of runs
    And the player's strongest legal finale appeals do not overturn that clear lead

  # Added 2026-11-04 (AMEND 0037; A-13, #2010/#2013): the informed juror-vote card shows ONLY what the player was told via askJuror.
  Scenario: A player-juror's vote card reflects only what their askJuror tellings surfaced
    Given a live game where the player is a juror at their finale vote card
    Then the vote card carries no juror-held tellings
    When the player asks one fellow juror what they know and the juror tells them
    Then the vote card reflects exactly that telling and nothing the juror merely holds

  Scenario: The player on the jury casts their own vote and an illegal vote is refused
    Given a live game at Final 2 with the player on the jury
    When the finale is advanced to the player's juror vote
    Then the loop stops for the player to vote between the two finalists
    And an illegal juror vote is refused and the vote still stands
    And the other jurors are decided by the engine

  Scenario: The winner is the most-voted finalist with a last-juror tie-break
    When the live jury vote is tallied
    Then the finalist with the most votes wins
    And a tie is broken by the last-evicted juror

  Scenario: The finale surface is Vault-free
    Given a live game at Final 2 whose Vault holds hidden content
    When the finale is advanced and its decisions and reveals are read
    Then no finale output carries a Vault sentinel value
    And no juror lean or vote tally is exposed before the reveal

  Scenario: A finale in progress survives an engine restart
    Given a live finale advanced partway through the question round
    When the engine restarts and resumes from the durable save
    Then the resumed finale stage and the answers already given match exactly

  Scenario: The finale is seed-deterministic
    Given two live games at Final 2 started from the same seed
    When the same finale appeals and votes are applied to each
    Then their revealed votes and winner are identical

  # Amended 2026-06-10 (E37): the player-JUROR's seat at the finale is a real beat. When the
  # question round reaches the player on the panel, the loop pauses for THEIR question (scoreless
  # free text — anti-sycophancy: only structured appeals sway the tally); the finalist's answer
  # remains engine-chosen exactly as for any juror.
  Scenario: The player-juror asks their own finale question
    Given a finale where the player sits on the jury
    When the question round reaches the player's seat
    Then the loop pauses for the player's juror question to each finalist
    And the juror question is scoreless
    And the finalist's answer remains engine-chosen
