# Feature 0189 - the jury house has a life (ORW-618). Design note: 0189-jury-house-life.md. Engine-only state change, no text. Roles only.

Feature: Jurors compare notes, find out who lied to whom, and arrive at the finale changed

  Scenario: A juror passes on what they themselves hold
    Given a juror who holds that a finalist lied to them
    When the jurors compare notes and the teller is open
    Then another juror comes to hold it at a slightly lower confidence

  Scenario: The sealed ballot is never passed on
    Given a juror who holds a read of who voted against them
    When the jurors compare notes and the teller is open
    Then nothing is passed on

  Scenario: A guarded juror passes things on less often than an easygoing one
    Given a juror who holds that a finalist lied to them
    When the jurors compare notes many times with a guarded teller and with an easygoing teller
    Then the easygoing teller passes more on

  Scenario: A juror who hears of a quiet break learns of it once and their trust in the breaker drops
    Given a played game whose jury has a juror wronged by a finalist's quiet deal break
    When another juror tells them the finalist lied
    Then the wronged juror has learned of the break and trusts the finalist less

  Scenario: Nothing changes in a game nobody plays
    Given an unplayed game whose jury has a juror who holds that a finalist lied to them
    When the jury house runs its stretches
    Then no juror is told anything

  # Part 2: the player as a juror, both directions, through the existing claim machinery (no new tool, read or projection).

  Scenario: Claims pass only between jurors
    Given a game where the player holds a juror's seat
    Then a juror and the player can tell each other things
    But nobody still in the house can tell, or be told by, a juror or the player

  Scenario: With the player still in the house nothing passes either way
    Given a game where the player is still in the house and a juror holds a belief
    Then no juror tells the player anything and the player can tell no juror anything

  Scenario: A juror tells the player only what they hold, as a certainty band
    Given a game where the player holds a juror's seat and a juror holds a belief
    When that juror confides in the player
    Then what the player hears has only the kind, the names and a certainty band

  Scenario: The sealed ballot is never what a juror says
    Given a game where the player holds a juror's seat and a recorded ballot but no juror holds a belief
    Then no juror tells the player anything

  Scenario: The player's own words reach a juror and a false one is on the record
    Given a game where the player holds a juror's seat
    When the player tells a juror something false in their own words
    Then the juror holds it as told by the player and it is a lie on the record
