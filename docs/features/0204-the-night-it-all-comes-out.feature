# Feature 0204 - the night it all comes out (ORW-647; Ryne approved the idea 2026-11-17). Design note: 0204-the-night-it-all-comes-out.md. Flag ORWELL_SECRET_BREAKS (default ON). Roles only.

Feature: The night it all comes out

  Scenario: A secret held by enough of the house breaks in front of the room
    Given a secret break: a played house where most of the others hold a fact about one houseguest
    When a secret break: the nights pass
    Then a secret break: it broke once, as a house event the whole room witnessed, and everyone present holds it
    And a secret break: it never breaks twice

  Scenario: A pressured, volatile subject blows up their own secret; a calm one does not
    Given a secret break: a volatile subject on the block whose fact is closing in
    When a secret break: the nights pass
    Then a secret break: the subject blew it up themselves
    Given a secret break: a calm subject whose fact is closing in
    When a secret break: the nights pass
    Then a secret break: nothing broke

  Scenario: The consequences land through the existing stores and stay bounded
    Given a secret break: a played house where most of the others hold a fact about one houseguest
    When a secret break: the nights pass
    Then a secret break: the room thinks less of the subject by a small bounded amount, and a houseguest kept out holds a grudge

  Scenario: The player is never spoken for and the wall holds
    Given a secret break: a played house where the others hold a fact about the player and one unspoken fact about someone else
    When a secret break: the nights pass
    Then a secret break: the room's line is about the player only, the unspoken fact appears nowhere, and the player was not made a holder

  Scenario: Switched off, or never played, nothing happens
    Given a secret break: a played house with the feature switched off
    Then a secret break: nothing breaks and nothing is saved
