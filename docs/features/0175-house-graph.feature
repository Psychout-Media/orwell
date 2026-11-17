# Feature 0175 - the house graph (Theme 3, core 1; the graph half, built by Overseer B). Design note: 0175-house-graph.md.
# Engine-only reads derived from the bonds: cliques, hubs, loners, brokers. Never shown, no numbers, no surface. Pure and not yet wired
# (wiring waits for the bond read API on ORW-552). Roles only.

Feature: The house graph reads the shape of the house from its bonds, for the engine's eyes only

  Scenario: The house graph finds a broker
    Given a house graph with a close group of "m1,m2,m3"
    And a house graph with a close group of "m4,m5,m6"
    And a house graph where "m7" is close to each of "m1,m2,m3,m4,m5,m6"
    When the house graph is derived
    Then the house graph reads "m7" as a broker
    And the house graph reads "m1" as not a broker

  Scenario: A houseguest with no ties is a loner
    Given a house graph with a close group of "m1,m2,m3"
    And a house graph member "m4" with no ties
    When the house graph is derived
    Then the house graph reads "m4" as a loner
    And the house graph reads "m1" as not a loner

  Scenario: A houseguest with many ties is a hub
    Given a house graph where "m1" is close to each of "m2,m3,m4,m5,m6"
    When the house graph is derived
    Then the house graph reads "m1" as a hub

  Scenario: A lopsided bond is not a tie
    Given a house graph where "m1" leans hard on each of "m2,m3" but they do not lean back
    When the house graph is derived
    Then the house graph finds no cliques

  Scenario: The same house reads the same in any order
    Given a house graph with a close group of "m1,m2,m3"
    And a house graph where "m4" is close to each of "m2,m3"
    When the house graph is derived twice, once with the input order reversed
    Then the two house graph reads are identical

  Scenario: Nothing in the house graph reaches the player
    Then the house graph output has only engine-side groupings and no numbers
    And no player, admin or tool surface imports the house graph

  Scenario: Bad input never throws
    Given a house graph with no members
    When the house graph is derived
    Then the house graph finds no cliques
    And a house graph with unknown ids, self-ties and NaN strengths still derives
