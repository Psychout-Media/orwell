# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# NOTE (0077 Phase 2): in the whereabouts scenario below, "adjacent rooms" now means rooms within SIGHTLINE (eyeshot);
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
    Given the player is in a room with some houseguests and others in adjacent rooms
    When the player reads their whereabouts
    Then it lists who is present in the player's room
    And it lists who is in adjacent rooms
    And it reveals nothing about non-adjacent rooms
    And it contains no motive, number, hidden state, or Vault sentinel

  Scenario: Co-presence makes a witness
    Given the player talks with an NPC while another NPC is in the same room
    When the scene is recorded
    Then the other NPC is in the event's witness set
    And the event is not secret to any houseguest in the room

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
    And the watcher treats the milling as activity rather than idleness
    And the day's meaningful event is still the scheduled beat
