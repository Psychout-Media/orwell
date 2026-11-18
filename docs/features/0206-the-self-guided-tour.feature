# Feature 0206 - the self-guided tour (ORW-654). Design note: 0206-the-self-guided-tour.md.
# After walking in, the player explores the house freely; the houseguests mostly gather in the common area with a few wandering; the first entry into each room is a one-time card; then production calls the circle. Roles only.

Feature: The self-guided tour at move-in

  Scenario: The player is free once they have walked in, and not before
    Given tour: a played premiere where the player has not yet walked in
    Then tour: a move is refused until the player's own entrance and allowed after it

  Scenario: The circle is called after the tour
    Given tour: a played premiere with everyone inside
    Then tour: the next advance calls the circle and the player is in the living room

  Scenario: The houseguests gather in the common area with a few wandering
    Given tour: several played premieres with everyone inside
    Then tour: most houseguests stand in the common area and only a bounded few are elsewhere

  Scenario: The room card fires once per room
    Given tour: a played premiere with the player inside
    Then tour: the first entry into a room hands over a card once and a second entry does not

  Scenario: Beds wait for the circle and the premiere still beds everyone once
    Given tour: a played premiere run through the tour and the bed rush
    Then tour: no bed is claimed on the tour and sixteen distinct beds end owned

  Scenario: Switched off, the premiere is held as before
    Given tour: a played premiere with the tour off
    Then tour: the player is held through the entrances and no tour record is saved
