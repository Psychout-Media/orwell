# spec-only: SPEC FIRST (ORW-88, 2026-11-11) - not built, not wired into cucumber.cjs. Feature 0141 - Deal depth II. Roles only.

Feature: Deal depth II - counteroffers, owed favors, new deal kinds, weighing a break

  Scenario: A lukewarm NPC answers an ask with terms (counteroffer)
    Given an NPC who would not accept the player's ask as stated
    When the player makes the ask in chat
    Then the NPC answers with one engine-chosen term drawn from its drive, fear and bonds
    And the counteroffer is open state voiced in chat, with no pop-up
    And it lapses at the end of the week if neither side acts

  Scenario: Accepting or countering a counteroffer yields an ordinary deal
    Given an open counteroffer from an NPC
    When the player accepts it or proposes changed terms the NPC then accepts
    Then an ordinary deal is recorded with those terms

  Scenario: Keeping a deal banks a favor either side can call in
    Given a deal that resolved as kept
    Then the honored side holds a banked favor
    When a side calls it in later
    Then the engine prices whether the other side honors it from trust, reliability and cost
    And ignoring a called-in favor costs trust and reliability

  Scenario: A conditional deal binds only when its condition happens
    Given a conditional deal "if one party is nominated the other votes to keep them"
    When the condition occurs
    Then the promise binds and is adjudicated like any vote deal
    And when it never occurs the deal lapses without a break

  Scenario: An information deal moves only through co-presence
    Given an information deal between two houseguests
    When they are not together
    Then nothing is passed
    And when they are together a Vault-free, witnessed fact may pass

  Scenario: A package deal bundles two promises
    Given a package of two promises
    Then each promise is kept or broken on its own, and a break of either costs the whole package's reliability

  Scenario: An NPC weighs breaking a deal from its own interest
    Given an NPC bound by an open deal with a tempting alternative
    Then the engine decides keep, quietly break or renegotiate from interest, personality and the price of being known as a liar
    And the decision draws no rng from the shared stream in a game nobody is playing

  Scenario: Headless seeded runs are unchanged
    Given a seeded game nobody is playing
    Then none of this behavior runs and the seeded trajectory is byte-identical
