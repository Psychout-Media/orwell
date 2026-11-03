# Executable spec - BUILT (retrospective, 2026-11-03) but NOT wired into cucumber.cjs; behavior is gated by unit tests (see the design note). Feature 0139 - The Booth Has Receipts. Roles only.

Feature: The Booth Has Receipts

  Retrospective scenarios describing the shipped behavior.

  Scenario: A stated target and a different vote produce a receipt
    Given the player said they would target one nominee and then voted for the other
    When the booth receipts are read
    Then a target-vote-mismatch receipt appears citing its source events

  Scenario: Two open final-two deals produce a receipt
    Given the player holds two open final-two deals
    When the receipts are read
    Then a divergent-commitment receipt appears

  Scenario: Receipts read only the player's own record
    Given hidden NPC events exist in the season
    When the receipts are read
    Then none of them draw on hidden events or NPC state
