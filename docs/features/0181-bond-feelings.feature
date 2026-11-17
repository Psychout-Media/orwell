# Feature 0181 - a bond's life: feelings vs strategy, guilt (Theme 3 slice 4, part 1). Design note: 0181-bond-feelings.md. Engine-only: adds no text. Roles only.

Feature: Betraying a real friend costs the betrayer

  Scenario: Betraying a real friend costs the betrayer
    Given an NPC whose plan says to cut someone they truly like
    Then they hesitate, more as the feeling is stronger
    And they are shaken after, more as the feeling is stronger

  Scenario: A stranger or a grudge-holder does not hesitate or feel guilt
    Given an NPC whose plan says to cut someone they hold a grudge against
    Then they do not hesitate
    And they are not shaken after

  Scenario: The feeling never makes a plan impossible
    Given an NPC whose plan says to cut their closest friend
    Then their hesitation stays below one
