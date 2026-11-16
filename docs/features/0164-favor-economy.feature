# Feature 0164 - counters, favors both ways, a favor economy (Theme 3 slice 3; Theme 3 Slice Plan, owner B). SCENARIOS DRAFTED, NOT BUILT.
# Design note: 0164-favor-economy.md. Rests on the owner's 2026-11-16 rulings: Q1 (engine decides substance, narrator keeps the words), Q3 (low-trust deals weigh less),
# Q6 (improvised promises bind through the open ledger) and the Theme 3 ruling. A favor owed is a debt on the bond (social core). Vault Wall: debts, counters and
# their reasons are engine-held and never shown as numbers, a ledger or a tally; the player reads people. Roles only, plain words.

Feature: Counters and favors form a house currency

  Scenario: A counter asks for what the NPC wants this week
    Given a favors season where an NPC who wants a rival gone is offered safety
    Then the NPC counters: they will take it if the rival goes up

  Scenario: A counter can run several rounds
    Given a favors season where an NPC counters an offer and the offerer counters back
    Then the two can trade more than one counter before it settles or falls through
    And no round is ever more than the bounded limit

  Scenario: A favor owed is called in when it matters
    Given a favors season where an NPC owes a houseguest a favor and a vote is close
    When the houseguest calls the favor in
    Then the NPC repays it with their vote or their word, as the favor was

  Scenario: A called-in favor refused costs trust, with them and with witnesses
    Given a favors season where an NPC owes a houseguest a favor, and two others heard it promised
    When the NPC refuses it when called in
    Then the houseguest trusts the NPC less, and so do the two witnesses, at a lower weight
    And a houseguest who never heard it is unchanged

  Scenario: A favor can be traded and is remembered
    Given a favors season where a houseguest passes a favor owed to them on to another
    Then the new holder can call it in, and the original debtor remembers who held it

  Scenario: Nothing about favors reaches the player as a number or a ledger
    Given a favors season where several favors are owed and repaid
    Then no player or admin view carries a favor count, a debt figure or a ledger

  Scenario: The same seed gives the same counters, and the mix stays balanced
    Given a favors season played twice from the same seed
    Then both runs hold the same counters and favors in the same order
    And across many seeds the share of refused favors sits inside the reported mix band

  Scenario: Favors and debts survive a save and a load whole
    Given a favors season with one favor owed, one repaid and one refused
    When the season is saved and loaded into a fresh session
    Then the loaded session holds every favor it held before, and a later save never holds fewer
