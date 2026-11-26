# Spec-only until slice 1 wires it (docs/features/0212-bloc-vote-pact.md). Roles only, never names.
Feature: The bloc vote pact
  Allies agree a vote target in a scene and vote it together, bound by personality and stakes.

  Scenario: Allies agree a target and a pact is recorded
    Given a detected bloc of three NPCs whose eviction vote is live this week
    When one member proposes a nominee as the target and the others accept
    Then a pact row records the members, the target and the week
    And no ally or enemy label is stored on any houseguest

  Scenario: A kept pact binds the vote
    Given a pact whose member's own keyed roll keeps it
    When the member casts their eviction vote
    Then the member votes the pact's target out
    And the why record names the pact rule

  Scenario: A broken pact is a betrayal the house can learn of
    Given a pact whose member's own keyed roll breaks it
    When the votes are revealed
    Then the pact's other members fold a deal-broken memory and a trust drop
    And no ballot names its caster

  Scenario: Binding follows character and stakes
    Given two members of equal bond, one loyal and honest, one a schemer
    Then the loyal one keeps the pact more often over the same seeds

  Scenario: The player never learns the roster
    Given a pact formed in a scene the player was not in
    Then no view, tool result, narrator prompt or admin projection carries the pact row

  Scenario: Hard rules still bind
    Given a pact member who is the HOH, a nominee, or the player
    Then the pact never casts that member's ballot

  Scenario: The pact off is byte-identical
    Given the pact flag off
    Then a seeded season is byte-identical to main

  Scenario: Calibration gates hold
    Given 200 seeds of the bloc scenario and 300 seeds per play style
    Then the bloc lift minus its noise is above zero
    And solid-play reach of the Final 2 stays within 12 to 20 percent
