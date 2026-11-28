# Feature 0201 - the bed rush (ORW-672). Design note: 0201-the-bed-rush.md.
# Nobody claims a bed before the champagne circle closes; then the house is released and races for the bedrooms. A claim needs reaching the room, the player always keeps a real choice, and the whole thing is deterministic from the seed. Roles only.

Feature: The bed rush after the champagne toast

  Scenario: No bed is claimed before the circle closes
    Given bed rush: a played premiere with the rush on
    Then bed rush: nobody owns a bed through the entrances and the toast, and the player's own claim is refused

  Scenario: A claim needs the room
    Given bed rush: a played premiere with the circle just closed
    Then bed rush: a claim from the common area is refused and every houseguest claims only once their arrival tick has come

  Scenario: The player always has a real choice
    Given bed rush: many seasons where the player hangs back
    Then bed rush: at every heat at least the floor of beds stays open across at least two rooms

  Scenario: A whole premiere beds everyone exactly once
    Given bed rush: a played premiere where the player rushes to a room
    Then bed rush: sixteen distinct beds are owned, nobody claimed twice, and the rush is over within its window

  Scenario: Switched off, nobody claims on walking in either (ORW-1134)
    Given bed rush: a played premiere with the rush off
    Then bed rush: nobody claims on walking in, the claims run at the close and no rush is saved
