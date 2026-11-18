# Feature 0200 - your edit (ORW-632; Ryne approved the design 2026-11-17). Design note: 0200-your-edit.md. Flag ORWELL_YOUR_EDIT (default ON). Roles only.

Feature: Your edit

  Scenario: There is no edit before the crown
    Given a played season whose crown has not been given
    Then the retrospective is sealed and there is no edit

  Scenario: After the crown each week is an episode made from real events
    Given a played season whose crown has been given after two weeks of events
    When the season is opened
    Then there is one episode for each completed week, each built from that week's own moments
    And the week with a blindside leads with the blindside

  Scenario: The cut names a hero and a villain from what they did
    Given a played season whose crown has been given after two weeks of events
    And a houseguest who betrayed another again and again
    When the season is opened
    Then that houseguest was cut as a villain

  Scenario: The player is judged honestly
    Given a played season whose crown has been given after two weeks of events
    And a player who broke their deals and blindsided the house
    When the season is opened
    Then the player did not come across as a hero
    And the edit says what the player did, in words and never a number
