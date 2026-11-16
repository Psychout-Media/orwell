# Feature 0159 - the season house culture, slice 1: the foundation (ORW-551). Design note: 0159-house-culture.md.
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

  Scenario: No culture, no change
    Given two played seasons with the same seed, one with house culture off and one whose culture has no leans
    Then they are identical

  Scenario: A drawn culture leans the house dials a little, never past the bound
    Given a gossip-mill culture and a powder-keg culture
    Then the gossip rate and the friction rate rise over no culture, and no baseline moves by more than a factor of 1.35

  Scenario: A game nobody played gets no culture
    Given a season that nobody has played
    Then the season holds no culture

  Scenario: After the crown the retrospective describes it in plain words only
    Given a season where a person has started playing
    When the season is played through to its crown
    Then the retrospective describes the house in plain words, one phrase per lean, with no name, weight or number

  Scenario: The relationship dials lean the right way and stay bounded
    Given a paranoid culture, a ride-or-die culture, a majority-bloc culture, a powder-keg culture and a one-big-family culture
    Then the paranoia, loyalty, alliance-size, meeting and bonding dials each rise over no culture, and none moves by more than a factor of 1.35
