Feature: 0095 — Pre-show ties as time-bombs (a sealed pre-alliance detonates when exposed)
  A hidden pre-show tie (seeded by 0059 — two houseguests who knew each other before the show)
  stays Vault-sealed off the player AND the admin until a legitimate in-game pathway surfaces it
  (an overhear, a slip, an accusation that lands). When it is EXPOSED, the engine folds a bounded,
  seeded, house-shaking fallout: a betrayal-grade blow on the deceived edges and the house reading
  the pair as a hidden duo to target. The engine decides whether, which, to whom, and how big; the
  model only voices an exposure the engine has already committed. The tie reaches the player only
  through a pathway that terminates at them, recorded as the player's own knowledge.

  # Role-only (testing rule): the-player, a tied pair, a deceived houseguest, an onlooker,
  # a near-stranger pair, the house.

  Background:
    Given a started season with the player in the house
    And the hidden seeded relationship layer holds a pre-show tie between two houseguests

  Rule: A sealed tie never leaks before a pathway surfaces it — to player OR admin

    Scenario: The sealed tie is invisible on every surface
      Given the tie has not been exposed by any pathway
      Then the tie never appears on any player-facing surface
      And the tie never appears on any admin or God-Mode surface
      And the only trace of the tie is the houseguests' behavior, never a stated fact or a number

    Scenario: No pathway, no surfacing
      Given the tied pair is not conspicuous together
      And neither of the pair is under enough strain to let it slip
      And no one has accused the pair of a prior connection
      Then the tie stays sealed
      And no exposure is recorded
      And the house reads the pair as it would any other two houseguests

  Rule: A pathway exposes the tie and the house reacts

    Scenario: An overheard pairing surfaces the tie to the house
      Given the tied pair is conspicuously holed up together in a private room
      And a plausibly-positioned third houseguest is around to notice
      When the off-screen society tick fires the overhear pathway
      Then the tie is surfaced to the house through that onlooker
      And the houseguests who learn of it read the pair as a hidden duo to target
      And their trust in both members of the pair falls and their threat read of both rises
      And the fallout is bounded and never a flat house-wide flag

    Scenario: An accusation that lands exposes the tie and folds the fallout
      Given the player suspects the pair knew each other before the show
      When the player accuses the pair of a prior connection through the engine authority
      Then the engine confirms a real tie exists and the accusation lands
      And the exposure is recorded as the player's own knowledge through the pathway with content lineage
      And the secret pre-alliance coming out deals the deceived houseguests a betrayal-grade blow toward both members
      And the player is shown no number and no tell

    Scenario: An accusation against an untied pair misses
      Given a pair of near-strangers with no seeded tie
      When the player accuses that pair of a prior connection through the engine authority
      Then the accusation misses
      And no tie is surfaced and no sealed state is read
      And a wrong accusation costs the accuser: each wrongly accused houseguest thinks less of the player, by a bounded amount
      And nothing else sealed or hidden moves
      And the player is shown no number and no tell distinguishing a miss from a hit

  Rule: The engine decides and records; the model only voices

    Scenario: The model is never handed an unexposed tie
      Given the tie has not been exposed
      When the model fetches the houseguests' voices for a scene
      Then the voices carry no sealed tie content
      And only an exposure the engine has already committed is ever voiced as a public fact

    Scenario: The exposure reaches the player only through a pathway
      Given the tie has surfaced among the houseguests off-screen
      And no diffusion chain has yet reached the player
      Then the player holds no belief about the tie
      When a retelling chain finally terminates at the player
      Then the player learns of the tie as a belief with a source and a confidence
      And that belief is the player's recorded knowledge, never Vault content

  Rule: Exposures are rare, persisted, and calibration-neutral

    Scenario: The exposure state persists and is monotonic across a restart
      Given the tie has been exposed and is now public
      When the tie-reveal game is saved and restored
      Then the restored game still records the tie as exposed
      And the exposure never regresses to a less-exposed state

    Scenario: Lies-free exposures are capped across a season
      Given a full season of tie reveals is played
      Then the number of exposed pre-show ties never exceeds the season cap

    Scenario: With the feature off, the seeded outcomes are byte-identical
      Given the same seed is played with the tie-reveal feature off and on without a precipitant
      Then no exposure roll is taken and no relationship edge is touched
      And the seeded competition, jury, and eviction outcomes are byte-identical
