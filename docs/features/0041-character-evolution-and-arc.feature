# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0041 — Character evolution & season arc: live soul emotional evolution that modulates behavior,
# accumulates as a recall-able arc, while the static CHARACTER stays byte-stable. Hidden layer only.
# HARD rule: roles only (houseguest, HOH, nominee, evictee). Add to cucumber.cjs when green.

Feature: Character evolution & season arc

  A season changes a houseguest. Consequential events move their hidden emotional state, that state bends
  their later competitions and decisions, and the trajectory accumulates into a recall-able arc — yet their
  static character baseline never changes, and the player sees the change only as behavior, never a number.

  Scenario: A blindside shifts the houseguest's emotional state
    Given a houseguest with a settled emotional state
    # AMEND 0041 #3: honest label - this drives the soul-evolution FUNCTION (`evolveEmotion`) directly; the LIVE hook (the consequence fold calling it) is covered by tests/unit/emotionalModifierLive.test.ts.
    When they live through a blindside in the soul-evolution function
    Then their hidden emotional state shifts toward distress and volatility

  Scenario: The shift modulates later behavior
    Given the same houseguest rattled versus calm
    When each plays a competition and faces a decision
    Then the rattled version behaves measurably differently from the calm version
    But emotion never overrides a hard rule

  Scenario: The change accumulates into a persisted arc
    Given a houseguest who has been through several season-shaping events
    Then their soul accumulates those moments without losing earlier ones
    And a specific past inflection is held in the persisted arc and survives save and resume

  Scenario: The static character stays byte-stable while the soul drifts
    Given a houseguest at the start and deep into the season
    Then their static character baseline is unchanged
    And only their dynamic soul has drifted

  Scenario: Emotional drift is bounded, mean-reverting, and deterministic
    Given a houseguest whose emotional state spiked
    When the game calms for a stretch
    Then their emotional state reverts toward their baseline within bounds
    And the same seed reproduces the same arc

  Scenario: The evolution is Vault-free
    Given a started game whose houseguests have evolved
    When the player's surfaces are read after the houseguests evolve
    Then no emotional number or hidden state appears
