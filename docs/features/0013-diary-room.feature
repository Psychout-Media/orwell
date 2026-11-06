# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0013 — The Diary Room. Two walls: player-DR -> no NPC, and NPC-confessionals -> Vault-only.
# HARD rule: roles only.

Feature: The Diary Room — the player's private channel and NPC confessionals

  The player Diary Room is an out-of-character channel whose content is the player's own
  knowledge but reaches no NPC. NPC confessionals are Vault-only and never surface to the player.

  # PURPOSE (clarified PO review 2026-06-28): the player DR is an EXPRESSIVE channel — a private
  # journal, the public/private duplicity enabler (say one thing publicly, another in the DR), and a
  # season-retrospective payoff (0048). It has NO pathway to any NPC and can never
  # puppeteer an NPC or change an outcome (anti-sycophancy). It is not effect-free: since 0115/0138/0139 it
  # steers the NARRATOR (a fenced GM-only note) and the player's OWN tools (playerDossier, playerReceipts). A purposeful engine read of the player's
  # stated strategy is a DEFERRED future feature ("Diary Room with purpose", PO backlog) — the former
  # unwired `playerStrategyRead` identity-stub was removed so the code stops implying it exists.

  Background:
    Given a running game sandbox with a fully populated Producer's Vault

  Scenario: Player Diary Room content is the player's own knowledge
    When the player speaks privately in the Diary Room
    Then that content is part of the player's knowledge

  Scenario: Player Diary Room content reaches no NPC
    When the player speaks privately in the Diary Room
    Then no NPC's knowledge state gains that content
    And no NPC decision changes because of it

  Scenario: The public/private gap is honored
    Given the player says one thing to houseguests and a different thing in the Diary Room
    When houseguests act
    Then they act on what the player said publicly
    And never on what the player said in the Diary Room

  Scenario: NPC confessionals are Vault-only and never surface
    Given an NPC confessional recorded with a witness set that excludes the player
    When any player-facing surface is produced
    Then the confessional does not appear
    And its sentinel value does not appear

  Scenario: Producers prompt the Diary Room at a dramatic beat
    Given the player's position in the house has just shifted significantly
    Then the producers may invite the player to the Diary Room
    And such prompts occur at dramatic beats, not on every turn
