# Executable spec - BUILT (retrospective, 2026-11-03) but NOT wired into cucumber.cjs; behavior is gated by unit tests (see the design note). Feature 0136 - Your Legend Precedes You. Roles only.

Feature: Your Legend Precedes You

  Retrospective scenarios describing the shipped behavior.

  Scenario: A returning player's legend is voiced in the premiere
    Given a returning player with recorded legend beats
    When the premiere context is built
    Then it includes the RETURNING CAST line with the legend clauses

  Scenario: The legend is not voiced after the early game
    Given the same returning player past week 1
    When a later context is built
    Then no RETURNING CAST line is present

  Scenario: No reputation numbers cross
    Given a returning player with a notoriety summary
    When any player, prompt or admin surface is read
    Then no reputation facets, numbers or keys appear
