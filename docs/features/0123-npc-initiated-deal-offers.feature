# Executable spec — SPEC (drafted failing-first), now IMPLEMENTED & green. The NPC->player counterpart of
# makeDeal: a motivated houseguest floats the player a deal at a lull; accept makes a real deal, decline
# rebuffs them. Grounded, Vault-safe, bounded, calibration-safe (default-ON ORWELL_NPC_DEAL_OFFERS).
# HARD rule: roles only (NPC, HOH, houseguest, player) — no names. Added to cucumber.cjs when green.

Feature: NPC-initiated deal offers

  Today the player proposes deals and NPCs deal with each other, but no houseguest ever comes to the
  player. This adds that pathway: a motivated houseguest pulls the player aside with a deal, grounded in
  their real read. Accepting makes a real deal; declining cools them. Everything stays Vault-safe and the
  engine supplies the offer's shape — the narrator never invents it.

  Scenario: A motivated houseguest floats the player a deal at a lull
    Given a live game with houseguest deal offers enabled
    When the season plays through several lulls
    Then a houseguest floats the player a deal offer
    And the floated offer names who it is from, its kind, and its terms

  Scenario: The floated offer's kind is grounded in the NPC's real read
    Given a live game where one houseguest reads the player as a strong ally
    When that ally floats the player a deal offer
    Then the floated offer is a final-two deal, grounded in their real bond

  Scenario: Accepting a floated offer makes a real player deal
    Given a houseguest has floated the player a deal offer
    When the player accepts the floated offer
    Then a deal between the player and that houseguest stands on the board
    And no floated offer is left waiting

  Scenario: Declining a floated offer rebuffs the houseguest
    Given a houseguest has floated the player a deal offer
    When the player declines the floated offer
    Then no deal is created from the floated offer
    And that houseguest's hidden read of the player cools a little

  Scenario: Floated offers are player-witnessed, Vault-safe, and bounded
    Given a houseguest has floated the player a deal offer
    When the player-facing surfaces are read for the floated offer
    Then the floated offer is the player's own knowledge, never hidden Vault content
    And only one floated offer stands at a time

  # PO ruling 2026-11-01: deal offers play out in the conversation — no pop-up, never a freeze. The
  # narrator voices the houseguest raising it; the player's in-chat yes/no is recorded; an offer the
  # player never answers lapses at week's end, and how hard the houseguest takes that depends on them.
  Scenario: A floated offer never freezes the week, and lapses if ignored
    Given a houseguest has floated the player a deal offer
    When the player ignores the floated offer and play continues
    Then the week keeps moving while the offer stands
    And the floated offer lapses when the week rolls over

  Scenario: With offers off, no houseguest floats a deal
    Given a live game with houseguest deal offers disabled
    When the season plays through several lulls
    Then no houseguest ever floats the player a deal offer
