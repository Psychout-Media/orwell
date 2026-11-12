# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# DRAFT executable spec — SPECCED, NOT BUILT (author: feature-maker; implementer makes it pass).
# Feature 0051 — In-character images: the model PRODUCES images as part of play (a houseguest's
# sketch, the memory-wall portrait), inline in the chat. (Scene "camera stills" were cut 2026-11-12, ORW-286 item 4, Ryne: "I don't want pictures of scenes.") Pairs with E94 (attach =
# analyze in; this = generate out). NOT in cucumber.cjs until the engine half is built to green;
# the FE half is pytest/browser-lane gated. HARD rule: roles only (player, NPC, HOH, nominee,
# evictee). Binding rules: the Vault Wall (prompts from visible state only — E11/E15 discipline),
# recorded-or-it-didn't-happen (image beats are recorded), ADR 0003 (inline in
# the chat; augments, never replaces; graceful absence).
# Decisions locked 2026-06-11: auto-on-move-in portraits · photorealistic style · provider-agnostic
# ImageGenerationPort · all declines in the production/show frame · portraits persisted to
# ORWELL_DATA_DIR · cast roster sidebar (portrait + name + status: active/jury/evicted) ·
# chat avatars planned future extension (not this spec's DoD).

Feature: In-character images — Vault-free generation, rendered inline in the chat

  The game generates photorealistic cast portraits automatically at move-in, shows them inline in
  the chat, then persists them to the engine data dir so they are never regenerated on restart.
  A cast roster sidebar gives the player a durable face-to-name reference throughout the season,
  showing each houseguest's portrait, name, and current status (active / jury / evicted). Subsequent
  images are player-requested or engine-offered at key beats. All decline paths use the
  production/show frame. When no image-capable model is configured the game plays identically.

  Background:
    Given a started game with a generated cast
    And an image-generation pipeline behind the configured ImageGenerationPort

  # --- Portrait generation ---

  Scenario: Cast portraits fire automatically at move-in — no player prompt needed
    When the season begins and the createCharacter / season-start beat completes
    Then a photorealistic portrait is generated for each houseguest
    And the portraits appear inline in the chat as the cast is introduced
    And no player request or prompt was required to trigger generation

  Scenario: Move-in portraits are persisted and not regenerated on restart
    Given the season-start portrait set has been generated and persisted
    When the engine restarts and the game is resumed
    Then the stored portraits are served from the data dir
    And no new image generation is triggered for already-stored portraits

  Scenario: Portrait generation is a bounded one-time cost, exempt from the per-turn cap
    When the season-start portrait set fires
    Then all houseguest portraits are generated in that beat
    And this generation does not count against the per-turn image budget

  # --- Cast roster ---

  Scenario: The cast roster shows each houseguest's portrait, name, and current status
    Given a game in progress with houseguests at various statuses
    When the player opens the cast roster sidebar
    Then each houseguest appears with their persisted portrait, name, and current status
    And status reflects the live game projection: active, jury, or evicted
    And evicted houseguests remain visible with their status marked

  Scenario: The cast roster is Vault-free
    Given the engine state contains hidden-layer sentinel content
    When the cast roster is rendered
    Then no hidden sentinel content appears in any roster card
    And no stat, relationship value, or soul content is shown

  Scenario: The cast roster falls back gracefully when no images are stored
    Given no image-capable model is configured
    When the player opens the cast roster sidebar
    Then each houseguest card shows their name and status
    And no broken image or error surface is shown

  Scenario: Factory reset scrubs the portraits directory
    Given portraits have been generated and persisted for a user
    When a factory reset is performed
    Then the portraits directory is deleted alongside the save data

  # --- Vault Wall and knowledge scope ---

  Scenario: Image prompts are built only from the player's visible state
    Given the engine state contains hidden-layer sentinel content
    When an image prompt is assembled for any sanctioned generation moment
    Then the assembled prompt contains no hidden sentinel content
    And the prompt builder has no dependency on any engine-only store

  # --- Style and consistency ---

  Scenario: The season-start portrait set is photorealistic and built from public facets only
    When the season begins and the cast portrait set is produced
    Then each portrait prompt carries the per-season photorealistic style anchor
    And each portrait prompt is derived from that houseguest's public appearance facets
    And no stat, relationship value, or hidden element appears in any portrait prompt

  Scenario: The house looks like itself — style and identity are stable within a season
    When two images of the same houseguest are generated in the same season
    Then both prompts carry the same per-season photorealistic style anchor and the same appearance facets
    And the style anchor survives a save and engine restart
    And a different seed yields a different style anchor

  # --- Recording, budget, and absence ---

  Scenario: A generated image shown in character is a recorded beat
    When an image is generated and rendered to the player in character
    Then a player-witnessed event recording that image beat exists in the event record

  Scenario: Generation is budgeted, and over-budget requests decline in the production frame
    Given the generation budget for the current window is exhausted
    When the player requests another image
    Then no image is generated
    And the refusal is voiced in the production/show frame
    And the budget bounds are declared in a constants module

  Scenario: Graceful absence — no image-capable model configured
    Given no configured model has image-generation capability
    When a generation moment arises
    Then the game continues without error
    And the absence is voiced in the production frame
    And no broken affordance or error surface is shown to the player

  Scenario: Images augment the chat and never replace it
    When images are rendered
    Then they appear inline in the chat transcript
    And no game-building or game-progressing interaction requires the image surface
