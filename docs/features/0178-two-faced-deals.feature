# Feature 0178 - two-faced deals (Theme 3 slice 1, ORW-552; Ryne approved the Theme 3 plan 2026-11-17).
# Design note: 0178-two-faced-deals.md. Code: src/engine/dealPlans.ts (pure), the adapter's planAndCarryOutDeals / flipsAtThisVote.
# When a houseguest agrees to a deal, the engine gives them a SECRET PLAN for it: keep it; keep it this week only; break it at a chosen moment; flip at the vote;
# or cut at the final three. The plan comes from their read of the other party, their own goals and push, the price of being known as a liar, their temperament
# and the house culture. Ryne's Q1: how often depends on the person, the bond and the culture, with no cap; a houseguest who makes many deals leans toward
# breaking them. Ryne's Q2: the player's own promises are kept on record beside the plans. The plans are engine-only: no view shows one until the crown, and
# the narrator is never told. Flag ORWELL_DEAL_PLANS (default ON; =0 = no plans). Roles only.

Feature: Two-faced deals

  Scenario: A houseguest who has made many deals plans to break the next one
    Given a played season with deal plans on
    And a houseguest who has made a great many deals this season
    When they agree to keep the player safe
    Then the engine gives them a secret plan to break it

  Scenario: A plan to break a promise is carried out when its moment comes
    Given a played season with deal plans on
    And a houseguest whose secret plan is to break their safety deal with the player at this week's nominations
    When the nominations come
    Then the deal is broken by that houseguest, quietly
    And their plan is recorded as carried out

  Scenario: A plan to flip turns the deal against the player at the vote
    Given a played season with deal plans on
    And a houseguest whose secret plan is to flip their vote deal with the player at this week's vote
    When the vote comes
    Then the deal pushes that houseguest to vote the player out, not to keep them

  Scenario: The plans stay secret until the crown, then the retrospective shows them beside the player's own promises
    Given a played season with deal plans on
    And a houseguest whose secret plan is to break their safety deal with the player at this week's nominations
    And the player has promised a houseguest, aloud, to keep them off the block
    Then no player or admin view shows a plan while the season is live
    When the season is crowned
    Then the retrospective shows the houseguest's plan for the deal, and how it went
    And it shows the player's own promises, each with whether it was kept
