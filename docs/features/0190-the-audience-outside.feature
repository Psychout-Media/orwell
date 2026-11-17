# Feature 0190 - the audience outside (ORW-624; Ryne OK'd the design 2026-11-17). Design note: 0190-the-audience-outside.md. Flag ORWELL_AUDIENCE (default ON). Roles only.

Feature: The audience outside

  Scenario: An evictee walks out to the crowd's reaction, which the house hears
    Given a played season with the audience on
    And a week where the HOH nominated two houseguests and one was evicted
    When the eviction is over
    Then the evictee walks out to a reaction from the crowd, in words and never a number

  Scenario: The crowd never reacts to what the house could not see
    Given a played season with the audience on
    And a houseguest whose betrayals all happened where the player could not see
    When the eviction is over
    Then the crowd's view of them has not moved, but the recap's has

  Scenario: The player is judged like anyone
    Given a played season with the audience on
    And a week the player won HOH and used the veto
    When the eviction is over
    Then the public thinks better of the player

  Scenario: America's Favorite is named only after the crown
    Given a played season with the audience on
    And a week where the HOH nominated two houseguests and one was evicted
    When the eviction is over
    Then no favorite is named while the season is live
    And after the crown the retrospective names America's Favorite
