# Feature 0208 B2 (ORW-664) - your reputation walks in (flag ORWELL_SEASON_MEMORY, default ON). Design: 0208-seasons-that-remember.md, "B2 built". Roles only. Executable; the rest of 0208 stays in the spec-only sibling.

Feature: Your reputation walks in before you

  Scenario: Broken word is heard by the house and followed into the next season
    Given reputation: a played season the player finished
    And reputation: several houseguests heard the player went back on their word
    When reputation: the season ends
    Then reputation: the season record carries what share of the house heard it
    And reputation: the player's carried treachery is higher than after a clean season

  Scenario: Only what the house heard counts
    Given reputation: a played season the player finished
    And reputation: the house heard only kind things, and a sealed fact sits in the hidden layer
    When reputation: the season ends
    Then reputation: the season record shows nothing heard
    And reputation: the sealed fact reaches neither the record nor the summary

  Scenario: A new start gets nothing
    Given reputation: a new player with no past season
    Then reputation: the new cast reads them byte-for-byte as before

  Scenario: A returning player arrives warier
    Given reputation: the player returns after a season of broken word
    Then reputation: the new cast reads them as more of a threat than a returning player with a clean name
