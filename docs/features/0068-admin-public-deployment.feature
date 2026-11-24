# spec-only: gated by frontend/tests/test_public_deployment_routes.py; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Feature 0068 — Admin "Public deployment / Connect to the internet" (ADR 0007, drives feature 0067).
# Roles only (admin, operator) — no person names. Executable spec of record; the gate is the FE pytest
# suite + the deploy-script lints named in the design note (a recorded deviation, like 0066/0067). The
# TS engine is unchanged. Cloudflare uses a REMOTELY-MANAGED tunnel, so the box side is "paste token".

Feature: Admin-driven public deployment
  As an administrator taking the game to production
  I want to turn on internet exposure from the admin UI
  So that going public needs no SSH, no editing files, and no manual tunnel setup

  Background:
    Given an authenticated administrator
    And the front-end is running the default LAN profile

  Scenario: The admin sees the public-deployment status and security checklist
    When the admin opens the Public deployment panel
    Then it shows whether the game is public, the front-end bind, and the tunnel state
    And it shows a security checklist: authentication on, secure cookies, host pinned

  Scenario: Applying a safe public profile triggers the privileged ops action
    When the admin connects with a domain and a connector token
    Then the proposed profile is validated as safe before anything is written
    And a privileged ops action is requested to apply the env, run the connector, and restart the front-end
    And progress is reported through the existing ops status feed

  Scenario: An unsafe profile is refused before anything is persisted
    When the admin tries to go public without pinning a domain
    Then the request is refused with the named unsafe setting
    And no configuration and no flag are written

  Scenario: The connector token is write-only
    When the admin submits a connector token
    Then the token is stored only transiently and shredded after the connector is installed
    And no status or settings response ever returns the token

  Scenario: The Cloudflare account steps are guided, never automated
    Then the wizard links the admin to create the tunnel and hostname in Cloudflare
    And it only collects the resulting connector token
    And Orwell never holds the administrator's Cloudflare account credentials

  Scenario: Disconnecting returns to a LAN-only profile
    When the admin disconnects
    Then a privileged ops action stops the connector and turns the public profile off
    And the front-end returns to the default LAN profile

  Scenario: Only an administrator can read or change public deployment
    Given a non-admin user
    Then reading or changing the public deployment is forbidden

  Scenario: Dormant by default
    Given no public deployment has been applied
    Then the default single-tenant deploy is unchanged
    And the panel takes effect only when an administrator acts
