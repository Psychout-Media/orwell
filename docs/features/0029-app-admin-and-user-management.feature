# spec-only: gated by frontend/tests/test_app_admin.py; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Executable spec — IMPLEMENTED; these are acceptance criteria VALIDATED BY FRONTEND PYTEST
# (frontend/tests/), not the unit/BDD harness — never added to cucumber.cjs (like 0010/0032).
# Feature 0029 — App administrator role & user management. App/account tier (NOT the game's God Mode).
# HARD rule: roles only (here "user"/"admin" are account roles; A/B are role labels).

Feature: App administrator role & user management

  Orwell has an account-administration tier: the first account is the admin, admin is propagable,
  admins manage users and LLM settings, and passwords can be reset (self for everyone, admin for
  others). Every admin power is re-checked server-side, never trusted from the hidden UI.

  Scenario: The first account created is an administrator
    Given no accounts exist
    When the setup script creates the first account
    Then that account is an administrator
    And it holds the manage-users and manage-LLM-settings entitlements

  Scenario: An admin can promote and demote other users
    Given an administrator and a regular user
    When the administrator promotes the regular user to admin
    Then that user holds the admin entitlements
    When the administrator demotes them again
    Then that user holds none of the admin entitlements

  Scenario: The last administrator cannot be demoted or deleted
    Given exactly one administrator remains
    When an attempt is made to demote or delete that administrator
    Then it is refused
    And at least one administrator still exists

  Scenario: The user manager is admin-only, enforced server-side
    Given a regular (non-admin) user
    Then the user manager is not shown to them
    And a direct call to a user-management endpoint by them is rejected

  Scenario: Any logged-in user can change their own password
    Given a logged-in user
    When they supply their current password and a new one
    Then their password is changed

  Scenario: An admin can reset another user's password without the current one
    Given an administrator and another user
    When the administrator sets a new password for that user
    Then that user's password is changed
    And that user's active sessions are revoked

  Scenario: Changing global LLM settings requires the admin entitlement
    Given a regular user without the manage-LLM-settings entitlement
    When they attempt to change the global model or endpoint configuration
    Then it is rejected
    But an administrator can change it
