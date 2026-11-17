Feature: 0070 — off-screen society texture enrichment
  Already-recorded hidden off-screen scenes get model-voiced prose texture via a best-effort FE-driven
  write-back, fanned out in parallel (the hermes subagent pattern). The enrichment lands DOWNSTREAM of the
  Vault boundary — on an event that is already hidden — so it reaches the player only through the existing
  overhear/gossip pathways. The engine keeps the entire closed set; the model proposes only prose. With no
  model, the deterministic template content simply stands (byte-identical).

  # HARD: roles only, no names. Participants are engine ids + observable public facets.

  Scenario: the texture write-back reaches the engine over the player channel
    Given a live game with off-screen scenes recorded this tick
    When the off-screen scene skeletons are read over the player channel
    Then the skeletons are Vault-free — public participants, room, and nature only
    # (ORW-570: a hidden scene is Vault-class, so that player-channel read returns none of it; the write-back below addresses a scene by the id the engine-side driver holds)
    When voiced texture is written back over the channel for a recorded off-screen scene
    Then the texture write-back is accepted over the channel
    And the addressed scene now carries the voiced texture as its content

  Scenario: an enriched off-screen scene stays hidden until a pathway reaches the player
    Given a live game with an enriched off-screen scene the player did not witness
    Then the player surface never shows the enriched scene
    And the admin surface never shows the enriched scene
    When an in-game pathway surfaces the scene to the player as gossip
    Then the player learns a sourced, possibly-drifted belief, not the raw hidden scene

  Scenario: the write-back is content-only and cannot pierce the closed set
    Given a live game with off-screen scenes recorded this tick
    When a texture write-back attempts to set a witness, flip the hidden flag, or carry a relationship number
    Then the write-back is refused at the channel boundary
    And no event is created, no witness set changes, and no relationship number crosses

  Scenario: open/closed non-collapse — no texture means a byte-identical fold
    Given two identical seeded games
    When one advances an off-screen tick with the texture driver absent
    And the other advances the same tick with the texture driver present
    Then both games produce the byte-identical seeded relationship fold
    And only the scene prose differs between them

  Scenario: enrichment is budget-capped and fail-soft
    Given a live game advancing an off-screen tick
    When the texture driver fails or no model is configured
    Then every off-screen scene retains its deterministic template content
    And the game advance is unaffected
