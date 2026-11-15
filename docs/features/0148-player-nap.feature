# spec-only: this .feature is a design contract, NOT wired into the BDD gate yet (absent from cucumber.cjs paths; no step definitions). The build card ORW-417 wires it in and removes this line. (TEST-3, #628)
@spec
Feature: 0148 — the player's nap
  The player may choose a daytime nap. Time moves on, the house keeps living, and every two hours of nap halve the
  sleep deficit the player carries, never to zero. A scheduled event always wakes them. Houseguests do not nap yet.
  (Ryne, 2026-11-15.) Roles only.

  Background:
    Given a played game with the in-game clock running
    And the player stayed up until 4am last night

  Scenario: Two hours of nap halve the deficit the competition reads
    Given it is the morning
    When the player naps for 2 hours
    Then the player's rest term in a competition is half of what it was before the nap
    And the in-game clock has moved on by 2 hours

  Scenario: Every further two hours halve what is left, and it never reaches zero
    Given it is the morning
    When the player naps for 2 hours, wakes, and naps for 2 hours again
    Then the player's rest term is a quarter of what it was before the first nap
    And it is still greater than zero

  Scenario: A shorter nap helps less
    Given it is the morning
    When the player naps for 1 hour
    Then the player's rest term is between half and the full amount it was before the nap

  Scenario: A night in bed resets the nap credit along with the night
    Given the player napped 2 hours today
    When the player goes to bed at midnight and wakes the next morning
    Then the player's rest term is what a midnight bedtime gives, with no nap factor carried over

  Scenario: A scheduled event always wakes the player
    Given it is the morning of the veto competition, one hour before it is due
    When the player naps for 3 hours
    Then the nap ended when the competition came due, after 1 hour
    And only that 1 hour counts toward the deficit
    And the competition proceeds with the player in it

  Scenario: A nap never runs into the night
    Given it is late afternoon, one hour before the evening
    When the player naps for 3 hours
    Then the nap ended at the start of the evening
    And the night has not ended: only going to bed ends it

  Scenario Outline: A nap is refused when it is not the player's time to sleep
    Given <situation>
    When the player tries to nap
    Then the nap is refused with an in-fiction reason
    And the in-game clock has not moved

    Examples:
      | situation                                   |
      | it is the evening                           |
      | a competition is in session                 |
      | a decision is waiting on the player         |
      | it is the premiere                          |

  Scenario: The house keeps living while the player sleeps, unseen
    Given it is the afternoon
    When the player naps for 2 hours
    Then off-screen house-life scenes happened during the nap
    And every one of them is hidden and has no player in its witness set
    And the player's knowledge gained nothing from them

  Scenario: Houseguests who see the player napping remember it
    Given a houseguest walks into the player's bedroom during the nap
    Then that houseguest witnessed the player napping, as a public fact
    And a houseguest who never saw it holds no such fact

  Scenario: The deficit is never shown
    When the player naps for 2 hours
    Then no player-facing or admin view carries a rest number or the nap factor

  Scenario: Houseguests do not nap
    When many afternoons pass in played games
    Then no houseguest ever naps

  Scenario: With the feature off nothing changes
    Given the nap feature is off
    When the player tries to nap
    Then the nap is refused as not available
    And a headless seeded season is byte-identical to one with the feature on and no nap taken
