# Executable spec — BUILT & green; BDD-gated in cucumber.cjs. Opt-in ORWELL_REACTIVE_TWISTS.
# Feature 0025 (reactive redesign, PO ruling 2026-07-06) — a STANDING POOL the live house earns.
# All three twists (double eviction, secret veto, battle-back) sit armed from game start; each fires
# when the house reaches a state that earns it, on per-season seeded triggers; all three may fire in one
# season, each at most once; sealed from player AND admin until it fires; always format-preserving.
# HARD rule: roles only (HOH, nominee, evictee, juror, the-player). No names.
# Legacy pre-scheduled path (flag off) is byte-identical; the reactive path is proven with the flag on.

Feature: Reserve twists — a standing pool of surprises the live house earns, sealed from everyone

  Background:
    Given a running game sandbox with the reserve-twist pool armed and sealed in the Vault

  Rule: All three twists stand ready in the pool, watching for their trigger (reactive, not pre-scheduled)

    Scenario: The pool arms all three twists from game start
      Given a new season with the reactive pool armed
      Then the double eviction, the secret veto, and the battle-back are each watchable in the plan
      And none has a pre-decided fire week
      And no player-facing or admin-facing surface reveals the pool

    Scenario: A twist fires only when the live house reaches its trigger
      Given a season whose house never reaches the double-eviction trigger
      Then the double eviction never fires

  Rule: The triggers are dynamic — the same conditions do not recur every season

    Scenario: Two different seasons trigger a twist under different conditions
      Given two seasons whose seeded twist thresholds differ
      Then the double eviction targets a different house size across the two seasons

  Rule: A twist can be earned but still held back (some seasons stay quiet)

    Scenario: An eligible trigger does not always fire
      Given many seasons that each reach the secret-veto trigger
      Then in some the secret veto is armed and in others it is held back
      And whether it is armed is reproducible under the season's seed

  Rule: Each twist fires at most once; all three may fire in one season

    Scenario: A single season can fire all three twists, each once
      Given a live season in which each twist mechanic is driven to fire
      Then the double eviction, the secret veto, and the battle-back each fire exactly once
      And no twist fires twice

    Scenario: One reactive twist arms per week roll (the cooldown spaces them)
      Given two triggers are eligible on the same roll
      Then only one twist arms that roll and the other defers to a later week

  Rule: Twists involving the player are the player's to play (agency)

    Scenario: A secret veto granted to the player is the player's to hold and play
      Given the secret veto is granted to the player while they are on the block
      Then the player is offered the choice to play the secret veto
      And the engine does not play it for them

    Scenario: A secret veto granted to an NPC is resolved by the engine
      Given the secret veto is granted to a houseguest while they are on the block
      Then the engine plays it off the block for them
      And exactly one houseguest is still evicted that week

    Scenario: A battle-back the player is eligible for is the player's to compete
      Given the player sits among the recently-evicted jurors when the battle-back fires
      Then the player is a competitor in the battle-back

  Rule: Sealed from player AND admin until it fires (Vault Wall, both surfaces)

    Scenario: The armed pool is invisible to the player and the admin
      When any player-facing or admin-facing surface is produced before a twist fires
      Then no armed twist, its trigger, or its timing appears
      And no Vault sentinel value appears

    Scenario: Firing a twist reveals it as a witnessed event
      When a reactive reserve twist fires
      Then it becomes a witnessed in-game event
      And only then is it known

  Rule: Every twist is format-preserving (jury of 9 → final 2, hard rules hold)

    Scenario: The secret veto preserves the count — still one eviction that week
      Given the secret veto is played off the block
      Then the protected houseguest is removed from the block
      And a replacement nominee stands
      And exactly one houseguest is evicted that week

    Scenario: The battle-back returns a juror yet the jury still closes at nine
      Given a full live season in which the battle-back fires
      Then one juror re-enters the game
      And the season still reaches a jury of nine and a final two
      And no more than nine jury seats are ever given

    # ORW-1088 (Ryne 2026-11-27): "It shouldn't mix jurors and non jurors in the same battle back."
    Scenario: The battle-back never mixes jurors with pre-jury evictees
      Given the battle-back fires with two jurors seated and five pre-jury evictees out
      Then every battle-back competitor is a juror

  Rule: Deterministic and durable

    Scenario: The same seed reproduces the same twists
      Given a full live season played twice under the same seed
      Then the same twists fire both times

    Scenario: The sealed plan survives an engine restart
      Given a live season with the reactive pool armed
      When the engine restarts mid-season
      Then the restored game still carries the sealed twist plan

  Rule: A double eviction plays as one long night (ORW-652, 2026-11-18)

    Scenario: The second cycle of a double eviction is one continuous night
      Given long night: a played game with a double eviction armed
      When long night: the double eviction plays out
      Then long night: both evictions land inside one in-game day
      And long night: no schedule or bedtime hold interrupts the second cycle
      And long night: the clock only moves forward and the day does not roll

    Scenario: The compression never changes who wins or who leaves
      Given long night: the same seed played with the compression on and off
      Then long night: the same houseguests are evicted and crowned either way

    Scenario: Nobody can turn in mid-night and the narrator is told the night's shape
      Given long night: a played game partway through the second cycle
      When long night: the player says goodnight
      Then long night: the bed is refused until the second eviction is done
      And long night: the narrator is handed one line naming the first evictee, the instant crown and the second eviction
