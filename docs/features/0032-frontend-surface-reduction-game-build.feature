# spec-only: gated by frontend/tests/test_game_build.py; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Executable spec — IMPLEMENTED; validated by frontend pytest (frontend/tests/).
# Feature 0032 — Front-end surface reduction (the "game build"). Front-end (Python) only; NO engine
# change. Tested in frontend/tests/ (pytest, like 0029) — NOT added to cucumber.cjs (TS lane).
# HARD rule: roles only (player, admin). Vertical names (email, shell, …) are app features, not
# houseguest names — using them is fine; never use a houseguest/player name.

Feature: Front-end surface reduction (the game build)

  The player-facing app is the Big Brother game and nothing else. With the game build on, the
  inherited workspace verticals (email, calendar, contacts, documents/editor, gallery, cookbook,
  compare, deep research, notes, tasks, shell, web search/fetch, youtube, webhooks, and the
  front-end's own memory/RAG/skills) are removed — gone server-side, not merely hidden — while the
  game keep-set (chat, the LLM connection, the engine MCP agent, onboarding, status, portraits,
  accounts/admin, theme) stays intact. Voice is kept but off by default. One switch flips it all.

  Scenario: The player sees only the game surface
    Given the game build is on
    When the player loads the app
    Then the game keep-set is present (onboarding/chat, status, portraits, settings, theme)
    And no entry point for a dropped vertical is shown

  Scenario: A dropped vertical is gone server-side, not just hidden
    Given the game build is on
    When a request is made to a dropped vertical's endpoint
    Then it is not mounted and the request returns not-found
    And this holds even for an authenticated admin

  Scenario: The live shell endpoint is removed in the game build
    Given the game build is on
    When an admin calls the shell-exec endpoint
    Then the request returns not-found
    And no command is executed

  Scenario: The game build injects no front-end memory, RAG, or skills into chat context
    Given the game build is on and a game is in progress
    When the chat context for a player turn is assembled
    Then it contains the engine's moment prompt as the only injected framing
    And it contains no front-end memory, RAG, or skill content

  Scenario: The game build is a single switch
    Given the game-build switch is on
    Then every dropped vertical is disabled and every keep-set capability is enabled
    When the game-build switch is turned off
    Then the inherited workspace verticals are reachable again

  Scenario: Voice is kept but off by default
    Given the game build is on with default flags
    Then voice (text-to-speech and speech-to-text) is disabled
    When the voice flag is enabled
    Then voice is available again

  Scenario: The engine MCP agent backend survives the prune
    Given the game build is on
    Then the agent's engine tool backend is still configured
    And a game can be onboarded and a turn played in-character

  Scenario: The Settings surface is pruned to the keep-set
    Given the game build is on
    When an admin opens Settings
    Then only the keep-set tabs are shown (providers/models, account/users, tools, appearance, search, voice)
    And no tab for a dropped vertical is shown

  Scenario: Per-user isolation and the Vault Wall are unaffected by the prune
    Given the game build is on and two users each have their own game
    When each plays through the reduced surface
    Then neither user's game state appears in the other's app
    And no hidden engine state is exposed by any kept surface
