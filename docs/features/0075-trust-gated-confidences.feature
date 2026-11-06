Feature: 0075 — Trust-gated confidences (a houseguest opens up to you)
  A houseguest confides a real secret in the player only when they have a REASON to —
  an earned bond, a banked favor, an owed debt — and the strength of that reason decides
  HOW MUCH of the secret is told. The engine decides whether, which, how much, and whether
  it is even true; the model only voices what the engine discloses and records. The Vault
  Wall holds: a secret becomes the player's knowledge only through the modeled pathway of a
  houseguest telling them, recorded as a player-witnessed event.

  # Role-only (testing rule): the-player, a houseguest, an ally, a near-stranger, a schemer.

  Background:
    Given a started season with the player in the house

  Rule: A confidence requires a reason, and never crosses without one

    Scenario: A near-stranger never opens up
      Given a houseguest the player has no bond or favor with
      When the player presses them to open up
      Then no secret is disclosed
      And the player learns nothing the houseguest has not said in the room
      And the houseguest's sealed secret never appears on any player-facing surface

    Scenario: The reason decides how much is told
      Given an ally whose mutual bond and banked favors place the disclosure motive in the partial band
      When the player draws them out in a scene
      Then the houseguest discloses a partial, hedged version of the secret
      And the full sealed premise does not cross
      When the player has banked further goodwill so the motive reaches the full band
      And the player draws them out again
      Then the houseguest discloses the whole secret in their own words
      And that secret is now the player's recorded knowledge

  Rule: The engine decides and records; the model only voices

    Scenario: A disclosed secret becomes player knowledge through the pathway
      Given an ally whose disclosure motive is in the full band
      When the engine fires a confidence in the player's scene
      Then the disclosure is recorded as a player-witnessed event with content lineage
      And the secret is Journal-visible to the player
      And the confiding deepens the bond between the player and the ally
      And no number is ever shown to the player

    Scenario: The model is never handed an undisclosed secret
      Given an ally who has not yet confided
      When the model fetches the houseguest's voice for a scene
      Then the voice carries no sealed secret content
      And at most a Vault-safe reason-to-open-up hint when the motive and a fresh precipitating event are present

  Rule: Earned and anchored — never a cold pop-up

    Scenario: No confidence surfaces outside a live scene with that houseguest
      Given an ally whose disclosure motive would otherwise allow a confidence
      And the player is not in a scene with that ally
      Then no reason-to-open-up hint is offered for that ally
      And no off-screen process starts a confidence scene on its own

    Scenario: An emergent confidence is precipitated by a fresh reason
      Given an ally the player just did an in-game favor for
      When the player is in a scene with that ally
      Then the voice carries a reason-to-open-up hint naming the earned reason
      And the confidence reads as prompted by what just happened

  Rule: Houseguests can lie

    Scenario: A schemer can plant a false confidence
      Given a houseguest who reads the player as useful but threatening
      And whose disclosure motive is carried by strategy, not closeness
      When the engine fires a confidence
      Then the disclosed content is a fabricated admission, not a real secret of any houseguest
      And the player surface shows the claim with no truth marker and no tell
      And the player's resulting belief is recorded as untrue in the hidden layer

    Scenario: A later true pathway catches the lie
      Given the player believes a false confidence
      When a genuine pathway later delivers the contradicting truth
      Then the player's belief flips to the truth
      And acting on the lie deals the liar a betrayal-grade trust blow

    Scenario: Lies are rare across a season
      Given a full season is played
      Then false confidences stay rare, held down by consequences rather than a hard cap
