# Status: BUILT (ORW-194, #2227; ORW-286) and WIRED into the BDD gate (ORW-368): steps in features/step_definitions/champagne_toast.steps.ts, listed in cucumber.cjs; every Then reads the narrator's moment prompt captured at each toast batch.
# Ryne (2026-11-06 04:38 UTC): "I also want to make a slight adjustment to how the champagne toast [works]. Should include some more basic info since this is my first impressions of people. We have the photo but that's about it. Give us more to work off of."
# Ryne (2026-11-15, prod playtest): "Only two people went. Every house guest should introduce themselves." and "it seems to want me to go every time... after a few people, it comes back to me as if I need to go again."
# HARD rule: roles only (player, houseguest, host). Each houseguest's toast gives the PUBLIC basics a viewer of a real show would get: name, age, hometown, job and ONE line of personality. Public information only. The engine hands the narrator the facts; the narrator only voices them (ADR 0003, mandate 3).
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
      Given a unique marker is planted in every houseguest's hidden elements, pre-show ties, game philosophy and relationship reads
      When the entrances and the toast are played through
      Then no marker appears in any toast, entrance or narration prompt the player can see
      And the archetype label appears only inside the fenced private cue "(private cue, never said aloud: ...)" in the narrator's prompt and never in any introduction the player sees
      And no tie, relationship number or game philosophy appears in any introduction
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

  Rule: Everyone goes, and the circle never returns to the player (ORW-368)

    Scenario: The player's slot is invited once and the circle moves on
      When the entrances and the toast are played through
      Then the player's own toast slot is still authored by the player in chat
      And every houseguest except the player gave a toast that states their name, age, hometown and job

