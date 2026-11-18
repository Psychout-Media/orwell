# Feature 0205 - meet the cast (ORW-653). Design note: 0205-meet-the-cast.md.
# The champagne circle is the meet-the-cast moment: official introductions and first impressions, nothing before the player walks in. Roles only.

Feature: The champagne circle as meet-the-cast

  Scenario: Nothing is introduced before the circle is called
    Given meet the cast: a played premiere
    Then meet the cast: no introduction is recorded through the entrances and the tour and the record opens when the circle is called

  Scenario: Everyone is introduced once and met by the end of the circle
    Given meet the cast: a played premiere
    Then meet the cast: the circle introduces every houseguest exactly once and marks them met

  Scenario: First impressions are deterministic, hidden and small
    Given meet the cast: a played premiere
    Then meet the cast: the same seed gives the same hidden reads and the narrator facts carry no number

  Scenario: Switched off, the circle is the old one
    Given meet the cast: a played premiere with the flag off
    Then meet the cast: no introduction record or manner exists
