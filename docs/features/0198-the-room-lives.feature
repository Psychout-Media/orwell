# Feature 0198 - the people in your room live too (ORW-621). Design note: 0198-the-room-lives.md.
# Houseguests in the player's own room take their goal steps there, in the player's view, as witnessed events the engine decided and the narrator voices.
# The player is never moved or spoken for. Only the act and the manner are shown, never the goal. Bounded per hour. Roles only.

Feature: The people in your room live too

  Scenario: The houseguests with the player act, and the player sees it
    Given room life: a played game with four houseguests in the player's room
    Then room life: some of them take steps there as events the player witnessed, not hidden, and no step is the player's

  Scenario: The room never becomes a stage play
    Given room life: a played game with four houseguests in the player's room
    Then room life: a stretch repeated in the same hour never yields more than the cap, and a houseguest acts once

  Scenario: Nobody is moved and the goal is never shown
    Given room life: a played game with four houseguests in the player's room
    Then room life: nobody leaves the room and no goal or its reason is in the events, the prompt or what the player holds

  Scenario: A goal step shows as a plain word, a clash shows as itself
    Given room life: the sight of a step
    Then room life: a pitch, a plant and a plea all read as a word with someone, while cooking and a confrontation read as themselves

  Scenario: The feature off changes nothing
    Given room life: a played game with four houseguests in the player's room
    Then room life: with the feature off no room step is recorded
