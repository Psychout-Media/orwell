# spec-only: gated by frontend/tests/test_public_profile_guard.py; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Feature 0067 — Public internet exposure & internet-grade hardening (ADR 0007).
# Roles only (player, admin, operator) — no houseguest or person names. Executable spec of record;
# the gate is the FE pytest suite + the deploy-script lints named in the design note's Definition of
# Done (a recorded deviation from the BDD-default, like 0066/0055): the behaviour is host/ops + FE
# config, not a new Cucumber world. The TS engine is unchanged by this feature.

Feature: Public internet exposure of the player tier over HTTPS
  As the operator putting the game on hiorwell.com
  I want the player front-end reachable over HTTPS with an internet-grade perimeter
  So that the engine and the Vault stay private and a misconfiguration fails closed

  Background:
    Given the engine runs engine-only behind the front-end
    And the front-end consumes only Vault-free projections of the player's own game

  Scenario: The engine is never reachable from the internet
    Given the public deployment is configured
    Then only the front-end host and port are exposed
    And the engine bind address stays loopback
    And no public exposure artifact names the engine port

  Scenario: The front-end binds a private address, never the world
    Given the front-end service unit
    Then it binds the configured private bind host, defaulting to loopback
    And it is reached only by the local reverse proxy or tunnel connector
    And the proxy terminates TLS and forwards the real client scheme and address

  Scenario: The public profile refuses to boot with authentication disabled
    Given the public profile is selected
    When authentication is disabled
    Then the front-end refuses to start
    And the refusal names the unsafe setting

  Scenario: The public profile refuses to boot with insecure cookies or a localhost bypass
    Given the public profile is selected
    When secure cookies are off or the localhost auth bypass is on
    Then the front-end refuses to start
    And the refusal names the unsafe setting

  Scenario: A safe public profile boots green
    Given the public profile is selected
    And authentication is on, cookies are secure, the localhost bypass is off, and the host is pinned
    Then the front-end starts normally

  Scenario: The Host header is pinned to the domain
    Given the public deployment is configured
    When a request arrives with a Host header outside the allow-list
    Then it is rejected
    And a request for the configured domain is accepted

  Scenario: The login throttle keys on the real client address behind the tunnel
    Given the app is behind a reverse proxy or tunnel
    Then the login throttle keys on the real client address from the trusted forwarding header
    And it is not collapsed into one global bucket for every visitor
    And two different real clients get independent throttle buckets
    And a forwarding header is ignored when proxy trust is off, so a directly exposed app is not spoofable

  Scenario: The Vault Wall and cross-user isolation are unchanged by exposure
    Then no outward surface can read the Vault
    And no request for one user can return another user's game
    And exposure changes only the transport, never the trust model

  Scenario: Dormant by default keeps the non-public deploy byte-identical
    Given the public profile is not selected
    Then the boot guard does not arm
    And the default single-tenant start path is unchanged
