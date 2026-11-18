# Feature 0209 - habits and routines from the backstory (ORW-651, Ryne approved 2026-11-17). Design: 0209-habits-and-routines.md. Roles only.
# Each houseguest has two to four routines, each a time, a place and something they do, composed from parts rather than dealt from a menu. A routine decides where they usually are and what they do in a free hour; it slips under stress.
# The player learns a routine only by seeing it on separate days. Nothing about a routine is shown as a number or a record.

Feature: Habits and routines

  Scenario: Routines are composed, two to four each, and differ from person to person
    Given habits: a cast of houseguests of one archetype
    Then habits: each houseguest has two to four routines each a different act, each a time, a place and an act
    And habits: the same houseguest always composes the same routines, and the cast shares no fixed menu

  Scenario: A routine decides where someone usually is
    Given habits: a houseguest with a strong evening routine in the backyard
    Then habits: across days they are in the backyard most evenings, doing it, and never at another time of day
    And habits: when they are on the block or low, they keep it less often

  Scenario: A routine with company is shared only with whoever is already there
    Given habits: a houseguest with a strong evening routine in the backyard and a close friend elsewhere
    Then habits: they never pull the friend in from another room

  Scenario: The player learns a routine by sight, and only then
    Given habits: the player has seen a houseguest keep a routine on separate days
    Then habits: the third separate day makes it something the player knows, and repeats within one day do not

  Scenario: A routine is hidden, and the feature off changes nothing
    Given habits: a played game with routines on and one with them off
    Then habits: no player read shows a routine record or a sighting
    And habits: with the feature off no houseguest has routines
