# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Drafted from the 0109 build-ready spec.)
# Feature 0109 — Negotiated deal duration. A promise gains an optional negotiated term; breaking it
# scales with how much life was left, and turning after a mutually-known expiry is fair game.
# HARD rule: roles only (promisor, partner, the wronged party). Amends 0039. The ENGINE owns the magnitude.

# PAT-5 (#1982) VERDICT: producer MISSING (a gap, not deferred: no spec/commit defers it, 15b65172 added DealLedger.make's optional `duration` but nothing in play passes one), so the scaling and the dailyRecap hook are unreachable live; scenarios 1-5 all run the standalone DealLedger/RelationshipModel and are @standalone-module.

Feature: Negotiated deal duration

  A deal (0039) gains an optional negotiated DURATION — either an explicit term the parties named
  (an expiresWeek) or the vague label when it was left unspoken. The negotiated term is the player's
  own knowledge; the betrayal-shock MAGNITUDE it modulates is the engine's, bounded and hidden. A
  break before the term hurts more the more life was left; a break at/after it is fair game (no shock);
  a vague break is softened. No duration and no label reconciles BYTE-IDENTICALLY to 0039.

  # @standalone-module: the deal-duration producer is missing (see the header), so this runs the standalone DealLedger/RelationshipModel; proven by tests/unit/dealDuration.test.ts.
  @standalone-module
  Scenario: A no-duration break is byte-identical to 0039 (the feature is off by default)
    Given a deal with no negotiated duration and no label
    When the promisor breaks it with no week context
    Then the betrayal-shock folded is exactly the unscaled 0039 magnitude

  # @standalone-module: the deal-duration producer is missing (see the header), so this runs the standalone DealLedger/RelationshipModel; proven by tests/unit/dealDuration.test.ts.
  @standalone-module
  Scenario: Explicit expiry is fair game once the term has passed un-broken
    Given a season-horizon deal with an explicit two-week term
    When the negotiated term passes without a break
    Then the engine resolves the deal kept

  # @standalone-module: the deal-duration producer is missing (see the header), so this runs the standalone DealLedger/RelationshipModel; proven by tests/unit/dealDuration.test.ts.
  @standalone-module
  Scenario: Breaking early scales the betrayal-shock up with the life remaining
    Given two identical deals with an explicit term, broken at the same seed
    When one is broken with many weeks of term left and the other with one week left
    Then the many-weeks-left break raises the wronged party's threat more than the one-week-left break

  # @standalone-module: the deal-duration producer is missing (see the header), so this runs the standalone DealLedger/RelationshipModel; proven by tests/unit/dealDuration.test.ts.
  @standalone-module
  Scenario: A vague promise softens the betrayal when broken
    Given an open deal left vague and an equivalent deal with no duration
    When each is broken at the same seed
    Then the vague break folds a smaller betrayal-shock than the no-duration break
    But the vague break is still a betrayal: threat rises and trust falls

  # @standalone-module: the deal-duration producer is missing (see the header), so this runs the standalone DealLedger/RelationshipModel; proven by tests/unit/dealDuration.test.ts.
  @standalone-module
  Scenario: The negotiated term persists; the derived magnitude never reaches the player
    Given a deal with a negotiated term and the vague label
    When the deals are serialized and reloaded
    Then both the term and the label survive the round-trip losslessly
    And the player-facing deal shows the negotiated term but no shock or scale number
