# spec-only: this .feature is a DESIGN CONTRACT for ORW-194, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions yet). It becomes executable when ORW-194 is built (Lane A):
# add the steps, list the file in cucumber.cjs, and mutation-check each scenario. Written by the BDD Auditor 2026-11-06 from Ryne's request.
# Ryne (2026-11-06 04:38 UTC): "I also want to make a slight adjustment to how the champagne toast [works]. Should include some more basic info since this is my first impressions of people. We have the
# photo but that's about it. Give us more to work off of."
# HARD rule: roles only (player, houseguest, host). Default content until Ryne changes it: each houseguest's toast gives the PUBLIC basics a viewer of a real show would get: name, age, hometown, job and
# ONE line of personality. Public information only. The engine hands the narrator the facts; the narrator only voices them (ADR 0003, mandate 3).
# Open point for Lane A: the stored public facets today are vocation (job), hometown, demeanor, a biography and a physical facet (PersistedCharacter, saveState.ts). No plain `age` field was found in
# that list; if no public age exists, add one as a PUBLIC facet at character generation (byte-stable, superset-checked like vocation/hometown) rather than letting the narrator invent it.

Feature: The champagne toast gives the player first impressions of every houseguest
  At the premiere's champagne toast the player meets each houseguest for the first time. The photo is not enough to form a first impression, so each houseguest's toast also carries their public basics:
  name, age, hometown, job and one line of personality. Nothing secret appears. It is narrated in the houseguest's own toast, never read out as a data dump. It ships ON with the premiere entrances.

  Background:
    Given a started season with the premiere entrances enabled

  Rule: Every houseguest introduces themselves with their public basics

    Scenario: Each houseguest's toast carries the basics
      When the entrances and the toast are played through
      Then every houseguest except the player gave a toast that states their name, age, hometown and job
      And each of those toasts carries one line of personality
      And the host's opening toast needs no basics

    Scenario: The basics are the houseguest's real public facts, never invented
      When the entrances and the toast are played through
      Then each houseguest's stated age, hometown and job are exactly their stored public facets
      And a houseguest with no stored public age is not given a made-up one in the toast
      And the same seed reproduces the same introductions

  Rule: Only public information is ever said

    Scenario: No secret, tie, label or number appears in any introduction
      Given a unique marker is planted in every houseguest's hidden elements, pre-show ties, archetype, game philosophy and relationship reads
      When the entrances and the toast are played through
      Then no marker appears in any toast, entrance or narration prompt the player can see
      And no archetype label, tie, relationship number or game philosophy appears in any introduction
      And the player and the admin projections carry no Vault data

  Rule: It is narrated, not a data dump

    Scenario: The introduction is spoken, not listed
      When the entrances and the toast are played through
      Then each introduction is a spoken line in the houseguest's own toast voice
      And no introduction shows a raw field name or a list of labelled values
      And the engine hands the narrator the facts to voice and not a script to recite

  Rule: It does not disturb the rest of the premiere

    Scenario: The player's own slot and the OFF path are unchanged
      When the entrances and the toast are played through
      Then the player's own toast slot is still authored by the player in chat
      And everyone is still met by the end of the toast and the first power still waits for the Day-1 morning
      And with the premiere entrances OFF the season is byte-identical to today
