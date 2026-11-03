# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0027 — NarrativePort LLM adapter. Async, streaming, Vault-free input, never alters outcomes.
# HARD rule: roles only. The narrator voices; the engine decides.

# PAT-5 (#1982): `LlmNarrativePort`/`buildStreamingNarrator`/`loadNarratorConfig` have NO production caller (the engine composes EchoNarrativePort; real LLM narration runs
# in the Python FE off the engine's `assembleNarrationContext` + `getMomentPrompt`). The two context/outcome scenarios drive that LIVE seam; the adapter-only ones are @standalone-module.

Feature: NarrativePort LLM adapter — a real narrator that voices, never decides

  The async LLM behind NarrativePort streams narration from only the Vault-free NarrationContext.
  It cannot see Vault data and cannot change a game outcome — those are the engine's, handed in as
  already-settled context.

  Background:
    Given a running game sandbox with a fully populated Producer's Vault

  Scenario: The adapter receives only Vault-free context
    When narration is requested for the player
    Then the context handed to the adapter contains no Vault sentinel value
    And it contains only the visible projection and the moment prompt

  Scenario: Streaming concatenates to the full narration
    Given the deterministic test narrator
    When narration is streamed token by token
    Then the concatenated stream equals the full narration

  # @standalone-module: LlmNarrativePort's timeout/error fallback, proven by tests/unit/narrativePort.test.ts. The live narration failure path is
  # the Python FE's (frontend/tests/test_1599_failsoft.py, frontend/tests/test_no_silent_failsoft.py); the engine never calls an LLM.
  @standalone-module
  Scenario: A narration failure leaves game state untouched
    Given the narrator provider times out or errors
    When narration is requested for a resolved beat
    Then a safe fallback line is produced
    And the game state is unchanged
    And re-reading the engine gives the same result

  Scenario: Narration never changes an outcome
    Given the engine has decided a competition result
    When the narrator produces narration for it
    Then the engine's result is unchanged
    And even a hallucinated result in the prose changes no game state

  # @standalone-module: loadNarratorConfig is only reachable through the uncalled buildStreamingNarrator, proven by tests/unit/narrativePort.test.ts
  # ("config comes from env"); the FE's own provider config is Python-side.
  @standalone-module
  Scenario: The provider and secrets come from config, never code
    When the adapter is configured
    Then the provider, endpoint, and model come from the environment
    And no secret is read from committed source
