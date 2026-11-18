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

  # Part 2a (ORW-564): social roles, read from what each houseguest saw and was told, and voiced as gossip (Ryne's Q3 ruling: labels said in their own words, never shown).
  Scenario: A role emerges from what the observer saw, and only for those who saw it
    Given a played season with social roles on
    And a houseguest the observer saw start several fights
    Then the observer reads that houseguest as the house villain
    And a houseguest who saw none of it reads no role in them

  Scenario: A role travels as gossip, and can be wrong
    Given a played season with social roles on
    And a houseguest the observer saw start several fights
    When the observer passes their read on in a scene with nothing else to tell
    Then the listener holds it as talk about that houseguest, from the observer
    And whether it is true is the engine's own read of the record, never the speaker's

  Scenario: The player is read and talked about like anyone
    Given a played season with social roles on
    And the player starting several fights the observer saw
    Then the observer reads the player as the house villain
    And a houseguest who heard it may tell the player what the house thinks of them, as gossip in their own words
