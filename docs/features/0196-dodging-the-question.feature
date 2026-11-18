# Feature 0196 - dodging the question (ORW-630). Design note: 0196-dodging-the-question.md.
# A houseguest pressed for what they hold may turn it aside. The engine decides how, from their character, their bond to the asker and the stakes; the narrator authors the words. Roles only.

Feature: A pressed houseguest dodges in a way that fits who they are

  Scenario: The engine decides how a houseguest dodges from who they are
    Given dodging: houseguests of differing guile, nerves and trust in the asker
    Then dodging: the guileful push back more, the rattled read uneasy more, the trusting laugh it off more, and every way of dodging stays possible

  Scenario: A declined press carries how it was turned aside and nothing hidden
    Given dodging: a played game where a houseguest holds a sealed fact and their press was declined
    Then dodging: the voice carries a dodge of approach, openness and push-back only, repeats within the beat are one entry, and the sealed fact and every number stay out

  Scenario: Switched off, nothing changes
    Given dodging: a played game with the feature switched off
    Then dodging: no dodge is decided, recorded or handed to the narrator
