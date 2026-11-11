Feature: A houseguest's visible mood is never the opposite of their state, and only a present houseguest shows one
  The narrator is handed each PRESENT houseguest's observable tells (words only). A low, distressed houseguest must never be handed a high-spirited tell
  (and the reverse), and a houseguest in another room is handed no mood at all. ORW-106 watch-list item 1. Roles only; the engine, with no model, decides.

  Scenario: A rattled, low houseguest in the player's room is never handed a high-spirited tell
    Given a houseguest in the player's room whose spirits are low and distress is high
    When the narrator is handed that houseguest's voice
    Then the houseguest carries at least one tell
    And none of the tells is "giddy" or "warm-open"

  Scenario: A buoyant, confident houseguest in the player's room is never handed a low tell
    Given a houseguest in the player's room whose spirits are high and distress is low
    When the narrator is handed that houseguest's voice
    Then the houseguest carries at least one tell
    And none of the tells is "withdrawn", "tearful", "snapping" or "brittle-calm"

  Scenario: A houseguest in another room is handed no mood tell however rattled
    Given a houseguest in another room whose spirits are low and distress is high
    When the narrator is handed that houseguest's voice
    Then the houseguest carries no tells
