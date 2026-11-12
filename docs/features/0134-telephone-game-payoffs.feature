# Wired into cucumber.cjs by ORW-300 (steps in features/step_definitions/telephone_game_payoffs.steps.ts); also gated by unit tests (see the design note). Feature 0134 - Telephone-Game Payoffs. Roles only.

Feature: Telephone-Game Payoffs

  Retrospective scenarios describing the shipped behavior.

  Scenario: A twice-retold fact carries a provenance word
    Given a gossip fact that has passed through two hops before reaching the player
    When the fact is surfaced to the player
    Then its row carries a chain-length word such as second-hand
    And no houseguest identity from the chain is shown

  Scenario: A first-hand fact carries no provenance word
    Given a fact the player witnessed or heard directly
    When it is surfaced
    Then its row has no provenance word

  Scenario: With the flag off the row is unchanged
    Given gossip drift is disabled
    When a drifted fact is surfaced
    Then the surfaced row is byte-identical to the pre-feature rendering
