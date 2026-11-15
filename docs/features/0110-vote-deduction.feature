# Executable spec — BUILT & green; BDD-gated in cucumber.cjs (2026-06-28). Flag ORWELL_VOTE_DEDUCTION (code default ON; =0 opts out).
# Feature 0110 — Vote deduction (process of elimination): the jury grudge folds on a DEDUCED belief,
# never on the true secret ballot. Realizes option B of the 0023 secret-vote-grudge ruling.
# HARD rule: roles only (evictee, voter, loyalist, HOH, nominee, the-player). No names.
# Builds on: 0047 (secret ballot + public count), 0002 (belief + confidence, can be wrong),
#            0037/0014 (jury grudge), 0026 (betrayal-shock), 0017 (directed reads).

Feature: Vote deduction — a secret ballot becomes a deduced belief, by process of elimination

  Eviction votes are secret ballots: the COUNT is public, the attribution is not. An evictee cannot be
  handed the tally — instead they DEDUCE who moved against them from the public count, the eligible voter
  pool, and their own reads (who they trusted, who they suspected). The jury grudge (0037/0014) folds on
  that deduced belief — which can be WRONG (0002) — never on the true vote list. The truth still lives in
  the sealed record and unseals only in the 0048 retrospective. Nothing about the deduction crosses to the
  player or the admin.

  Background:
    Given a running game sandbox with a fully populated Producer's Vault
    And vote deduction is enabled

  Rule: The count is public; the attribution stays secret (reaffirms 0047)

    Scenario: The eviction reveals a count but never a voter
      Given an eviction resolves by a secret ballot
      Then the vote count is available to the deduction
      And no player-facing or admin-facing surface names who voted for whom
      And the true tally is still recorded for the 0048 retrospective

  Rule: The evictee deduces the defectors by process of elimination

    Scenario: A fully-constrained vote is deduced correctly with high confidence
      Given an eviction whose public count and eligible voter pool leave exactly one arrangement
      When the evictee deduces who voted against them
      Then the deduced belief matches the true voters
      And the belief is held with high confidence

    Scenario: An ambiguous vote yields a low-confidence belief that can be wrong
      Given an eviction whose public count admits several equally-plausible arrangements
      When the evictee deduces who voted against them
      Then the belief is held with low confidence
      And the deduced belief need not match the true voters

    Scenario: A trusted ally the count forces to have flipped reads as a betrayal
      Given an evictee who trusted two loyalists
      And a count that forces at least one loyalist to have voted against them
      When the evictee deduces who voted against them
      Then a trusted loyalist is deduced as a defector
      And that deduction carries betrayal-grade shock

  Rule: The jury grudge folds on the deduced belief, never on the true ballot (option B)

    Scenario: A deducible defector earns the grudge
      Given a voter the evictee can deduce moved against them
      When the eviction manner is recorded
      Then the evictee holds a jury grudge toward that voter

    Scenario: An undeducible secret vote earns no grudge
      Given a voter whose vote the evictee cannot deduce from the public count and their reads
      When the eviction manner is recorded
      Then the evictee holds no jury grudge toward that voter
      # Secrecy honored: a quiet vote the evictee can't work out has no jury consequence.

    Scenario: The player's secret vote only costs jury goodwill when it is deducible
      Given the player casts a secret eviction vote against a houseguest
      When that houseguest is evicted and the eviction manner is recorded
      Then the evictee holds a grudge toward the player only if the player's vote was deducible
      And no player-facing surface reveals whether the vote was deduced

    Scenario: A wrong deduction misattributes the grudge (dramatic irony)
      Given an ambiguous vote the evictee deduces incorrectly
      When the eviction manner is recorded
      Then the evictee may hold a grudge toward a houseguest who did not vote against them
      And may hold none toward a houseguest who did
      And the true tally is unchanged in the sealed record

  Rule: The public responsibility path is unchanged

    Scenario: The HOH and nominations still drive grudges directly
      Given an evictee moved against by the HOH's nominations
      When the eviction manner is recorded
      Then the HOH is the public cause of the move with no deduction involved
      # Only the SECRET vote half is routed through deduction; the public half is untouched.

  Rule: The Vault Wall holds for player AND admin

    Scenario: No deduction, belief, or confidence crosses to any surface
      Given the evictee has deduced a belief about who voted against them
      When the deduced game's player and admin projections are assembled
      Then no surface shows who the evictee believes voted
      And no surface shows a confidence or a grudge magnitude
      And no Vault sentinel value appears

  Rule: Calibration-neutral when off

    Scenario: With deduction disabled, the seeded outcomes match the deduction-enabled season (legacy (flag off) twist path)
      Given a full season is played with vote deduction disabled
      Then the eviction order and the competition tally are identical to the same seed with deduction enabled
