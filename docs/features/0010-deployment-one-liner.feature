# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Executable spec — IMPLEMENTED (scripts + deploy/smoke.sh); verified on a real Proxmox host (the
# owner's production deploy, owner-confirmed 2026-11-02). Not in cucumber.cjs.
# Priority: MVP-1 (blocking). One-liner Proxmox deploy + update, containerized.
# These are acceptance criteria validated by an install SMOKE TEST (provision a container,
# run the scripts, probe), not the unit/BDD harness. Roles/values only — no secrets.

Feature: One-liner deployment & update — easy to deploy, easy to update

  Two host-side one-liners stand up and update orwell (the TS engine + the orwell front-end,
  wired over local MCP) inside a container, without losing the save.

  Scenario: A fresh one-liner install brings the app up
    Given a fresh Proxmox host
    When the install one-liner is run
    Then a container is created running the engine and the front-end as services
    And the UI is reachable on its port
    And the only manual step is entering the LLM provider configuration

  Scenario: The update one-liner updates without losing the save
    Given an installed orwell container with an accumulated save
    When the update one-liner is run
    Then the code is pulled, rebuilt, and the services restarted
    And the previous save (state and souls) is still present

  Scenario: Both scripts are idempotent
    When the install or update one-liner is run a second time
    Then it completes safely without duplicating or breaking the install

  Scenario: Secrets never live in the repo
    Given the deploy and update scripts and the committed config
    Then no LLM key or other secret is committed or baked into a script
    And all secrets are read from env or the data-directory .env

  Scenario: The container is the game sandbox
    Given an installed orwell container
    Then the game's state lives under a persistent data directory in that container
    And that directory survives updates
