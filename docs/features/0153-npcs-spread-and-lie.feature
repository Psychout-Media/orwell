# Feature 0153 - NPCs spread and lie on purpose (theme 2, slice 3; ORW-330).
# Design note: 0153-npcs-spread-and-lie.md. Plan: the vault note "Theme 2 Slice Plan", slice 3. Builds on 0149 (claims) and 0150 (beliefs drive decisions).
# The house-life speech actions that were only labels become real claims the engine decides: PLANT (a lie told to someone), LEAK (a true
# thing passed on), CONFIRM (backing up what the listener already believes), FISH (asking what someone knows - the listener answers with
# what they believe). The engine picks what is said from the fixed claim set and checks it against its own truth (goals, ballots, deals);
# the narrator never decides it. Off-screen between NPCs (Ryne's Q4, assumed yes); the player hears only claims told to them. Roles only.

Feature: NPCs spread and lie on purpose

  Scenario: Planting a story makes a real false belief
    Given a played season where a houseguest wants a rival out
    When they plant a story with another houseguest
    Then the listener believes the story, sourced to the planter
    And the engine knows the story is false

  Scenario: A misinformation campaign targets the people who decide
    Given a played season where a houseguest wants a nominee evicted
    When their lies go out over a day
    Then the people they lie to are voters this week, never the nominees or the HOH

  Scenario: Something only leaks from someone who holds it
    Given a played season with beliefs on
    When a houseguest who believes nothing about a houseguest leaks about them
    Then nothing is told as true
    And a houseguest who does hold a belief can pass it on, as what they believe

  Scenario: What is said off-screen never reaches the player unheard
    Given a played season where a houseguest wants a rival out
    When they plant a story with another houseguest
    Then the claims the narrator may voice are still empty
