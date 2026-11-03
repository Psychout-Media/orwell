# Executable spec — Feature 0120 (PO expansion of the 0038 review). Seeded engine only, roles only, no
# cast names. The hidden off-screen scheming is walled from the player.
#
# Sharper / more-strategic houseguests initiate the off-screen scheming a touch more often — a SLIGHT,
# bounded variance — while the seeded spine stays byte-identical when the layer is off.

Feature: Strategic-drive off-screen cadence

  In a real house, the schemers drive the game a little more than the passive players. When this layer is
  on, a houseguest's strategic intelligence and personality gently weight how often they start an off-screen
  scene — a slight variance, never a wild skew. When it is off, everyone starts scenes equally (the seeded
  society is byte-identical). It never crosses the Vault Wall.

  Scenario: A sharper, more-strategic houseguest carries a higher drive
    Given a started game with a scheming house
    When each houseguest's strategic drive is read
    Then a sharper, more-strategic houseguest weighs more than a passive one
    And the difference is slight, never a wild skew

  # (The OFF path passes no drive provider, i.e. it IS the uniform draw, by construction — no independent pre-feature baseline
  #  exists to compare against, so no OFF-neutral claim is asserted. The former OFF-vs-OFF "byte-identical" scenario was removed.
  #  The real ON-vs-OFF contrast is the scenario below.)

  Scenario: Turning the cadence on shifts who schemes, still deterministically
    Given the same seed with the strategic cadence on versus off
    When the same off-screen ticks run on each
    Then the on cadence changes the off-screen initiator pattern
    And the on cadence is itself seed-deterministic

  Scenario: The cadence never crosses the Vault Wall
    Given a started game with the strategic cadence on
    When the cadenced off-screen society runs several ticks
    Then no off-screen scene is witnessed by the player
