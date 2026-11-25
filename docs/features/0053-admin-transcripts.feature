# spec-only: gated by frontend/tests/test_0053_admin_transcripts.py; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# BUILT — FE pytest-validated (2026-06-11) by frontend/tests/test_0053_admin_transcripts.py.
# Feature 0053 — Admin transcript retrieval (ruling #14, 2026-06-10). Front-end (Python) only; NO
# engine change. Validated by frontend pytest (frontend/tests/), like 0029/0032 — never added to
# cucumber.cjs. HARD rule: roles only ("admin"/"user" are account roles; player is a role).
# Boundaries (recorded in the ruling): transcripts are player-visible content only (no Vault risk by
# construction); they DO include the player's Diary-Room entries (accepted operator capability —
# noted in the UI copy); retrieval is READ-ONLY (E93 applies to admins too); transcripts survive the
# game reset and die with the factory reset.

Feature: Admin transcript retrieval — quiet, read-only debug access to any user's chat transcripts

  The app administrator (the account tier, NOT the game's God Mode) can retrieve old chat
  transcripts for debugging: an admin-gated API plus a small entry in the existing admin
  section of Settings. Quiet, not loudly exposed — nothing in the game chrome. The export
  carries the agent-thread tool-call nodes (names, args, outputs), because what the GM
  actually called vs. what it narrated is where the debug value lives.

  Background:
    Given an orwell front-end with an admin account and a non-admin user account
    And the non-admin user has played sessions whose transcripts are stored

  Scenario: The transcript API is admin-gated — a non-admin gets no list
    When the non-admin user requests the transcript list endpoint
    Then the request is refused with the same status the other admin-only routes return
    And no session metadata of any other account is disclosed

  Scenario: The transcript API is admin-gated — a non-admin gets no export
    When the non-admin user requests the transcript export endpoint for another user's session
    Then the request is refused
    And no transcript content is disclosed

  Scenario: An admin lists sessions across all users, with filters and pagination
    When the admin requests the transcript list endpoint
    Then the response lists sessions across all users
    And each entry carries the session id, owner, title, created and updated timestamps, message count, and a game-session marker
    And filtering by owner returns only that owner's sessions
    And filtering by a since-timestamp returns only sessions updated after it
    And the list is paginated

  Scenario: An admin exports a full transcript including the tool-call nodes
    When the admin requests the transcript export for a game session in each supported format
    Then the export contains the messages with their roles and timestamps
    And the export contains the agent-thread tool-call nodes with names, arguments, and outputs

  Scenario: Diary-Room entries are included and the inclusion is disclosed to the operator
    Given the exported session contains the player's Diary-Room entries
    When the admin exports that session's transcript
    Then the Diary-Room entries appear in the export
    And the admin UI copy for the transcripts surface notes that exports include Diary-Room entries

  Scenario: Retrieval is read-only — the played record cannot be rewritten from this surface
    When the surface's routes are enumerated
    Then no route exists to edit or delete a transcript or any of its messages

  Scenario: The UI entry is one quiet row in the admin section of Settings
    When a non-admin user renders Settings
    Then no transcripts entry is present in the DOM
    When the admin renders Settings
    Then a transcripts row is present inside the existing admin-only section
    And no transcripts affordance exists anywhere in the game chrome or navigation

  Scenario: Transcripts survive the game reset and die with the factory reset
    Given stored transcripts exist
    When the game-only reset runs
    Then the transcripts are still retrievable by the admin
    When the factory reset runs
    Then the transcripts are gone
