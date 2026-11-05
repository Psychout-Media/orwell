Feature: 0096 — Emergent nemesis (a personal villain to outlast)
  When one houseguest carries the highest SUSTAINED threat toward the player, the engine
  elevates them into a felt recurring antagonist: it biases that houseguest's EXISTING
  campaign (0085) and target drive (0086) toward the player so the rivalry persists,
  escalates, and recruits — a personal villain to outlast. The engine alone decides who,
  whether, and how hard (seeded, anti-sycophancy); the model only voices the behavior. The
  nemesis is hidden engine state — the player witnesses only behavior, never a number, and the
  Vault Wall holds for the player AND the admin. The nemesis is organic: it can shift, hand
  off, or never form.

  # Role-only (testing rule): the-player, a houseguest, the nemesis, a rival, a bystander, the admin.

  Background:
    Given a started season with the player in the house
    And the campaign layer is enabled

  Rule: A nemesis emerges only from SUSTAINED threat toward the player

    Scenario: A sustained high-threat houseguest is elevated to nemesis
      Given a houseguest whose threat toward the player stays high across several ticks
      And whose sticky drive is aimed at targeting the player
      When the engine advances the campaign tick
      Then that houseguest is held as the player's nemesis
      And their existing campaign is biased toward evicting the player
      And their target drive is held on the player at the upper of its intensity band

    Scenario: A one-week spike does not make a nemesis
      Given a houseguest whose threat toward the player spikes for a single tick
      When the engine advances the campaign tick
      Then no houseguest is the player's nemesis
      And no escalation bias is applied to anyone toward the player

    Scenario: A peaceful season produces no nemesis
      Given no houseguest sustains a high threat toward the player
      When the season plays on
      Then there is no nemesis at any point
      And the player faces no escalating personal antagonist

  Rule: The nemesis is organic — it can shift and hand off

    Scenario: The nemesis lapses when the rival's threat releases
      Given a houseguest held as the player's nemesis
      When their threat toward the player decays and their drive re-aims off the player
      And the engine advances the campaign tick
      Then that houseguest is no longer the player's nemesis
      And no escalation bias is applied toward the player

    Scenario: A new sustained rival takes over the nemesis arc
      Given a houseguest held as the player's nemesis
      And a different rival whose sustained threat toward the player clearly overtakes them
      When the engine advances the campaign tick
      Then the rival becomes the player's nemesis
      And at most one houseguest is the player's nemesis at a time

  Rule: The rivalry is behavior-only — Vault-Wall holds for player AND admin

    Scenario: No surface ever names the nemesis or a number
      Given a houseguest held as the player's nemesis
      When the player checks every player-facing surface for the rivalry
      And the admin views any God-Mode surface
      Then neither surface returns the nemesis identity
      And neither surface returns a threat number, a hostility score, or an escalation tier
      And the player learns of the rivalry only through what the nemesis does

    Scenario: The model is handed a tone, never the machinery
      Given a houseguest held as the player's nemesis
      When the player is in a scene with that houseguest
      Then the houseguest's voice carries a Vault-safe adversarial tone hint
      And the voice carries no threat number and no statement that they are the nemesis
      And no nemesis hint is offered outside a live scene with that houseguest

  Rule: The nemesis never adds magnitude beyond the existing tilt, and stays deterministic

    Scenario: A sustained nemesis raises the player's danger without new vote magnitude
      Given a houseguest held as the player's nemesis with a sustained campaign against the player
      When the season's evictions are tallied across seeds
      Then the player's eviction danger is higher than a no-nemesis baseline
      And the vote effect is carried by the existing campaign and drive tilt with no new term

    Scenario: A houseguest aware of the nemesis campaign weighs the player more heavily when naming nominees
      Given a houseguest held as the player's nemesis
      When a houseguest who knows of that campaign weighs the player for nomination
      Then the player's nomination push from that houseguest is positive
      And a houseguest who does not know of the campaign feels no push

    Scenario: With the campaign layer off, outcomes are byte-identical
      Given the campaign layer is disabled
      When the same seeded season is played
      Then no nemesis is computed and no escalation bias is applied
      And the seeded competition and eviction outcomes are byte-identical to the no-campaign baseline

    Scenario: The nemesis arc survives a save and restore
      Given a houseguest held as the player's nemesis
      When the game is saved and restored into a fresh context
      Then the same houseguest is still the player's nemesis
      And the rivalry's accumulated history is recalled in full
