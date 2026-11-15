# Executable spec - IMPLEMENTED & green; BDD-gated in cucumber.cjs (ORW-385). Feature 0142 - Deal depth II. Roles only.
# Steps: features/step_definitions/deal_depth_ii.steps.ts. They drive the REAL live adapter (a played game: a person is playing)
# and, for the pure package-cost comparison, the real DealLedger + RelationshipModel.

Feature: Deal depth II - counteroffers, owed favors, new deal kinds, weighing a break

  # --- 1. Counteroffers (built: a refusal for cost alone counters with the cheaper safety pact the NPC would take) ----------

  Scenario: A lukewarm NPC answers a too-dear ask with a counteroffer
    Given a played game and an NPC who would refuse a comp-throw ask only because it costs too much
    When the player asks that NPC to throw a competition
    Then the ask is refused and the NPC counters with the safety pact the engine says it would take
    And the counteroffer stands as open state voiced in chat, with no pop-up decision and no deal yet
    And the counteroffer lapses unanswered when the week rolls, with no deal made from it

  Scenario: Accepting a counteroffer yields an ordinary deal
    Given an open counteroffer from an NPC in a played game
    When the player accepts the counteroffer
    Then an ordinary safety deal with that NPC is recorded and the offer no longer stands

  Scenario: Declining a counteroffer makes no deal
    Given an open counteroffer from an NPC in a played game
    When the player declines the counteroffer
    Then no deal with that NPC is recorded and the offer no longer stands

  # --- 2. Owed favors (built: a favor is banked for the PLAYER, the honored side of a deal an NPC kept; the player calls it in) ---

  Scenario: Keeping a deal banks a favor the player can call in
    Given a played game where an NPC promised the player to throw a competition
    When the NPC throws that competition
    Then the deal is kept and the player holds a banked favor from that NPC

  Scenario: A called-in favor tips a marginal ask into a deal
    Given a played game where an NPC owes the player a favor and would refuse a comp-throw ask for cost alone
    When the player calls the favor in for a comp-throw
    Then the engine has the NPC honor it with an ordinary deal and the favor is spent

  Scenario: Ignoring a called-in favor costs trust
    Given a played game where an NPC owes the player a favor but distrusts and fears the player
    When the player calls the favor in for a vote
    Then the engine has the NPC ignore it, no deal binds and the favor is spent
    And the player's hidden trust in that NPC falls

  # --- 3. New deal kinds --------------------------------------------------------------------------------------------------

  Scenario: A conditional deal binds only at the vote
    Given a played game with a conditional deal between the player and an NPC
    When the NPC nominates the player
    Then the conditional deal is still open
    When the NPC votes to evict the player
    Then the conditional deal is broken

  Scenario: A conditional deal whose condition occurs and is honored is kept
    Given a played game with a conditional deal between the player and an NPC
    When the NPC votes out the other nominee while the player is on the block
    Then the conditional deal is kept

  Scenario: A conditional deal whose condition never occurs lapses without a break
    Given a played game with a conditional deal between the player and an NPC
    When the week ends with no vote that tests it
    Then the conditional deal is neither kept nor broken and no longer binds

  Scenario: An information deal moves only through co-presence, and never the Vault
    Given a played game with an information deal from an NPC who holds a fact the player does not, and a sealed Vault secret about that NPC
    When the NPC and the player are in different rooms on a beat
    Then nothing is passed to the player
    When the NPC and the player are in the same room on a beat
    Then the NPC's held fact reaches the player, once
    And the sealed Vault secret reaches no player surface

  Scenario: A package deal bundles two promises adjudicated on their own
    Given a played game with a package deal in which an NPC promises the player safety and to protect a third houseguest
    Then the two promises are recorded as separate parts of one package
    When the NPC nominates the protected third houseguest
    Then only the protect-third part is broken and the safety part stays open

  Scenario: A break inside a package costs more than a stand-alone break
    Given two identical promises to spare a houseguest, one of them inside a package
    When each promisor nominates the houseguest they promised to spare
    Then the wronged party's read of the packaged breaker falls further than of the stand-alone breaker

  # --- 4. NPCs weigh breaking a deal ----------------------------------------------------------------------------------------

  Scenario: An NPC weighs breaking a deal from its own interest, on a side stream
    Given a played game with an open safety deal an NPC promised the player
    When the NPC weighs the deal on a beat with no ceremony open
    Then the deal is marked weighed for this week
    And the same state weighed again gives the same verdicts, because each roll is keyed on the deal and the week

  Scenario: Temptation against the price of being known as a liar
    Given a played game and an NPC with a get-them-out goal on the player, a low bond and little credibility to lose
    And a second NPC with a high bond and a high credibility and no pull
    When each weighs an open safety deal with the player once a week
    Then the first sometimes breaks it and the second never does
    And zeroing the temptation stops the breaking, and zeroing the cost makes it more frequent

  Scenario: A deliberate break is quiet
    Given an NPC that breaks a deal with the player on purpose
    Then the deal keeps showing as open to the player and no player-witnessed betrayal is recorded
    And the break and its named terms are recorded Vault-side and never voiced

  Scenario: Tempted but not enough to break, the NPC asks to renegotiate
    Given an NPC whose temptation is high but whose margin over the price is not positive, bound by a final-two deal with the player
    Then it floats a standing offer to swap the deal for a lighter vote promise, carrying the id of the deal it replaces
    And the old deal stays binding until the player accepts, and accepting retires it neutrally and binds the lighter one

  Scenario: Each deal is weighed once a week and never during a ceremony
    Given an open deal already weighed this week
    Then it is not rolled again that week
    And nothing is weighed while a ceremony step is open

  # --- 5. Gating --------------------------------------------------------------------------------------------------------------

  Scenario: Headless seeded runs are unchanged
    Given a seeded game nobody is playing, with deal depth on and a tempting open deal with the player
    When every deal-depth-II entry point is tried
    Then none of this behavior runs and the engine state is byte-identical
