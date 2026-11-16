# Feature 0161 - alliance history (ORW-544, found along the way in the theme 2 deep dive).
# Design note: 0161-alliance-history.md. An alliance that fades, loses its members or is voted out of existence used to be deleted from the save, and an NPC alliance
# forming or fading left no event. Now every change is kept in an append-only history, ids are never reused, and each form / fade / dissolve is an engine event that
# stays hidden unless the player was in the alliance or had been told of it. The live alliance list is unchanged. Roles only.

Feature: Alliances keep their history and their changes are recorded

  Scenario: An alliance that fades apart stays in the history
    Given an alliance history season where three houseguests named an alliance and have grown cold to each other
    When the alliance history days pass until it fades
    Then the alliance is gone from the live alliances
    And the alliance history still holds it, with all three members and the reason it faded

  Scenario: An alliance that falls to one member by betrayal stays in the history
    Given an alliance history season where two houseguests named an alliance
    When one of them turns on the other
    Then the alliance is gone from the live alliances
    And the alliance history still holds the betrayal and the ended alliance with both members

  Scenario: An alliance emptied by evictions stays in the history
    Given an alliance history season where three houseguests named an alliance
    When two of them have left the house
    Then the alliance is gone from the live alliances
    And the alliance history still holds the two exits and the ended alliance with all three members

  Scenario: The history survives a save and a load whole
    Given an alliance history season where one alliance faded and another is still standing
    When the season is saved and loaded into a fresh session
    Then the loaded session holds every history entry the saved one held
    And a later save never holds fewer history entries than an earlier one

  Scenario: An alliance id is never reused after a reload
    Given an alliance history season where the newest alliance has ended and an older one is still standing
    When the season is saved and loaded into a fresh session
    And the houseguests name a new alliance
    Then the new alliance has an id no earlier alliance ever had

  Scenario: An NPC alliance forming is recorded as a hidden event
    Given an alliance history season where a bonded trio of houseguests can name an alliance off-screen
    When the house lives long enough for them to name it
    Then an alliance-formed event is on record naming only those houseguests as witnesses
    And that event is hidden from the player

  Scenario: An NPC alliance fading is recorded as a hidden event
    Given an alliance history season where three houseguests named an alliance and have grown cold to each other
    When the alliance history days pass until it fades
    Then an alliance-faded event is on record and it is hidden from the player

  Scenario: An alliance the player was pitched is told to the player
    Given an alliance history season where an alliance was named and the player was pitched into it
    When the alliance history days pass until it fades
    Then the alliance-faded event is visible to the player

  Scenario: No view shows a hidden alliance event while the season is live
    Given an alliance history season where three houseguests named an alliance and have grown cold to each other
    When the alliance history days pass until it fades
    Then no player or admin view shows the alliance name, its members or the alliance history

  Scenario: The history changes nothing the live game reads
    Given an alliance history season where three houseguests named an alliance and have grown cold to each other
    Then the live alliances and the bloc cement read exactly as they did without a history
