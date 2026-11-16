# Feature 0162 - a broken deal lowers the breaker's credibility (ORW-545; theme 2, the owner's Q3 ruling).
# Design note: 0162-broken-deal-credibility.md. A deal is a claim that is only as good as the word of the one who gave it, so a BROKEN deal counts
# against the breaker the way a caught lie does (B48 credibility). Nothing about it is shown to the player: no number, no tell. Roles only.

Feature: Breaking a deal costs the breaker their word

  Scenario: The wronged party believes the breaker's word for less after a broken deal
    Given two houseguests who made a deal in front of two others
    When one of them breaks the deal
    Then the wronged houseguest believes the breaker's word for less than before

  Scenario: Those who watched the deal made count the break too, at a lower weight
    Given two houseguests who made a deal in front of two others
    When one of them breaks the deal
    Then each onlooker believes the breaker's word for less than before
    And each onlooker believes it for more than the wronged houseguest does

  Scenario: A deal that was kept costs the keeper nothing
    Given two houseguests who made a deal in front of two others
    When the deal is kept to the letter
    Then nobody believes the keeper's word for less than before

  Scenario: Someone who never saw the deal is unaffected, and only the breaker pays
    Given two houseguests who made a deal in front of two others
    When one of them breaks the deal
    Then a houseguest in another room still believes the breaker in full
    And the wronged houseguest still believes everyone else in full

  Scenario: A break never raises anyone's belief in the breaker
    Given two houseguests who made a deal in front of two others
    When one of them breaks the deal
    Then no houseguest believes the breaker's word more than before

  Scenario: Counting the same break twice counts it once
    Given two houseguests who made a deal in front of two others
    When one of them breaks the deal
    And the same break is counted a second time
    Then every houseguest's belief in the breaker is exactly what it was after the first count

  Scenario: Nothing about it reaches the player as a number or a tell
    Given two houseguests who made a deal in front of two others
    When one of them breaks the deal
    Then no player or admin view carries a credibility figure or a caught-lie marker

  Scenario: The break changes no relationship, only what is believed
    Given two houseguests who made a deal in front of two others
    Then the same break with the lies-caught layer off leaves every relationship exactly as it is with it on
