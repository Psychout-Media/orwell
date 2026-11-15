# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# NOTE (0077 Phase 2): the whereabouts scenario below is worded "within sight" (not "adjacent") because it checks SIGHTLINE (eyeshot), not raw adjacency;
# closed-door rooms are opaque to the live ambient read (the separate `tracked` field carries earned doorway sightings). Adjacency still governs movement and the overhear roll.
# Feature 0049 — House presence & lingering play: rooms + adjacency ground witnessing and
# overhearing (both directions), and milling around never advances the week.
# HARD rule: roles only (HOH, nominee, NPC, player, schemer, overhearer). Add to cucumber.cjs when green.

Feature: House presence and lingering play

  A light spatial ground truth: every active houseguest is in exactly one room per tick, movement
  follows the house adjacency map, co-presence makes witnesses, adjacency can make overhearers —
  in both directions — and the player can linger, mill, and talk without the week moving an inch.
  Facts the narrator queries, not a simulation the player operates.

  Scenario: Every active houseguest is in exactly one room
    Given a started game with a seeded house
    When the off-screen life ticks across several days
    Then every active houseguest occupies exactly one room at every tick
    And no evicted houseguest occupies any room

  Scenario: Movement follows the adjacency map and the seed
    Given two games started with the same seed
    When the off-screen life ticks in both
    Then every movement in both games is between adjacent rooms
    And both games produce identical occupancy trajectories

  Scenario: Whereabouts shows only what a houseguest could see or hear
    Given the player is in a room with some houseguests and others in rooms within sight
    When the player reads their whereabouts
    Then it lists who is present in the player's room
    And it lists who is in rooms within sight
    And it reveals nothing about rooms out of sight
    And it contains no motive, number, hidden state, or Vault sentinel

  Scenario: Co-presence makes a witness
    Given the player talks with an NPC while another NPC is in the same room
    When the scene is recorded
    Then the other NPC is in the event's witness set
    And an NPC in another room, out of sight, is not in the event's witness set
    And the event is not secret to any houseguest in the room

  Scenario: A houseguest who has turned in neither witnesses nor overhears
    Given it is late at night and several houseguests have turned in while one is still up
    And a turned-in houseguest is seated in the player's room beside one who is still up, another turned-in houseguest is named as a participant, and a third is next door beside another who is still up
    When the player's scene is recorded and many more follow
    Then no turned-in houseguest is in any witness set
    And no turned-in houseguest gains an overheard pathway
    And the houseguest who is still up, in the room, does witness
    And the houseguest who is still up, next door, does overhear

  Scenario: With the day clock off, presence witnesses exactly as before
    Given it is late at night and several houseguests have turned in while one is still up
    And the day clock is then switched off
    And a turned-in houseguest is seated in the player's room beside one who is still up, another turned-in houseguest is named as a participant, and a third is next door beside another who is still up
    When the player's scene is recorded
    Then the witness set is exactly the player, everyone seated in the room, and the one named

  Scenario: An NPC in the next room can overhear the player
    Given the player confides in an NPC while a schemer is in an adjacent room
    When the adjacency overhear roll succeeds for the schemer
    Then the schemer gains knowledge of the scene via an overheard pathway
    And the pathway is traceable to the recorded event
    And the schemer's confidence in it is lower than a witness's

  Scenario: The player can overhear NPCs scheming in the next room
    Given two NPCs scheme in a room adjacent to the player
    When the adjacency overhear roll succeeds for the player
    Then the player gains knowledge of the scheme via an overheard pathway
    And the surfacing is recorded as an explicit propagation event
    And no Vault content beyond the overheard scene itself reaches the player

  Scenario: Overhearing is gated, not guaranteed
    Given many seeded scenes with occupants in adjacent rooms
    When the overhear outcomes are sampled across seeds
    Then only a bounded fraction of adjacent occupants gain overheard pathways
    And an NPC with no presence-derived pathway to a fact still does not know it

  Scenario: Lingering never advances the week
    Given a started game mid-week with a pending scheduled beat
    When the player spends many consecutive turns moving rooms, milling, and talking
    Then the week, the phase, and the pending ceremony are unchanged
    And each milling turn is a clean committed turn, never an idle fast-forward
    And the day's meaningful event is still the scheduled beat

  # ORW-419 (Ryne, 2026-11-15: "I think the narrator should include the exit and the arrival. But the engine should move before the narrator.").
  # The engine resolves the player's OWN move from their words before the narrator writes; the narrator then voices the recorded from/to.
  Scenario: The engine moves the player from their own words before the narrator writes
    Given a started game with the player in the backyard and no house event in session
    When the engine reads the player's words "I go to the kitchen"
    Then the engine has the player in the kitchen
    And the game state hands the narrator the move from the backyard to the kitchen

  Scenario: Leaving with no destination goes through the nearest door
    Given a started game with the player in the backyard and no house event in session
    When the engine reads the player's words "I want to leave the backyard"
    Then the engine has the player in the living room
    And the game state hands the narrator the move from the backyard to the living room

  Scenario Outline: A future or conditional phrase is not a move
    Given a started game with the player in the backyard and no house event in session
    When the engine reads the player's words "<words>"
    Then the engine has the player in the backyard
    And the game state hands the narrator no move

    Examples:
      | words                              |
      | I'll go to the kitchen later       |
      | if it rains I will go to the kitchen |

  Scenario Outline: During a house event the player's move is refused with a reason and nothing moves
    Given a seeded season paused at <event>
    When the engine reads the player's words "I go to the kitchen"
    Then the move is refused with an in-fiction reason
    And the player's room and the in-game clock are unchanged

    Examples:
      | event                   |
      | an eviction vote        |
      | a competition in session |

  # ORW-445 (merged in #2772): a stated wait reaches the clock. The front end reads the player's own wait ("half an hour", "a couple of hours",
  # "the rest of the afternoon") into a hang-out request; the engine moves the in-game clock by exactly that much, never more than three hours,
  # never past the end of the current part of the day when the player said "the rest of", and never past a scheduled event. Waits that a houseguest or production cuts short are covered by the hang-out's own scenarios.
  Scenario: A stated wait moves the clock by exactly that long
    Given a played game on a quiet morning with the in-game clock running
    When the player says they will wait 60 minutes and nothing in the house interrupts them
    Then the in-game clock has moved on by exactly 60 minutes

  Scenario: A stated wait of more than three hours moves the clock by three hours
    Given a played game on a quiet morning with the in-game clock running
    When the player says they will wait 300 minutes and nothing in the house interrupts them
    Then the in-game clock has moved on by exactly 180 minutes

  Scenario: Waiting out the rest of the morning stops at the morning's end
    Given a played game on a quiet morning, 113 minutes before the afternoon
    When the player says they will wait out the rest of the morning and nothing in the house interrupts them
    Then the in-game clock has moved on by exactly 113 minutes
    And the in-game clock stands at the start of the afternoon

  Scenario Outline: With both a stated length and the rest of the morning, the shorter wait wins
    Given a played game on a quiet morning, <left> minutes before the afternoon
    When the player says they will wait <asked> minutes or the rest of the morning and nothing in the house interrupts them
    Then the in-game clock has moved on by exactly <moved> minutes

    Examples:
      | left | asked | moved |
      | 240  | 60    | 60    |
      | 60   | 150   | 60    |

  Scenario: A stated wait never runs past a scheduled event
    Given a played game with the in-game clock running, 47 minutes before the next scheduled event
    When the player says they will wait 120 minutes for the event
    Then the wait stopped because the event came due
    And the in-game clock has moved on by exactly 47 minutes

  # ORW-462 (Kevin's ruling, 2026-11-15): the player is not omniscient. Looking for someone always finds them, but only through what the player could really do.
  Scenario: A plain house search never sees through a closed door
    Given a played game where the player stands in the backyard, one houseguest is behind an unlocked bedroom door, one is in the HOH room held by another, and one is in the diary room
    When the player searches the house without naming anyone
    Then the houseguests behind doors are listed as not in view with no room named
    And the houseguests the player can see are still named in their rooms

  Scenario: Looking for someone behind an unlocked door finds them by opening it
    Given a played game where the player stands in the backyard, one houseguest is behind an unlocked bedroom door, one is in the HOH room held by another, and one is in the diary room
    When the player searches the house looking for the houseguest behind the unlocked door
    Then the answer names the door to open and says the player will see who is inside

  Scenario: Looking for someone in the HOH room is answered by a houseguest who knows
    Given a played game where the player stands in the backyard, one houseguest is behind an unlocked bedroom door, one is in the HOH room held by another, and one is in the diary room
    When the player searches the house looking for the houseguest in the HOH room
    Then the answer is that a houseguest who knows says the houseguest is there, while the door stays closed to the player

  Scenario: Looking for someone in the diary room is answered by a houseguest who knows
    Given a played game where the player stands in the backyard, one houseguest is behind an unlocked bedroom door, one is in the HOH room held by another, and one is in the diary room
    When the player searches the house looking for the houseguest in the diary room
    Then the answer is that a houseguest who knows says the houseguest is there, while the door stays closed to the player
