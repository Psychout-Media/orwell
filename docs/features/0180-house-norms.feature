# Feature 0180 - house norms (Theme 3 slice 12 part 1, ORW-552). Design note: 0180-house-norms.md.
# The house shuns someone it KNOWS broke their word: what each observer holds, never the hidden truth. Flag ORWELL_HOUSE_NORMS (default ON). Roles only.

Feature: House norms

  Scenario: A houseguest the house knows broke their word twice is shunned by someone who knows
    Given a played season with house norms on
    And an observer who holds that a houseguest lied to two different people
    When the night passes
    Then the observer's read of that houseguest cools
    And the next night, with nothing new, it does not cool again

  Scenario: One known broken word is gossip, not a reason to shun
    Given a played season with house norms on
    And an observer who holds that a houseguest lied to one person
    When the night passes
    Then the observer's read of that houseguest is unchanged

  Scenario: The player who breaks their word is shunned like anyone
    Given a played season with house norms on
    And an observer who holds that the player lied to two different people
    When the night passes
    Then the observer's read of the player cools

  Scenario: Nobody is shunned for a lie no one heard about
    Given a played season with house norms on
    And a houseguest who lied to two people, with no one holding it
    When the night passes
    Then no one's read of that houseguest cools

  Scenario: An honest, loyal house shuns harder than a house of liars
    Given an observer who holds that a houseguest lied to two different people, in an honest, loyal house and again in a house of liars
    When the night passes in each house
    Then the honest house's observer cools more

  Scenario: The shunning never reaches a player or admin view
    Given a played season with house norms on
    And an observer who holds that a houseguest lied to two different people
    When the night passes
    Then no player or admin view carries a norm, a count of broken words or the shunning
