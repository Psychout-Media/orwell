# RETIRED 2026-11-11 (owner ruling, "retire and remove"): not planned, code and tests removed (card ORW-267). Kept as history only; not wired.
# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Feature 0097 — The suspicion ledger. Tracks #878. SPEC (PO review pending) — drafted failing-first.
# The player logs private hunches in their own words; the game pays them off or refutes them
# against the hidden truth ONLY at a sanctioned reveal (an in-game pathway/outcome, or the
# post-season Vault unseal) — NEVER by a live Vault read. Built on 0013 (the Diary Room: the hunch
# is the player's own knowledge with NO NPC pathway) and the knowledge/event store.
# HARD rule: roles only — no names. Roles used: the-player, a houseguest, the HOH, a nominee,
# the veto winner, an evictee, an ally, a schemer, the admin.

Feature: The suspicion ledger — a player-private "called it / wrong" scorecard

  A private list of the player's stated hunches that the game later pays off or refutes against
  the hidden truth, only at a sanctioned reveal. It is the player's own knowledge, it never
  reaches any NPC, and scoring never reads the Vault live.

  Background:
    Given a running game sandbox with a fully populated Producer's Vault

  Rule: A hunch is the player's own knowledge and reaches no NPC (the 0013 Diary Room wall)

    Scenario: Logging a hunch records the player's own words, privately
      When the player logs a hunch about the house in their own words
      Then the hunch is part of the player's own knowledge
      And the hunch is stored verbatim
      And the hunch appears on the player's suspicion ledger as unresolved
      And no houseguest's knowledge state gains that hunch
      And no houseguest decision changes because of it

  Rule: Scoring happens ONLY at a sanctioned reveal, never by a live Vault read

    Scenario: A hunch about a secret stays unresolved until the truth is revealed
      Given the player has logged a hunch about a houseguest's hidden secret
      Then the hunch stays unresolved on the ledger
      And no detail of the hidden secret appears on any player-facing surface
      And the secret's sentinel value does not appear on the ledger

    Scenario: An in-game reveal pays off a correct hunch
      Given the player has logged a hunch that names what an eviction vote will be
      When the eviction tally is revealed at the ceremony
      Then the matching hunch is marked called-it on the ledger
      And the verdict references only the now-revealed tally
      And no number from the hidden layer is shown to the player

    Scenario: An in-game reveal refutes a wrong hunch
      Given the player has logged a hunch that the veto winner will use the veto
      When the veto ceremony reveals the veto was not used
      Then the matching hunch is marked wrong on the ledger
      And the wrong verdict is not softened
      And a resolved hunch can no longer be edited by the player

    Scenario: A hunch no reveal ever touches stays honestly unresolved
      Given the player has logged a hunch that no in-game reveal ever bears on
      When a season is played to completion
      Then that hunch is still shown as never confirmed
      And the game never resolves it by reading the Vault while the season is live

  Rule: The post-season unseal pays off the rest (the big reveal, 0048)

    Scenario: The season scorecard resolves remaining hunches at the unseal
      Given the player logged several hunches across a finished season
      And some were never confirmed during play
      When the player opens the post-season retrospective and unseals the Vault
      Then the still-unresolved hunches are scored against the unsealed hidden story
      And the player is shown a scorecard of how many they called and how many were wrong
      And the scorecard reads only the player's own hunches and already-revealed truth

  Rule: The Vault Wall holds for everyone, including the admin

    Scenario: The admin cannot read the hidden truth through the ledger
      Given the player has logged hunches about hidden house secrets
      When the admin inspects the game through every admin-facing surface
      Then no hidden secret behind any hunch is revealed to the admin
      And no Vault sentinel value appears on any admin-facing surface

  Rule: The ledger never drives NPC behavior (anti-sycophancy)

    Scenario: Logging a hunch about a schemer does not make the house play along
      Given the player logs a hunch that a schemer is lying to them
      When houseguests act
      Then no houseguest behaves as though they know the player suspects the schemer
      And the schemer's conduct toward the player is unchanged by the logged hunch
