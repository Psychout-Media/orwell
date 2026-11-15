# RETIRED 2026-11-11 (owner ruling, "retire and remove"): not planned, code and tests removed (card ORW-267). Kept as history only; not wired.
# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
Feature: 0103 — Edit-bay foreshadowing (the show is telling you something)
  Reality TV tells you something is coming before it does — the camera lingers on two
  houseguests in a corner, an aside is cut short, a glance is held — and a week or two later
  it pays off as "I knew it". This feature occasionally emits a Vault-SAFE production-edit HINT
  that foreshadows a pathway ALREADY IN MOTION in the hidden layer (a live scheme, a brewing
  secret, a campaign building toward a vote). A hint surfaces only a public, in-room
  observation — never a sealed secret, never a number — and NEVER commits the engine to an
  outcome: the seed still decides, and a hint can be a deliberate fake-out. The engine owns
  whether the show nods, which in-motion pathway it nods at, and the pace; the model only
  voices the edit as texture. A fired hint is recorded as the player's own observation so a
  later payoff can land as "I knew it". The Vault Wall holds for player AND admin.

  # Role-only (testing rule): the-player, a houseguest, a schemer, an ally, a rival, a bystander, an admin.

  Background:
    Given a started season with the player in the house
    And edit-bay foreshadowing is enabled

  Rule: A hint foreshadows only a pathway already in motion, through a public observation

    Scenario: The show nods at a scheme that is already underway
      Given a schemer is running an in-motion campaign that has not yet paid off
      And the schemer is conspicuously together with an ally in a room the player can observe
      When the off-screen life runs and the show edits the moment
      Then the player catches a Vault-safe hint that something is building
      And the hint is hung on the public observation the player could see in the room
      And the hint reveals neither the scheme's target nor its plan nor any sealed premise

    Scenario: A dormant, never-started pathway is never foreshadowed
      Given a houseguest is sitting on a sealed secret that has not been activated
      And nothing about that secret is in motion in the house
      When the off-screen life runs over several weeks
      Then the show never nods at that dormant secret
      And no hint about it ever reaches the player

    Scenario: A hint needs a real public observation to hang on
      Given a pathway is in motion entirely off-screen with no public surface yet
      When the off-screen life runs
      Then no hint is emitted for that pathway
      And the show never invents an observation that did not happen

  Rule: A hint never commits the outcome — the seed decides, and the edit can mislead

    Scenario: A foreshadowed scheme can still fail (the fake-out)
      Given the player caught an earlier hint that a campaign was building
      When the seeded vote resolves against that campaign and it fails
      Then nothing about the earlier hint is corrected or apologized for
      And the recorded hint remains as part of the season's texture
      And the player learns that the edit can mislead

    Scenario: A hint moves nothing in the closed set
      Given a pathway is in motion and eligible to be foreshadowed
      When the show fires a hint about it
      Then no relationship weight is folded by the hint
      And the in-motion pathway is not advanced by the hint
      And the seeded competition, vote, and jury outcomes are byte-identical whether or not the hint fired

    Scenario: A foreshadowed payoff lands as "I knew it" from the player's own observation
      Given the player caught a hint that something around a rival was building
      When that pathway later pays off through its own modeled pathway
      Then the payoff may reference the player's earlier recorded observation
      And nothing in that reference carries a sealed premise or a number

  Rule: The pace is scarce and variable — a nod now and then, never every week

    Scenario: The hint budget caps how often the show nods
      Given several pathways are all in motion and eligible to be foreshadowed
      When the off-screen life runs across the week
      Then the number of hints the player catches does not exceed the weekly hint ceiling
      And the season-long number of hints never exceeds the season cap
      And a pathway already foreshadowed is not nodded at again immediately

  Rule: The engine schedules; the model only voices; the Vault holds for player and admin

    Scenario: The schedule and the hint internals never reach any surface
      Given a season with pathways in motion and an active foreshadow schedule
      When the player-facing surfaces and the admin surface are assembled
      Then no sealed premise, target, or plan appears on the player surface
      And no sealed premise, target, or plan appears on the admin surface
      And the foreshadow fit scores, the hint counter, and any number never appear on any surface

    Scenario: The foreshadow layer is deterministic and calibration-neutral when off
      Given two seasons played from the same seed and the same history
      Then the hints that fire and the weeks they fire in are identical
      Given a season played with edit-bay foreshadowing disabled
      Then no foreshadow draws are taken
      And the seeded competition, vote, and jury outcomes are byte-identical to the un-hinted game
