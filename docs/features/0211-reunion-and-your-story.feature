# Feature 0211 - the reunion and the story of you and them (Ryne approved both 2026-11-17). Design: 0211-reunion-and-your-story.md. Roles only.

Feature: The reunion and the story of you and them

  # ORW-649
  Scenario: The reunion happens after the crown and can air what was hidden
    Given a winner has been crowned
    Then the evicted houseguests return for a reunion scene with the finalists
    And rivals with the biggest grudges confront each other, the player included either way
    And lies never caught in the game come out in front of the people they were told to
    And alliances hidden from someone are explained
    And none of it is said before the crown

  Scenario: The player takes part in their own words
    Given the player is part of a confrontation or a lie coming out
    Then the player answers in their own words, and the engine never speaks for the player

  # ORW-648
  Scenario: Each houseguest has a story with the player
    Given a finished season whose houseguests held a view of the player
    Then for each houseguest there is a story of them and the player: how they met, the turning points, and how it ended
    And its shape follows how their view of the player really moved, warmed, cooled, turned or steady
    And no number is shown
