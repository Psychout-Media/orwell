# Feature 0194 - moods with more causes (ORW-626). Design note: 0194-moods-with-more-causes.md. Engine-only; a cause is told only when the houseguest chooses to. Roles only.

Feature: A houseguest's mood can have a cause beyond a settled goal, and they say it only when they trust the listener

  Scenario: Of several causes this week the heaviest is the one they would give
    Given mood causes: a houseguest with the causes "won" and "lied-to" this week
    Then mood causes: the cause they would give is "lied-to"

  Scenario: Causes from another week do not count
    Given mood causes: a houseguest with the causes "lied-to" this week
    When mood causes: a new week begins
    Then mood causes: the houseguest has no cause to give

  Scenario: A cause that points at a grudge needs more trust than a plain one
    Given mood causes: a listener of middling trust and a candid houseguest
    Then mood causes: a "won" cause may be said
    And mood causes: a "lied-to" cause may not be said

  Scenario: A bad night and a close friend are read from hidden facts only
    Then mood causes: a late night of two in the morning is a bad night
    And mood causes: an early night is not
    And mood causes: a bond of high trust and affinity is a close friend
    And mood causes: a cool bond is not
