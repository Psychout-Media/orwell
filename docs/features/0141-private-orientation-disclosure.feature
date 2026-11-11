# spec-only: (not wired into the BDD gate; awaiting build, ORW-261) 0141 — a private orientation can reach the player by the houseguest's own choice. Awaiting Ryne's approval (ORW-261).
Feature: A private orientation can reach you by the houseguest's own choice
  The engine decides whether a houseguest tells; the narrator only voices it. Roles only.

  Background:
    Given a live season in which a houseguest holds a private orientation sealed in the Vault
    And a game a person is playing

  Scenario: A trusted player who asks can learn it, and the same seed reproduces it
    Given the player is trusted by that houseguest and they are alone
    When the player raises the topic with that houseguest
    Then on some seeds the houseguest tells the player
    And the same seed gives the same answer on a repeat

  Scenario: A houseguest who does not choose to tell never does
    Given the engine's decision for that houseguest and moment is to hold
    When the player asks in six different phrasings
    Then the player learns nothing about it
    And the narrator's prompt is the same as for a houseguest with nothing to disclose

  Scenario: A distrusting houseguest declines more often
    When the same ask is made across many seeds at low trust and at high trust
    Then the share rate at high trust is greater than at low trust

  Scenario: When it comes out it is a recorded, witnessed told-by event
    When the houseguest tells the player
    Then the knowledge store holds a told-by fact whose source is that houseguest
    And the fact is the player's own, visible in their journal

  Scenario: Nothing reaches the player or the admin outside that path
    Given a unique marker as the private orientation
    When a season is played without the houseguest ever telling
    Then the marker appears on no player surface and no admin surface

  Scenario: It moves no competition outcome
    When the same seeded season is played with the feature on and off
    Then every competition, nomination and eviction outcome is identical
