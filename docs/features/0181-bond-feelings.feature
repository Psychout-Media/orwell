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

  Scenario: A third person strains a close bond
    Given two close friends and a newcomer one of them favours
    When the other watches the favour grow
    Then their jealousy rises and the closeness slips

  Scenario: Jealousy is handled by a bonding scene
    Given a houseguest who is jealous over a close friend
    When they share a bonding scene with that friend before the night
    Then the jealousy is cleared

  Scenario: Jealousy needs a close bond
    Given a houseguest who is not close to the friend who favours someone else
    Then they feel no jealousy

  Scenario: Someone close to two people who fall out is pulled both ways
    Given a houseguest close to both of two people who have fallen out
    Then they are less likely to vote against or nominate either, and less likely to break an alliance against either
