# ORW-339 (theme 1, NPC minds; design approved by Ryne 2026-11-12) - the promises of ORW-253 slices 3, 4 and 6 and the pre-show tie natures (ORW-329), stated as scenarios.
# Status: BUILT and BDD-wired. Before this file these were proven only in unit files (houseLife.test.ts, houseLifeLive.test.ts, goalMoodLive.test.ts, npcMemoryAboutOthers.test.ts, npcMindsEndgameLive.test.ts,
# agenda.test.ts); the steps (features/step_definitions/npc_minds_house_life.steps.ts) drive the REAL runtime or the real engine functions. Roles only: holder, target, rival, ally, juror, HOH.

Feature: Houseguests live their own lives

  Scenario: Once a person plays, the house lives by the hour and no stock scene remains
    Given a played season with the house awake
    When the house lives through several hours
    Then every awake houseguest outside the player's room acts at most once an hour
    And every scene they make is a house-life action, never a stock scene

  Scenario: Someone after a target confronts them when they share a room, a hothead more than a peacemaker
    Given a holder who wants a target gone and shares a room with them
    When the hours pass for a hothead and for a peacemaker
    Then the hothead confronts the target on many hours
    And the peacemaker confronts them far less

  Scenario: Recruiting is strategy talk until the alliance exists
    Given a holder pitching someone who is not their ally
    Then the pitch counts as strategy talk
    And the same pitch to an ally counts as alliance talk

  Scenario: A plan that works lifts the mood, and the cause is told only to the trusted
    Given a holder who wants a target gone
    When the holder's target is evicted
    Then the holder's mood is lifted and the cause is recorded in their own words
    And the holder tells that cause to a player they trust but not to one they do not

  Scenario: Houseguests bring up what others did, but only what the whole house saw
    Given a holder who remembers a public thing a houseguest in the room did to them, and a private deal gone wrong
    Then they bring up the public thing with that houseguest's public name
    And the private deal never reaches the narrator's view of them

  Scenario: A juror's style follows their character
    Given a played season
    Then every houseguest's juror style comes from their own character and the player has none

  Scenario: A strategist Final HOH cuts the ally they would lose to; a loyalist keeps them
    Given a Final 3 where the HOH's ally is beloved by the jury and their rival is disliked
    When a strategist is the HOH and when a loyalist is the HOH
    Then the strategist evicts the beloved ally
    And the loyalist evicts the rival

  Scenario: Pre-show ties behave by their nature
    Given a houseguest with a pre-show tie
    Then a rival is a target from day one
    And family is protected hard through any number of quiet nights
    And an old friend's protection gives way when they become a real threat
    And an ex is neither protected nor targeted and is avoided in free time
