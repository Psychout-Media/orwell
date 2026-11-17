# Feature 0184 - reputations as one houseguest holds them (Theme 3 slice 8, part 1). Design note: 0184-reputation.md. Engine-only: nothing is shown. Roles only.

Feature: A houseguest heard to be a snake is believed less by those who heard it

  Scenario: A reputation is held by those who heard it and nobody else
    Given a houseguest the observer has heard lying and turning on people
    Then the observer holds that houseguest at a lower standing than one with no record
    And another houseguest who heard nothing holds them at full standing

  Scenario: A kept promise softens a bad name but never clears it
    Given a houseguest the observer has heard lying and turning on people
    When the houseguest keeps promises to the observer
    Then the standing is higher than before
    And the standing is still below full

  Scenario: A bad name composes with a caught lie and never reaches zero
    Given a houseguest the observer has heard lying and turning on people
    Then the observer's credit for the houseguest's word is the bounded product of credibility and standing
