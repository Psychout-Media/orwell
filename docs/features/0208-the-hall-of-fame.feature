# Feature 0208 B3 (ORW-665) - the hall of fame (flag ORWELL_SEASON_MEMORY, default ON). Design: 0208-seasons-that-remember.md, "B3 built". Roles only. Executable; the rest of 0208 stays in the spec-only sibling.

Feature: The hall of fame

  Scenario: A finished season is on the record at once and stays after the next one begins
    Given hall of fame: a played season the player finished
    When hall of fame: the next season begins
    Then hall of fame: the hall holds that one season, numbered first

  Scenario: Seasons are added beside each other and never overwritten
    Given hall of fame: two played seasons the player finished in turn
    Then hall of fame: the hall holds both, in order

  Scenario: The hall belongs to one player only
    Given hall of fame: a played season the player finished
    When hall of fame: the next season begins
    Then hall of fame: another player's hall is empty

  Scenario: Nothing hidden reaches the hall
    Given hall of fame: a played season the player finished with a sealed fact in the hidden layer
    Then hall of fame: the sealed fact is nowhere in the hall

  Scenario: Switched off, or never played, nothing is kept
    Given hall of fame: a played season the player finished with the memory switched off
    When hall of fame: the next season begins
    Then hall of fame: the hall is empty
