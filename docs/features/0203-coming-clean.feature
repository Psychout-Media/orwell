# Feature 0203 - coming clean, nuanced (Ryne 2026-11-17). Design: vault note "Coming Clean Spec 0203". Roles only.

Feature: Coming clean, nuanced

  Scenario: Confessing a lie first costs less than being caught
    Given a houseguest who told a listener something false
    When they confess it to that listener before it is caught
    Then the listener trusts them less, but less than if they had caught the lie
    And the listener no longer believes what they were told
    And the listener holds no "lied to me" against them

  Scenario: Looping an ally in on a lie told to someone else
    Given a houseguest who told one person something false
    When they tell an ally the truth about it
    Then the ally trusts them a little more
    And the ally knows they lied to that person, and can pass it on
    And if it travels back to the person lied to, that person catches the lie the usual way

  Scenario: Different versions to different people, tracked claim by claim
    Given a houseguest who told two people different false versions about the same houseguest
    When they confess to one and loop an ally in on the other
    Then the engine knows which person heard which version, who was told the truth, and who was looped in
    And the retrospective shows each version and what became of it

  Scenario: A houseguest comes clean when they see the risk
    Given a houseguest whose lie is at risk of being caught: the listener doubts it, or another version reached someone close to them
    Then they are more likely to confess first, more so the more candid they are

  Scenario: The player can do all of this, and it is done to the player
    Given the player told a houseguest something false
    When the player confesses it, or tells an ally the truth about it
    Then the houseguest and the ally react as they would to anyone
    And a houseguest who lied to the player may confess it to the player, or loop someone else in about it
