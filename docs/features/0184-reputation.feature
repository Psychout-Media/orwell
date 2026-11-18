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

  # Part 2b (ORW-564): a close pair fakes distance in public.
  Scenario: A pair faking distance is not read as a pair, except by someone who caught them
    Given a played season with faked distance on
    And two close allies who are hiding it this week
    Then a houseguest who never caught them reads them as less close than before they hid it
    And a houseguest who caught them together still reads them as close

  Scenario: The player can catch a hidden pair, and the player's own ally can hide it too
    Given a played season with faked distance on
    And two close allies who are hiding it this week
    When the pair keeps slipping off in a room the player is in
    Then the player sometimes catches them, as a scene only the player saw
    And a houseguest close to the player who hides it makes the house read the player as less tied to them
