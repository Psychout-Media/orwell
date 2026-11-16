# Feature 0162 - the season house culture, slice 1: the foundation (ORW-551). Design note: 0162-house-culture.md.
# A played season draws a loose seeded blend of a few culture leans, stored engine-only. Nothing reads it yet, so no dial moves. Revealed only after
# the crown, in plain words. Roles only.

Feature: A played season carries a hidden house culture

  Scenario: A played season draws a blend of two or three leans, once
    Given a season where a person has started playing
    Then the season holds a culture of two or three distinct leans whose weights sum to one
    And playing on does not change it

  Scenario: The culture is saved and comes back whole
    Given a season where a person has started playing
    When the season is saved and loaded
    Then the loaded season holds the same culture

  Scenario: Nothing about the culture is visible while the season is live
    Given a season where a person has started playing
    Then no player or admin view shows a lean, a weight or the culture

  Scenario: Turning it on changes nothing else
    Given two played seasons with the same seed, one with house culture on and one off
    Then they are identical apart from the culture itself

  Scenario: A game nobody played gets no culture
    Given a season that nobody has played
    Then the season holds no culture

  Scenario: After the crown the retrospective describes it in plain words only
    Given a season where a person has started playing
    When the season is played through to its crown
    Then the retrospective describes the house in plain words, one phrase per lean, with no name, weight or number
