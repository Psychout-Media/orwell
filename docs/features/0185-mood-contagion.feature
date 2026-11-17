# Feature 0185 - mood contagion (Theme 3 slice 15). Design note: 0185-mood-contagion.md. Engine-only: moves the existing mood, adds no text. Roles only.

Feature: A shocking eviction rattles the evictee's close allies most and the house a little

  Scenario: A close ally is rattled more than a stranger, and a stranger a little
    Given a house where "ally" is close to the "evictee" and "stranger" is not
    When the evictee is shockingly evicted
    Then "ally" catches more of the mood than "stranger"
    And "stranger" catches some of the mood

  Scenario: A friend of an ally catches more than a stranger
    Given a house where "ally" is close to the "evictee" and "friend" is close to "ally" only
    When the evictee is shockingly evicted
    Then "ally" catches more of the mood than "friend"
    And "friend" catches more of the mood than "stranger"

  Scenario: An expected exit spreads nothing
    Given a house where "ally" is close to the "evictee" and "stranger" is not
    When the evictee is evicted with no shock
    Then nobody catches any of the mood

  Scenario: A big win lifts the winner's circle
    Given a house where "ally" is close to the "evictee" and "stranger" is not
    When the evictee wins and the win mood spreads
    Then "ally" catches more of the mood than "stranger"
