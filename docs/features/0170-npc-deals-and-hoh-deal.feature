# Feature 0170 - deals between NPCs and the HOH deal (Theme 3 slice 2; Theme 3 Slice Plan, owner B). BUILT behind ORWELL_NPC_DEALS (default ON; =0 is byte-identical to before).
# Design note: 0170-npc-deals-and-hoh-deal.md. Rests on the owner's 2026-11-16 rulings: Q1 (the engine decides the substance, the narrator keeps the words),
# Q3 (fake deals carry no built-in tell; a low-trust deal weighs less), Q4 (NPC to NPC from the start) and the Theme 3 ruling (deepen social systems).
# Each side of a deal holds its OWN secret plan (keep, break at the nominations or the vote, cut at the final three). Vault Wall: a plan is Vault content until the post-season
# retrospective (0048 door); no player or admin view shows a plan, a number or a tell. Roles only, plain words.
# The plan store is the slice-1 owner's (injected read side `PlanSource.planOf`, optional write hook); these steps inject a stand-in for both.

Feature: NPCs deal with each other, and an NPC HOH reads its deals

  Scenario: Safety is traded for a vote, with a plan to turn
    Given npc deals: a nervous houseguest trades the HOH their vote for safety
    And npc deals: that houseguest's own plan is to turn on the HOH once safe
    When npc deals: that houseguest wins the next HOH and names the nominees
    Then npc deals: the former HOH is among the nominees

  Scenario: An NPC HOH's nominations read the deals, weighted by trust
    Given npc deals: an NPC HOH holds a safety deal with two houseguests, one they trust and one they do not
    When npc deals: the NPC HOH names the nominees across many seeds
    Then npc deals: the distrusted houseguest is named more often than the trusted one

  Scenario: Each side of an NPC deal holds its own plan
    Given npc deals: two NPCs strike a deal off-screen
    Then npc deals: each side's plan was handed to the plan store, and the two plans can differ
    And npc deals: the deal's event names only those two as witnesses

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
