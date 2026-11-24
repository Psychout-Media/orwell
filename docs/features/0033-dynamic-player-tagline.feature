# spec-only: gated by tests/unit/playerTagline.test.ts; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Executable spec — IMPLEMENTED; shipped UNIT-GATED (tests/unit/playerTagline.test.ts) + the FE
# render in frontend/tests/ — never added to cucumber.cjs (recorded deviation, audit E87a).
# Feature 0033 — Dynamic player tagline (the snarky, state-aware homepage hero line).
# Engine GENERATES it (Vault-free, via NarrativePort 0027); the front-end RENDERS it at #welcome-sub.
# HARD rule: roles only (player, HOH, nominee). "standing" = a PUBLIC facet only — never hidden state.
# Engine scenarios run under the TS gate (seeded fake narrator); the render swap is tested in frontend/.

Feature: Dynamic player tagline

  The homepage hero line is a single snarky Big Brother one-liner that the engine generates from the
  player's current PUBLIC game state and the front-end renders in place of "Yours for the voyage." It
  is Vault-free by construction, reflects engine truth (never flatters), changes as the game advances,
  and fails open to a static themed line.

  Scenario: The tagline reflects the player's current public standing
    Given a started game in which the player is a nominee
    When the player tagline is generated
    Then it is a single line in the Big Brother house voice
    And it reflects the player's public standing this week

  Scenario: A different moment yields a different line
    Given a started game
    When the tagline is generated at one phase and again after the game advances to a new phase
    Then the two lines differ
    And within a single moment the line is cached, not regenerated on every read

  Scenario: Before any game exists, a themed welcome line is shown
    Given no game has started for the player
    When the player tagline is requested
    Then a snarky pre-game welcome line is returned
    And it promises nothing about a game that does not exist yet

  Scenario: The tagline is Vault-free
    Given a started game whose Vault holds hidden votes, targeting, and off-screen scheming
    When the player tagline is generated
    Then it contains no hidden vote, target, soul, or off-screen content
    And it carries no Vault sentinel value

  Scenario: The tagline is anti-sycophantic
    Given a started game in which the player's public standing is weak
    When the player tagline is generated
    Then it does not flatter the player or assert a strength they do not hold
    And it reflects the engine's public truth about their position

  Scenario: It is one line in the hero placement
    When the tagline is rendered on the homepage
    Then it replaces the static "Yours for the voyage." subtitle
    And it is a single line within the bounded hero length

  Scenario: It fails open when the narrator is unavailable
    Given the narrator or engine is unavailable
    When the homepage renders the hero line
    Then a static themed line is shown
    And the line is never empty and never blocks the page
