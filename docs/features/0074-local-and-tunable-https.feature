# spec-only: gated by tests/unit/tlsArtifacts.test.ts; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Feature 0074 — Local & tunable HTTPS (ADR 0014).
# Roles only (admin, operator, player) — no houseguest or person names. Executable spec of record; the
# gate is the FE pytest suite + the deploy-artifact test named in the design note's Definition of Done
# (a recorded deviation from the BDD-default, like 0066/0067): the behaviour is host/ops + FE config,
# not a new Cucumber world. The TS engine is unchanged by this feature.

Feature: Local & tunable HTTPS for the player tier
  As the operator running the box on a LAN
  I want HTTPS on orwell.lan, the LAN IP, and (optionally) the public domain with no browser warning
  So that every entrypoint is encrypted and the engine and the Vault stay private

  Background:
    Given the front-end is reached only through the local TLS terminator on loopback
    And the engine runs engine-only behind the front-end

  Scenario: Local HTTPS works without any public domain configured
    Given no public domain or DNS credentials are set
    When local TLS is enabled
    Then the terminator serves the local hostnames and the LAN IP over HTTPS from an internal CA
    And the certificate authority root is offered for one-click download
    And a device that trusts the root once sees no further browser warning

  Scenario: The engine is never named in any TLS artifact
    Given local TLS is configured
    Then the generated reverse-proxy config references only the front-end host and port
    And it never names the engine port

  Scenario: Enabling local TLS hardens the cookie and bind posture
    When local TLS is enabled
    Then session cookies are marked Secure
    And the front-end binds loopback so the only LAN entrypoint is the HTTPS terminator
    And the public internet profile is not armed

  Scenario: The publicly-trusted upgrade removes the per-device trust step
    Given a public domain plus a DNS provider and API token are configured
    When local TLS is enabled
    Then the terminator obtains a publicly-trusted certificate for the domain by a DNS challenge
    And it serves that domain over HTTPS with no per-device install and no warning

  Scenario: The HTTPS settings are tunable backend variables in the control panel
    Given the control-panel HTTPS action
    Then it reads and writes the TLS variables in the environment file
    And it applies the change by reconciling the terminator and restarting the front-end
    And the same apply engine backs both the control panel and the in-app admin card

  Scenario: The admin apply is privilege-safe and token-safe
    Given the in-app admin HTTPS card
    When an apply is requested with a DNS API token
    Then the web tier writes a non-secret config, an existence-only flag, and the token at mode 0600
    And a privileged root path unit performs the actual apply
    And no status response ever returns the token

  Scenario: The root certificate download needs no login
    Given a fresh device that has not logged in
    When it requests the local certificate authority root
    Then the download is served without authentication
    And it is the public root, never a secret key

  Scenario: Dormant by default keeps the non-TLS deploy byte-identical
    Given local TLS is not enabled
    Then no terminator runs and the front-end serves plaintext exactly as before
    And the default start path is unchanged

  Scenario: The Vault Wall and cross-user isolation are unchanged by local TLS
    Then no outward surface can read the Vault
    And no request for one user can return another user's game
    And local TLS changes only the transport, never the trust model
