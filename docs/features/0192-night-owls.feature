# Feature 0192 - night owls (ORW-620). Design note: 0192-night-owls.md.
# When the house winds down, the few houseguests still awake gather and talk late: scheming, confessing, bonding, sometimes a fight. Sleepers never take part.
# A player who stays up is a night owl too: an awake houseguest may come to them. Every late-night talk is a hidden scene; only someone who is there sees it. Roles only.

Feature: The few who are still up talk late

  Scenario: Late at night the awake few talk, and a quiet house is not a crowd
    Given night owls: a houseguest who is free late at night with two others still awake
    Then night owls: across seasons some of their free hours become a late-night talk, a bounded share, with someone who is awake and where that person is
    And night owls: by day, or in a crowded house, no hour is a late-night talk

  Scenario: Sleepers never take part
    Given night owls: a houseguest who is free late at night and only one other houseguest is awake
    Then night owls: every late-night talk is with that one houseguest
    And night owls: with nobody else awake there is no late-night talk at all

  Scenario: The small hours vary
    Given night owls: a houseguest who is free late at night with two others still awake
    Then night owls: across seasons the talks include confessions, clashes and bonding, and a third houseguest can join

  Scenario: A player who stays up is a night owl too
    Given night owls: a houseguest who is free late at night and the only other one up is the player
    Then night owls: when the player is up the houseguest sometimes seeks them out, and when the player has turned in never

  Scenario: A late-night talk is hidden, and the feature off changes nothing
    Given night owls: a late-night talk the player was not part of
    Then night owls: no player surface and no admin surface shows it
    And night owls: with the feature off no hour is a late-night talk
