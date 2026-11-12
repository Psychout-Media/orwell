Feature: 0072 — multi-platform gateway: play your game from messaging platforms
  A new non-Vault player adapter lets a player reach THEIR game from messaging platforms over the same
  Vault-free MCP player channel. Vault-safe by inheritance; a server-side chokepoint keeps reasoning and
  operator-asides out of the public bubble; pairing binds each platform identity to one orwell account so one
  human shares one game across platforms.

  # HARD: roles only, no names. Platform identities are opaque ids bound to an orwell account.

  Scenario: a paired platform identity reaches the player's own game
    Given a player account with a live game
    And a platform identity paired to that account
    When the platform identity sends a turn over the gateway
    Then the turn runs against that account's game on the player channel
    And the public reply contains no Vault or secret content

  Scenario: one human shares one game across platforms
    Given a player account with a live game
    And two platform identities paired to that account
    When each platform identity reads the game state over the gateway
    Then both see the same game under the same user
    When a third, unpaired platform identity sends a turn
    Then it cannot reach any game

  Scenario: cross-user isolation holds over the gateway
    Given two player accounts each with a live game
    And a platform identity paired to the first account
    When that identity sends a turn over the gateway
    Then no part of the second account's game is returned

  Scenario: reasoning never reaches the public bubble
    Given a paired platform identity with a live game
    When a turn's narration carries reasoning, an operator-aside, and a raw npc id
    Then the delivered reply is scrubbed of reasoning, operator-asides, and the npc id
    And the scrub chokepoint fires regardless of which prompt produced the leak

  # ORW-286 item 8 (Ryne, BDD card 33, 2026-11-11: "Chat only for now."): the gateway is one narrated turn plus the scene fold. It does not submit decisions or advance the game;
  # deciding happens in the web client. (The old scenario "the choice is submitted through the existing decision path" only grepped that the handler imports orwell_engine, so it passed with the feature absent.)
  Scenario: the gateway is chat only - it never submits a decision or advances the game
    Given a paired platform identity with a pending binding decision
    When the identity sends a text message over the gateway
    Then the reply is one narrated turn that mentions the pending decision as plain text
    And the gateway made no submit-decision call and no advance-game call
    And the turn's scene was folded through the consequence seam

  Scenario: the game build is respected over the gateway
    Given a paired platform identity with a live game
    When the identity attempts to invoke a drop-set inherited-workspace tool
    Then the tool is unavailable over the gateway

  Scenario: pairing is hardened
    Given the pairing flow
    When a code is issued
    Then it is stored only as a salted hash with a bounded lifetime
    When an incorrect code is presented repeatedly
    Then the identity is rate-limited and locked out
    When an expired code is presented
    Then pairing is refused
