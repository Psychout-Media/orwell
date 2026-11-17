# Feature 0183 - private habits and group identity, parts a and b (ORW-566, Theme 3 slice 7). Design note: 0183-private-habits-and-group-identity.md.
# Two close allies keep a spot of their own and meet there after ceremonies; a third houseguest who sees it starts to suspect them; an alliance is named from the
# house's own words. All hidden: nothing shows as a number, a roster or a label. Roles only.

Feature: Close pairs keep private habits and the house names its groups

  Scenario: A close pair meets at their own spot after a ceremony
    Given two close allies, one already at their spot, in the hours after a ceremony
    Then across seasons the pair meet there for a debrief

  Scenario: Not outside the window, not for a pair who are not close, not with the feature off
    Given two close allies, one already at their spot, long after the last ceremony
    Then across seasons the pair never meet there
    And two houseguests who are not close never keep a habit even right after a ceremony
    And with the feature off the pair never meet there

  Scenario: A third houseguest who sees it reads the pair as close
    Given two close allies who meet at a public spot while a third houseguest is in the room
    Then the third houseguest reads the pair as closer than a houseguest who did not see it

  Scenario: An alliance is named from the house's own words, and keeps today's name without them
    Given a house that has authored a nickname for a room
    Then an alliance founded in that room takes the nickname
    And a house with no authored words keeps the stock name

  Scenario: Nothing about it is visible while the season is live
    Given two close allies who have kept their habit
    Then no player or admin view shows a habit, a spot key or a group identity
