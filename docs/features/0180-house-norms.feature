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

  # Part 2 - bandwagons and dissent: what each voter heard, never anyone's ballot.
  Scenario: A waverer joins the side they heard the house is on
    Given a played season with house norms on
    And a voter torn between two nominees
    When they have heard that most of the house is going after one of them
    Then they vote with the house
    And a voter with a strong reason of their own keeps it

  Scenario: A lone dissent in a lopsided vote is noticed by a majority voter who heard of it
    Given a played season with house norms on
    And a lopsided eviction where one houseguest voted the other way, and a majority voter heard about it
    When the night passes
    Then the majority voter's read of the dissenter cools, once

  Scenario: The player who tells the house they voted against it is noticed like anyone
    Given a played season with house norms on
    And a lopsided eviction where the player voted the other way, and a majority voter heard about it
    When the night passes
    Then the majority voter's read of the player cools
