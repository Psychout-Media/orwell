# spec-only: gated by frontend/tests/test_0064_canonical_session.py; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# 0064 — Live multi-device game sync (the canonical game chat)
#
# FE feature: the executable gate is front-end pytest + the browser smoke (the chat sessions and
# streaming live in the front-end), NOT Cucumber — this file is the role-only acceptance spec the
# pytest suites mirror. No names: roles only (the player, a device, a season).

Feature: One game, one canonical chat, every device live and in sync
  As a player signed in on more than one device
  I want every screen to show the same single game, live
  So that the house never splits into two parallel conversations or two reasoning chains

  Background:
    Given a signed-in player with one active game
    And the front-end game build is on

  # ── A. The canonical game session ──────────────────────────────────────────

  Scenario: Two devices converge on the same game session
    Given the player opens the game on a first device
    And the player opens the game on a second device at the same time
    When each device resolves its game session
    Then both devices receive the same game session id

  Scenario: A concurrent first-open mints exactly one session
    Given the player has no bound game session yet
    When two devices request the game session simultaneously
    Then exactly one new chat session is created
    And both devices are bound to that same session

  Scenario: A different player never shares a session
    Given a second player with their own active game
    When each player resolves their game session
    Then the two players receive different session ids
    And neither player can subscribe to the other's session stream

  Scenario: A season reset rotates the canonical session
    Given the player's season has ended
    When the player starts the next season
    Then a fresh game session is bound
    And the previous season's transcript is not loaded as narrator context

  # ── B. The live experience across devices ──────────────────────────────────

  Scenario: A turn driven on one device streams live on the other
    Given two devices are viewing the same game session
    When the player drives a game turn on the first device
    Then the second device shows the new turn streaming token by token
    And the second device shows the same finished narration as the first

  Scenario: A device opening mid-turn catches up
    Given a game turn is already streaming on the first device
    When the player opens the same game session on a second device
    Then the second device replays the turn so far and then streams live

  Scenario: The producers reach out exactly once
    Given a brand-new game whose casting interview has not opened
    When two devices both reach the casting kickoff
    Then the producers' opening message is recorded once
    And both devices show that single opening message

  # ── C. Messenger-style concurrency (one shared thread, never two chains) ─────

  Scenario: A second device never starts a parallel reasoning chain
    Given a game turn is in progress on the first device
    When the player sends a message on the second device
    Then the first device's turn is not interrupted
    And the second device's message is queued onto the same thread
    And it is answered after the current turn finishes
    And only one reasoning chain ever runs at a time

  Scenario: Every device can type at any time (no spectator lockout)
    Given a game turn is in progress on the first device
    When the player views the game on the second device
    Then the second device's composer stays enabled
    And the second device shows the turn streaming live

  Scenario: The thread stays in sync across devices like a messaging app
    Given two devices are viewing the same game session
    When the player sends a message on either device
    Then both devices show that message and the reply in the same order
    And neither device shows a message the other is missing

  # ── D. Robustness & isolation ───────────────────────────────────────────────

  Scenario: A reconnect resumes the live view
    Given a device is watching a live turn
    When its connection drops and re-establishes
    Then it resumes the live view without losing the turn

  Scenario: A front-end restart degrades to history, never a stuck game
    Given a game turn was in progress when the front-end restarted
    When the player reopens the game on any device
    Then the device shows the conversation from saved history
    And a new turn can be driven

  Scenario: Sync payloads carry no game secrets
    When the server notifies devices that the session changed
    Then the notification carries only the session id and a change type
    And it carries no message body and no Vault content

  # ── F. Window & HUD layout sync across devices ──────────────────────────────

  Scenario: Moving a window on one device moves it on the other
    Given two devices are viewing the game
    When the player drags a HUD window to a new position on the first device
    Then the same window moves to that position on the second device
    And the new position is restored when either device reloads

  Scenario: Resizing a window syncs across devices
    When the player resizes a HUD window on the first device
    Then the same window takes the new size on the second device

  Scenario: Open, minimize, and dock state sync across devices
    When the player minimizes a window on the first device
    Then that window is minimized on the second device
    When the player opens or docks a window on the first device
    Then the second device reflects that open or docked state

  Scenario: A remote change never yanks a window mid-drag
    Given the player is actively dragging a window on the second device
    When a layout change for that same window arrives from the first device
    Then the remote change is deferred until the drag finishes

  Scenario: Layout is per-user and isolated
    Given a second player with their own devices
    When each player rearranges their windows
    Then neither player's layout affects the other's

  Scenario: Layout sync payloads carry no game secrets
    When the server notifies devices that the layout changed
    Then the notification carries only window ids and geometry numbers
    And it carries no message body and no Vault content
