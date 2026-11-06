# BUILT (2026-06-27) and wired into cucumber.cjs (steps: features/step_definitions/secrets_as_power.steps.ts). Originally a PO-review spec; R1-R4 are ruled.
# Feature 0093 — Secrets as strategic levers. A LEARNED secret unlocks a concrete option; the ENGINE owns the magnitude.
# HARD rule: roles only (the-player, a houseguest, a rival, the wronged houseguest, a bystander, the admin). No names.
# Builds on 0075 (learn a secret), 0039 (deals), 0002 (pathway). Bounded by the Vault Wall, anti-sycophancy, ADR 0005.

Feature: Secrets as strategic levers (information becomes power)

  When the player has LEARNED a houseguest's secret through a real in-game pathway, that secret stops
  being inert flavor and unlocks a concrete strategic option: leverage in a deal, or an expose that
  damages a rival's standing. The engine decides the bounded, seeded magnitude — the model only voices
  which secret, which target, and the prose. The Vault Wall holds for the player AND the admin: the
  player can only wield a secret they already legitimately hold, and no number ever crosses.

  Background:
    Given a started season with the player in the house

  Rule: Only a learned secret is a lever (information the player actually holds)

    Scenario: A secret the player has not learned offers no lever
      Given a houseguest holding a sealed secret the player has never learned
      When the player attempts to leverage or expose that secret
      Then no lever is available and the attempt is rejected
      And the houseguest's sealed secret never appears on any player-facing surface
      And no undisclosed secret is read to evaluate the attempt

    Scenario: A learned secret becomes a usable option
      Given a houseguest whose secret the player has learned through a pathway
      When the player considers their options with that houseguest
      Then a concrete leverage option and an expose option are available for that secret
      And a player who has not learned it has neither option

  Rule: Leverage colors a deal but never forces it (composes with deals 0039)

    Scenario: Valid leverage raises the chance a houseguest takes a deal
      Given a houseguest whose secret the player has learned
      When the player offers that secret as leverage while making a deal with them
      Then the deal lands better than the same deal offered without leverage
      And the deal remains a first-class tracked commitment
      And the engine owns the bounded magnitude of the leverage, not the narrator

    Scenario: A wary houseguest can refuse leverage and resent it
      Given a houseguest who reads the player as a high threat with little warmth
      And whose secret the player has learned
      When the player presses that secret as leverage in a deal
      Then the houseguest may still refuse the deal
      And pressing them with the secret can worsen their hidden read of the player
      And no opinion number is shown to the player

    Scenario: With no leverage offered, deal formation is unchanged
      Given an open deal made without any leverage
      Then deal formation is identical to deal tracking with no secrets involved

  Rule: Expose is engine-decided, bounded, recorded, and capped

    Scenario: Exposing a learned secret damages the rival and recoils on the exposer
      Given a rival whose secret the player has learned
      When the player exposes that secret to the house
      Then the engine applies a bounded, seeded drop to how the house reads the rival
      And the player who exposed it takes a betrayal-grade hit from the rival
      And the magnitude of both is decided by the engine, never narrated into being
      But the player is shown no opinion number

    Scenario: Exposing a secret reaches the house only through a modeled pathway
      Given a rival whose secret the player has learned
      When the player exposes that secret to the house
      Then the other houseguests learn it as a recorded witnessed event
      And no surface is ever handed the Vault to deliver it

    Scenario: A used secret cannot be wielded again, and repeat exposes are limited by what they cost
      Given a secret the player has already exposed
      When the player attempts to leverage that secret again
      Then the attempt is rejected because the secret is already spent
      And across a full season repeat exposes are never refused as capped, but each one sours the house against the player
      And the spent state survives an engine restart

  Rule: The Vault Wall holds for the admin too, and outcomes are deterministic

    Scenario: Neither the player nor the admin is ever shown a lever magnitude
      Given a learned secret the player has used as leverage
      When the player inspects their surfaces
      And the admin inspects the god-mode surfaces
      Then no leverage strength and no hidden standing change appears on either
      And only the fact of the deal or exposure and its observable fallout is visible

    Scenario: The same seed and history yield the same lever outcome
      Given a fixed seed and the same learned secret and the same target
      When the player leverages or exposes it twice from the same state
      Then the engine produces the same outcome each time
      And the untouched seeded vote distribution is unchanged by the feature
