# spec-only: Theme 3 draft scenarios, not built and not wired into the BDD gate; they wait for the owner's approval of the Theme 3 plan (the vault "Theme 3 Slice Plan").
# Feature 0163 - deals between NPCs and the HOH deal (Theme 3 slice 2; Theme 3 Slice Plan, owner B). SCENARIOS DRAFTED, NOT BUILT.
# Design note: 0163-npc-deals-and-hoh-deal.md. Rests on the owner's 2026-11-16 rulings: Q1 (the engine decides the substance, the narrator keeps the words),
# Q3 (fake deals carry no built-in tell; a low-trust deal weighs less), Q4 (NPC to NPC from the start) and the Theme 3 ruling (deepen social systems).
# Each side of a deal holds its OWN secret plan (keep, break at the vote, flip once safe). Vault Wall: a plan is Vault content until the post-season
# retrospective (0048 door); no player or admin view shows a plan, a number or a tell. Roles only, plain words.

Feature: NPCs deal with each other, and an NPC HOH reads its deals

  Scenario: Safety is traded for a vote, with a plan to turn
    Given a deals season where a nervous houseguest trades the HOH their vote for safety
    And that houseguest's own plan is to turn on the HOH once safe
    When that houseguest wins the next HOH
    Then they nominate the former HOH

  Scenario: An NPC HOH's nominations read the deals, weighted by trust
    Given a deals season where an NPC HOH holds a safety deal with two houseguests, one they trust and one they do not
    When the NPC HOH names the nominees
    Then the distrusted houseguest is more likely to be named than the trusted one, across seeds

  Scenario: Each side of an NPC deal holds its own plan
    Given a deals season where two NPCs strike a deal off-screen
    Then each side holds its own plan, and the two plans can differ
    And the deal's event names only those two as witnesses

  Scenario: No view shows an NPC plan or deal while the season is live
    Given a deals season where two NPCs strike a deal off-screen and one plans to break it
    When the deals days pass until the vote
    Then no player or admin view shows the deal, either plan, or any trust figure
    And the player learns of the deal only if told or if they overheard it

  Scenario: The same seed gives the same deals, and the mix stays balanced
    Given a deals season played twice from the same seed
    Then both runs hold the same deals and plans in the same order
    And across many seeds the share of broken deals sits inside the reported mix band
    And the jury reach and the gradient are no worse than before

  Scenario: The deals and plans survive a save and a load whole
    Given a deals season where one NPC deal was kept and one was broken
    When the season is saved and loaded into a fresh session
    Then the loaded session holds every deal and plan the saved one held
    And a later save never holds fewer deals or plans than an earlier one
