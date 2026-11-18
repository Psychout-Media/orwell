# Feature 0197 - catching a misdirection (ORW-631). Design note: 0197-catching-a-misdirection.md. Pure record rules; the played-game wiring is in tests/unit/catchMisdirection631.test.ts. Roles only.

Feature: A lead a houseguest gave the player is settled by what the player later sees

  Scenario: A lead is not settled the moment it is given
    Given misdirection: a lead naming a room
    When misdirection: the player sees the person in that room on the same tick
    Then misdirection: the lead is still open

  Scenario: The person seen in the named room means the lead held
    Given misdirection: a lead naming a room
    When misdirection: the player sees the person in that room later
    Then misdirection: the lead held

  Scenario: The person seen somewhere else means the lead was wrong
    Given misdirection: a lead naming a room
    When misdirection: the player sees the person in another room later
    Then misdirection: the lead was wrong and the other room is noted

  Scenario: The named room in view without the person means the lead was wrong
    Given misdirection: a lead naming a room
    When misdirection: the player looks into that room later and the person is not there
    Then misdirection: the lead was wrong and no other room is noted

  Scenario: A lead from an earlier day lapses and says nothing
    Given misdirection: a lead naming a room
    When misdirection: the player sees the person in another room on a later day
    Then misdirection: the lead lapsed

  Scenario: A lead found wrong shows only for a few ticks and the record keeps it
    Given misdirection: a lead naming a room
    When misdirection: the player sees the person in another room later
    Then misdirection: the lead shows as found wrong right away
    And misdirection: the lead no longer shows after the notice window
    And misdirection: the record still holds the lead
