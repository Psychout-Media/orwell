# Feature 0150 - beliefs drive decisions at full strength (theme 2, slice 2; ORW-330).
# Design note: 0150-beliefs-drive-decisions.md. Plan: the vault note "Theme 2 Slice Plan", slice 2. Builds on 0149 (the claims core).
# What a houseguest BELIEVES about someone - that they are targeting them, voted against them, lied to them, or are going after them -
# now pushes their nominations, votes and deal consent at the same strength as a goal, and can form a goal, whether the belief is true
# or not. Strength is Ryne's open theme 2 question 2 (recommended: full strength, measured and reported, never a gate); it sits behind
# one seam (`BELIEF_RULES.strength`), and "capped" is the behaviour before this slice. The effect on the house mix, jury reach and
# rumor-driven evictions is measured and reported in the PR, never used as a gate here. Roles only.

Feature: Beliefs drive decisions at full strength

  Scenario: A believed rumor can decide a nomination
    Given seeded houses where the HOH sees two houseguests exactly alike
    And the HOH wrongly believes one of them is targeting them
    When the HOH nominates in each house
    Then the believed threat is the HOH's target more often than the other
    And far more often than when beliefs are capped at their old small tilt

  Scenario: A wrong belief can form a goal, with the belief as its reason
    Given a started season with a person playing
    When a houseguest is told, falsely, by someone they trust that another houseguest voted to evict them
    And their goals are looked at again
    Then they take up a goal against that houseguest, and the reason is what they believe
    And with beliefs capped, no such goal forms

  Scenario: What a houseguest believes stays engine-only
    Given a started season with a person playing
    When a houseguest is told, falsely, by someone they trust that another houseguest voted to evict them
    And their goals are looked at again
    Then no player-facing or admin view shows the belief or the goal it formed
