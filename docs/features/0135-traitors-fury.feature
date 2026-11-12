# Wired into cucumber.cjs by ORW-300 (steps in features/step_definitions/traitors_fury.steps.ts); also gated by unit tests (see the design note). Feature 0135 - Traitors' Fury (jury bearing and misdirected blame). Roles only.

Feature: Traitors' Fury (jury bearing and misdirected blame)

  Retrospective scenarios describing the shipped behavior.

  Scenario: A juror's bearing is a word, never a number
    Given a juror holding a grudge from a deduced culprit
    When the finale view is read
    Then the juror's bearing is one of settled, cold, warm or burning
    And no grudge number is present

  Scenario: A deduced culprit stays a juror-only belief
    Given a juror who deduced, possibly wrongly, who voted them out
    When the blame is routed and diffused through the jury house
    Then the belief is held in the jurors' own knowledge only
    And it is not added to the player's knowledge
    And it applies no relationship fold

  Scenario: The reveal regrouping never changes the result
    Given a seeded finale played with the flag on and off
    When the votes are revealed
    Then the winner, finalists and tally are identical in both runs

  Scenario: No ballot attribution leaks before the retrospective
    Given a finale with an asking juror
    When the asking view is read
    Then it carries no belief about who voted against the juror
    And attribution unseals only in the post-season retrospective
