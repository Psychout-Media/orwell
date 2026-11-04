# Executable spec — now IMPLEMENTED & green (originally drafted failing-first). Expands 0041 (character evolution): independent affect
# axes (confident AND on-edge at once), strategic-temperament drift (a burned houseguest hardens, mean-
# reverting), and personality-tuned reactivity (a temperamental houseguest is more sensitive + settles
# slower). Hidden layer only, calibration-safe (ORWELL_SOUL_DEPTH is default ON by code since #1996; =0 rolls back). HARD rule: roles only
# (houseguest, HOH, nominee) — no names. (Built and wired into cucumber.cjs.)

Feature: Deeper character evolution

  0041 made a season change a houseguest, but on one dial, personality-flat, and mood-only. This deepens
  it: feelings become independent (confident AND rattled at once), a houseguest's strategy hardens under
  pressure and mean-reverts when it calms, and a temperamental houseguest is genuinely more reactive than
  an even-keeled one. All hidden — the player feels it only through behavior, never a number — and the
  static character never changes.

  Scenario: Confidence and distress move on independent axes
    Given a houseguest who won a competition and then got blindsided, with soul-depth on
    Then their confidence and their distress are both high at once
    And with soul-depth off only the single calm-versus-rattled dial moves

  Scenario: The distress axis drags a competition even when confidence is high
    Given a confident-but-distressed houseguest versus a purely confident one
    When each plays a competition
    Then the distressed one competes measurably worse despite the confidence

  Scenario: A repeatedly-betrayed houseguest hardens toward paranoia
    Given a trusting houseguest betrayed several times, with soul-depth on
    Then their effective temperament drifts toward paranoia
    And their static character disposition is unchanged
    And a calm stretch reverts the temperament toward their true baseline

  Scenario: The hardened temperament bends a live decision
    Given the same houseguest before and after they hardened
    When each makes an HOH nomination decision
    Then the hardened version nominates differently from their trusting self
    But the decision never breaks a hard rule

  Scenario: A temperamental houseguest is more reactive than an even-keeled one
    Given a combative houseguest and an even-keeled houseguest facing the same shock, with soul-depth on
    Then the combative houseguest's on-edge dial swings harder
    And the combative houseguest settles slower over a calm stretch

  Scenario: Reactivity is disposition-derived and calibration-safe
    Given soul-depth off
    Then an NPC's starting reactivity is the legacy random draw and the seeded spine is unmoved
    And with soul-depth on it is derived from their disposition, drawing no extra randomness

  Scenario: The deeper evolution is Vault-free and deterministic
    Given a started game whose houseguests evolved with soul-depth on
    When the player's surfaces are read
    Then no affect axis, temperament, or reactivity number appears
    And the same seed reproduces the same axes, drift, and reactivity
