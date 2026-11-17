# Feature 0171 - counters, favors both ways, a favor economy (Theme 3 slice 3; Theme 3 Slice Plan, owner B). Design note: 0171-favor-economy.md.
# Rests on the owner's 2026-11-16 rulings: Q1 (engine decides substance, narrator keeps the words), Q3 (low-trust deals weigh less), Q6 (improvised promises bind through the open ledger) and the Theme 3 ruling.
# A favor owed is a debt on the bond (social core). Vault Wall: debts, counters and their reasons are engine-held and never shown as numbers, a ledger or a tally; the player reads people. Roles only, plain words.
# Adds no prompt text and no wording list: the engine hands the narrator FACTS (who, what is asked, the round); the words are authored live.

Feature: Counters and favors form a house currency

  Scenario: A counter asks for what the NPC wants this week
    Given a favors season where an NPC who wants a rival gone is offered safety
    Then favors: the NPC counters that they will take it if the rival goes up

  Scenario: A counter can run several rounds
    Given a favors season where an NPC counters an offer and the offerer counters back
    Then favors: the two trade more than one counter before it settles or falls through
    And favors: no round is ever more than the bounded limit

  Scenario: A favor owed is called in when it matters
    Given a favors season where an NPC owes a houseguest a favor and a vote is close
    When favors: the houseguest is on the block and the favor is called in
    Then favors: the NPC repays it with their vote and the favor is cleared

  Scenario: The engine never calls in a favor the player holds
    Given a favors season where the player is owed a favor and a vote is close
    Then favors: the engine does not call it in for the player

  Scenario: A houseguest collects a favor the player owes, and the player answers
    Given a favors season where the player owes a houseguest a favor and a vote is close
    Then favors: the houseguest asks the player for it through the one standing offer, and the player answers

  Scenario: A counter is a condition, booked only when it holds
    Given a favors season where the player accepts a counter that a rival goes up
    Then favors: the player owes nothing until the rival is actually on the block

  Scenario: A called-in favor refused costs trust, with them and with witnesses
    Given a favors season where an NPC owes a houseguest a favor, and two others heard it promised
    When favors: the NPC refuses it when called in
    Then favors: the houseguest trusts the NPC less, and so do the two witnesses, at a lower weight
    And favors: a houseguest who never heard it is unchanged

  Scenario: A favor can be traded and is remembered
    Given a favors season where a houseguest passes a favor owed to them on to another
    Then favors: the new holder can call it in, and the original debtor is remembered

  Scenario: The bond's debt reads the favor ledger
    Given a favors season where a houseguest is owed a favor by another
    Then favors: the bond record shows the debt on the holder's side, and the reverse view the opposite

  Scenario: Nothing about favors reaches the player as a number or a ledger
    Given a favors season where several favors are owed and repaid
    Then favors: no player or admin view carries a favor count, a debt figure or a ledger

  Scenario: The same seed gives the same counters, and the mix stays balanced
    Given a favors season played twice from the same seed
    Then favors: both runs hold the same counters and favors in the same order
    And favors: across many seeds the share of counters that fall through sits inside the reported band

  Scenario: Favors and debts survive a save and a load whole
    Given a favors season with one favor owed, one repaid and one refused
    When favors: the season is saved and loaded into a fresh session
    Then favors: the loaded session holds every favor it held before, and a later save never holds fewer

  Scenario: Switched off, the season is exactly as it was
    Given a favors season with the favor economy switched off
    Then favors: no favor is recorded and a swap offer carries no counter
