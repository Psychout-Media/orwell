# Feature 0176 - homophily and territory, PART 1: homophily (ORW-561, Theme 3 slice 10). Design note: 0176-homophily-and-territory.md.
# Like attracts like: pairs who share a look, an age, a part of the country, a kind of job or a temperament bond a little faster and sour slower.
# Part 2 (territory, tenure, the HOH room) is pending and has no scenarios here yet. Roles only.

Feature: Houseguests who are alike bond a little faster

  Scenario: Similarity is symmetric and bounded, and a thin card is tolerated
    Given a seeded played house
    Then every pair's similarity is symmetric and between zero and one
    And a houseguest with no job or hometown on file still gets a finite similarity

  Scenario: The pair multiplier never passes the house-culture bound
    Given a seeded played house
    Then every pair's bond multiplier is within the house-culture bound

  Scenario: A like pair warms faster and stings less than an unlike pair
    Given a seeded played house
    When the most alike pair and the least alike pair are found
    Then the alike pair warms faster and stings less than the unlike pair

  Scenario: Homophily off changes nothing
    Given two played houses with the same seed, one with homophily off
    Then with homophily off the valence for any pair is exactly one

  Scenario: Nothing about it is visible
    Given a seeded played house
    Then no surface carries a similarity or a pair multiplier
