# Executable spec — Feature 0119 (Phase 3, final, of the in-game-time pivot). Seeded engine only, roles
# only, no cast names. In-game time ONLY — never the real-world clock.
#
# Each event costs its own felt slice of the in-game day (a quick ceremony vs a long competition) instead
# of a flat +3h, while the seeded outcome and the clock-off path stay byte-identical.

Feature: Different events cost different amounts of the in-game day

  A resolved beat advances the in-game clock by its OWN felt duration — a nomination or veto ceremony is
  quick, a competition is long, an eviction sits in between — so the day fills up at a lived rate. This is
  pure presentation: it never changes who wins, and when the per-conversation clock is off (the calibration path)
  every beat keeps the flat default.

  Scenario: A quick ceremony costs less of the day than a competition
    When the felt durations of the ceremony and competition beats are read
    Then a ceremony advances the in-game clock by fewer hours than a competition
    And an inert presentation beat has no distinct felt duration

  Scenario: The felt duration never changes who wins
    Given a seeded season played with the per-beat clock at its flat default
    And the same seeded season played with the variable felt durations available
    When both seasons are played to a winner
    Then the winner and the whole eviction order are identical

  Scenario: With the per-conversation clock off, every beat costs the flat default
    When a beat advances the clock with no felt duration supplied
    Then it advances by the flat per-beat default
