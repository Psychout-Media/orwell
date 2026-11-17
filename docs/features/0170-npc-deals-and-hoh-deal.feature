# Feature 0170 - deals between NPCs and the HOH deal (Theme 3 slice 2; Theme 3 Slice Plan, owner B). BUILT behind ORWELL_NPC_DEALS (default ON; =0 is byte-identical to before).
# Design note: 0170-npc-deals-and-hoh-deal.md. Rests on the owner's 2026-11-16 rulings: Q1 (the engine decides the substance, the narrator keeps the words),
# Q3 (fake deals carry no built-in tell; a low-trust deal weighs less), Q4 (NPC to NPC from the start) and the Theme 3 ruling (deepen social systems).
# ONE plan model: this slice only seals the pacts (who, what kind). Every side's secret plan comes from the 0178 deal-plan planner (`planAndCarryOutDeals`, played games only) like every deal,
# and a betrayal due at the nominations is carried out there before the push is read. Vault Wall: a plan is Vault content until the post-season retrospective (0048 door);
# no player or admin view shows a plan, a number or a tell. Roles only, plain words. Headless seeded sims run no plans (0178's own design), so the played path is the measured one.

Feature: NPCs deal with each other, and an NPC HOH reads its deals

  Scenario: Safety is traded for a vote, with a plan to turn
    Given npc deals: a nervous houseguest and the HOH seal a pact in a played game
    And npc deals: the deal-plan planner has the HOH's plan be to break it at the nominations
    When npc deals: the carry-out runs at the nominations and the HOH names the nominees
    Then npc deals: the pact is broken and the former partner is among the nominees
    And npc deals: the lean toward the former partner ends with that week

  Scenario: An NPC HOH's nominations read the deals, weighted by trust
    Given npc deals: an NPC HOH holds a safety deal with two houseguests, one they trust and one they do not
    When npc deals: the NPC HOH names the nominees across many seeds
    Then npc deals: the distrusted houseguest is named more often than the trusted one

  Scenario: A pact sealed between two NPCs gets a secret plan from the deal-plan planner like every deal
    Given npc deals: two NPCs strike a deal off-screen in a played game
    When npc deals: the deal-plan planner runs
    Then npc deals: each side of the pact holds a plan in the plan store
    And npc deals: the deal's event names only those two as witnesses

  Scenario: A kept pact, and a game nobody is playing, keep the protective lean
    Given npc deals: a pact whose HOH holder plans to keep it
    Then npc deals: the HOH's lean toward the partner stays protective after the carry-out
    And npc deals: in a headless game the planner runs nothing and the lean is protective

  Scenario: No view shows an NPC plan or deal while the season is live
    Given npc deals: a played season where NPCs struck deals and one plans to break it
    When npc deals: the days pass until the vote
    Then npc deals: no player or admin view shows the deal, either plan, or any trust figure

  Scenario: The same seed gives the same deals
    Given npc deals: two seasons prepared from the same seed
    When npc deals: each house proposes its week's deals
    Then npc deals: both hold the same deals and plans in the same order

  Scenario: The deals survive a save and a load whole
    Given npc deals: a played season where NPCs struck deals
    When npc deals: the season is saved and loaded into a fresh session
    Then npc deals: the loaded session holds every deal the saved one held
    And npc deals: a later save never holds fewer deals
