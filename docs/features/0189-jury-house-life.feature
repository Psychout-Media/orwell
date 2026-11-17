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
