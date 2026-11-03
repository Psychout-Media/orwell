Feature: 0092 — Secret-pacing drip (the paced "I knew it" payoff)
  Most of the house's sealed secrets stay buried — rich but inert. This feature paces a thin,
  relationship-aware DRIP so about one or two hidden secrets per week edge toward the player
  through REAL in-game pathways (overhearing, a confidant letting something slip, a gossip
  chain that finally reaches the player), about the people the player is actually circling.
  The engine owns the schedule — WHICH secret is ripe, and WHETHER the weekly drip budget
  allows it — and re-weights the existing surfacing decision; it never reads the Vault to a
  surface, never hands the player or admin a secret directly, and never authors the line. A
  secret becomes the player's knowledge only when a modeled pathway actually terminates at
  them, recorded as a content-lineage-anchored belief — the Vault Wall holds.

  # Role-only (testing rule): the-player, a houseguest, a close ally, a rival, a bystander.

  Background:
    Given a started season with the player among a cast carrying sealed secrets
    And the secret-pacing drip is enabled

  Rule: A drip only ever crosses through a modeled in-game pathway

    Scenario: A ripe secret reaches the player via a gossip chain
      Given a rival the player has high tension with is sitting on a sealed secret
      And the schedule marks that secret ripe to drip toward the player
      When a gossip chain about that secret terminates at the player
      Then the player gains a belief about that secret with a source and a confidence
      And the belief is a paraphrase, never the verbatim sealed premise
      And the secret is now the player's recorded knowledge through that pathway

    Scenario: A drip never crosses without an anchored pathway
      Given the schedule marks a secret ripe to drip toward the player
      When no in-game pathway terminates at the player this week
      Then the player learns nothing the secret has not reached them through
      And the sealed premise never appears on any player-facing surface

  Rule: The pace is bounded — about one or two per week, never a firehose

    Scenario: The weekly drip budget caps how many secrets edge toward the player
      Given several sealed secrets are all ripe to drip toward the player this week
      When the off-screen life runs across the week
      Then the number of secrets that edge toward the player does not exceed the weekly drip ceiling
      And the surplus ripe secrets keep playing out off-screen between the houseguests
      And the season-long surfaced-to-player total never exceeds the season cap

    Scenario: The drip prefers secrets about people the player is circling
      Given a close ally and a rival each sit on a sealed secret
      And a bystander the player has no bond or tension with also sits on a sealed secret
      When the off-screen life runs over several weeks
      Then the secrets that drip to the player are far more often the ally's or the rival's
      And a secret about the bystander is far less likely to ever drip

  Rule: Earned and anchored — never a cold pop-up, never re-spammed

    Scenario: No off-screen process starts a scene just to deliver a secret
      Given the schedule marks a secret ripe to drip toward the player
      Then no scene is started out of nowhere to deliver that secret
      And the drip surfaces only through the bounded off-screen life and an anchored pathway

    Scenario: A secret already caught is not dripped again
      Given the player has already caught wind of a houseguest's secret
      When the off-screen life runs further
      Then that same secret is not dripped to the player again at the same depth
      And the schedule moves on to other ripe secrets

  Rule: The engine schedules; the model only voices; the Vault holds for player and admin

    Scenario: The schedule and ripeness never reach any surface
      Given a season with sealed secrets and an active drip schedule
      When the player-facing surfaces and the admin surface are assembled
      Then no sealed premise appears on the player surface
      And no sealed premise appears on the admin surface
      And the ripeness scores, the weekly drip counter, and any number never appear on any surface

    # Calibration neutrality (the shared draw stream is byte-identical drip ON vs OFF) is gated by
    # tests/unit/secretPacingNeutral.test.ts; the former last line compared an unpaced run to a replay of itself.
    Scenario: The drip is deterministic and takes no draws when off
      Given two seasons played from the same seed and the same history
      Then the secrets that drip and the weeks they drip in are identical
      Given a season played with the secret-pacing drip disabled
      Then no pacing draws are taken
