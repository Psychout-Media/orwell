Feature: 0087 — Relationship trajectories (a bond that warms or curdles, with momentum)
  Each directed relationship carries a hidden, engine-owned MOMENTUM — the direction the bond is
  moving — alongside its position. Momentum biases off-screen scene-NATURE selection so consecutive
  scenes between a pair continue the arc instead of whiplashing bond → clash → bond. A friendship
  visibly curdles over weeks. The momentum term is Vault-class hidden state: it reaches the player
  ONLY through behavior (the kinds of scenes that happen and the tone the model voices), never as a
  number, and never to admin/God Mode. It re-weights an existing seeded draw without adding one, so
  the calibration spine stays byte-identical when off and in phase when on.

  # Role-only (testing rule): the-player, an NPC, another NPC, a third NPC, the HOH, a nominee.

  Background:
    Given a started season with the live off-screen society enabled

  Rule: A relationship has momentum, and momentum biases the arc

    Scenario: A consistent run of warm scenes builds warming momentum
      Given an NPC and another NPC with a string of recent bonding scenes between them
      When their relationship trajectory is derived
      Then the trajectory phase is warming
      And the momentum is greater than for a pair with mixed, contradictory scenes

    Scenario: A curdling friendship plays out as an arc over weeks
      Given an NPC and another NPC who were close and then fell into souring scenes
      When the off-screen society runs over several in-game days
      Then the distribution of scene natures between them tilts toward conflict as the arc continues
      And the pair does not whiplash back to bonding the next tick
      And the player only learns of the cooling through overheard or relayed clash scenes

    Scenario: A betrayal injects strong souring momentum
      Given an NPC who has just been betrayed off-screen by another NPC
      When the trajectory is derived from the recent fold
      Then the phase is souring
      And the momentum is high

  Rule: The engine owns momentum; the model only proposes shape

    # ORW-335: a player scene's consequence descriptor does not feed trajectories (only off-screen NPC-to-NPC folds do); this pins the
    # direction-not-magnitude rule on the fold itself.
    Scenario: A cooler-shaped fold feeds direction, never magnitude
      Given a cooler-shaped fold lands between two houseguests
      When the engine folds the scene and updates the trajectory
      Then the trajectory direction reflects the proposed shape
      And the momentum magnitude is the engine's own bounded, seeded amount
      And no number proposed by the model sets how far the momentum moved

  Rule: Momentum is hidden state — surfaced only through behavior (player AND admin)

    Scenario: The momentum term never appears on any player-facing surface
      Given an NPC and another NPC with strong souring momentum between them
      When the player views the house, an NPC's voice, and every status surface
      Then no trajectory phase or momentum value appears on any of them
      And the souring is observable only as the kinds of scenes that reach the player

    Scenario: Admin and God Mode are walled from momentum too
      Given a relationship trajectory exists in the hidden engine layer
      When an administrator inspects every God-Mode and admin projection
      Then no trajectory phase or momentum value is returned on any of them

  Rule: The arc bends probabilities, it never railroads

    Scenario: A strong underlying tie can still produce an off-arc scene
      Given an NPC and another NPC with a strong bond but high souring momentum
      When many off-screen scenes are drawn between them over a seeded batch
      Then most scenes continue the souring arc
      But off-arc reconciliation scenes still occur at a nonzero rate
      And no betrayal is ever produced unless the prior-bond and incentive gate is already met

  Rule: Deterministic and calibration-neutral

    # Only the OFF-path off-screen draw stream and scene natures are gated: tests/unit/trajectoryOutcomeNeutral.test.ts (no
    # provider vs a STEADY provider, same seeds, draws + natures compared). Competition/vote byte-identity vs the pre-feature
    # build is NOT asserted anywhere (trajectories touch only the off-screen nature pick; the OFF path is the pre-feature path by
    # construction). The former BDD scenario compared an OFF run to another OFF run.

    Scenario: With trajectories on the off-screen draw stream stays in phase
      Given a fixed seed and the trajectory layer enabled
      When the off-screen society is run
      Then the number and order of random draws in the off-screen stream are unchanged
      And only which nature each draw lands on shifts
      And the seeded competitions and votes that read the same stream stay in phase

    Scenario: Same seed and history reproduce the same trajectory
      Given the same seed and the same folded relationship history
      When the trajectory is derived twice
      Then the phase and momentum are identical both times

  Rule: Momentum persists and never degrades

    Scenario: A restored game resumes mid-arc
      Given an NPC and another NPC mid-curdle with souring momentum
      When the game is saved and restored
      Then the trajectory resumes at the same phase and momentum
      And a save written before this feature loads at a steady phase with no error
