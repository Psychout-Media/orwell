Feature: 0094 — Distorted gossip has consequences (acting on a wrong belief burns you)
  The belief model already tracks distortion and confidence per rumor, but today a wrong rumor
  plays out identically to a true one. This feature makes the distortion MATTER: the player can
  act on a low-confidence, distorted belief and get burned — the move lands against REALITY, not
  the belief — and discover the truth later (dramatic irony). The engine owns whether a belief is
  true and owns the divergent outcome; the model only voices how the player came to believe it and
  the prose of the reveal. The Vault Wall holds: the player's own (mis)belief is already their
  knowledge, and the engine never reveals WHICH beliefs are wrong — it only lets reality differ.

  # Role-only (testing rule): the-player, an ally, a target, a witness, a near-stranger, an admin.
  # Builds on 0002 (gossip belief model: distortion / confidence / hops / factId / originalContent
  # already exist) and 0023 (the consequence & memory fold). This is consequence + surfacing shaping,
  # not a new belief system.

  Background:
    Given a started season with the player in the house

  Rule: Acting on a distorted belief lands against reality, not the belief

    Scenario: A move justified by a materially distorted rumor backfires
      Given the player holds a heavily distorted, low-confidence rumor that an ally is scheming against them
      And in reality that ally has been loyal
      When the player makes a closed-set move against the ally justified by that rumor
      Then the outcome matches reality rather than the player's belief and the move misfires
      And the wronged ally's hidden read of the player takes a betrayal-grade trust hit
      And the engine never tells the player the move misfired because the belief was wrong

    Scenario: A faithful, high-confidence belief still pays off
      Given the player witnessed a target genuinely scheming against them
      When the player makes the same closed-set move against the target justified by that witnessed fact
      Then the move lands as expected
      And no belief-versus-reality divergence is applied

  Rule: Uncertainty is surfaced behaviorally, never as a number

    Scenario: A shaky second-hand belief is voiced as a hunch, a witnessed one as settled
      Given the player holds a third-hand, low-confidence rumor about a houseguest
      And the player also holds a fact they witnessed first-hand about another houseguest
      When the player brings each up in a scene
      Then the second-hand belief is voiced in terms of how distantly it was heard
      And the witnessed fact is voiced as settled knowledge
      And no confidence number, distortion number, or "this is false" marker is ever shown

  Rule: The truth surfaces later (the dramatic-irony reveal)

    Scenario: A genuine later pathway corrects a belief the player already acted on
      Given the player acted on a distorted belief and was burned
      When a genuine later pathway delivers the true version of that same fact
      Then the player's belief is corrected in place on the same fact lineage
      And the player's realization that they acted on a wrong belief is folded as a recorded beat
      And the corrected belief and the original wrong belief both remain in the player's durable history

  Rule: The Vault Wall holds — the engine never reveals which beliefs are wrong (player AND admin)

    Scenario: No player-facing surface reveals a belief's truth-value or its raw uncertainty
      Given the player holds a distorted belief the engine privately knows is false
      When the player inspects any player-facing surface
      And the player acts on that belief and a later pathway brings the honest correction
      Then no surface marks the belief as false or distorted
      And no raw confidence or distortion number is shown to the player
      And the wrongness is expressed only through a divergent outcome and a later honest correction

    Scenario: God Mode cannot spoil the irony either
      Given the player holds a distorted belief the engine privately knows is false
      When an admin inspects every admin and God-Mode surface
      Then no admin surface reveals which of the player's beliefs are wrong
      And no admin surface exposes the truth-value or the raw distortion of a held belief

  Rule: Calibration-neutral and deterministic

    Scenario: With the feature off the seeded outcomes are byte-identical
      Given the distorted-gossip-consequence feature is disabled
      When a full season is played from a fixed seed
      Then no belief-versus-reality divergence is computed and no extra fold is applied
      And the seeded competition and jury outcomes are byte-identical to the baseline

    Scenario: Same seed and history reproduce the same burn
      Given a fixed seed and an identical history in which the player acts on a distorted belief
      When the season is replayed
      Then the same belief is classified as distorted
      And the same move misfires with the same seeded consequence
