# Feature 0157 - the rumor mill in the post-season retrospective (theme 2, slice 8; ORW-525).
# Design note: 0157-rumor-mill-retrospective.md. Plan: the vault note "Theme 2 Slice Plan", slice 8.
# After the season, alongside "the house you never saw": the biggest false beliefs, who started each, who believed them, and what the house got wrong
# about the player. It rides the existing post-season door (the 0048 retrospective), behind the same gate: never during play. Roles only.

Feature: The retrospective shows the lies the house believed

  Scenario: The retrospective lists the biggest false beliefs, who started them and who believed them
    Given a season where a houseguest lied to two others about a rival and another houseguest lied about the player
    When the season is over and a winner is crowned
    Then the retrospective lists the rival rumor as the biggest false belief
    And it names the liar as who started it and both listeners as who believed it
    And it lists what the house got wrong about the player

  Scenario: A houseguest who only passed the lie on is a leak, not the starter
    Given a season where a houseguest lied about a rival and a second houseguest later repeated it without meaning to mislead
    When the season is over and a winner is crowned
    Then the retrospective names the first teller as the starter and the second as having passed it on

  Scenario: Nothing about claims is visible while the season is live
    Given a season where a houseguest lied to two others about a rival and another houseguest lied about the player
    Then no player or admin view, and no retrospective, shows a claim, its truth or what the speaker meant

  Scenario: A season with no lies renders cleanly
    Given a season where nobody lied
    When the season is over and a winner is crowned
    Then the retrospective carries no claim-planted rumors and is otherwise whole

  Scenario: Reading the rumor mill changes nothing
    Given a season where a houseguest lied to two others about a rival and another houseguest lied about the player
    When the season is over and a winner is crowned
    Then reading the retrospective leaves the claim log and the beliefs exactly as they were

  Scenario: What the house got wrong about the player includes beliefs the engine formed other ways
    Given a season where nobody lied aloud but a houseguest came to believe something false about the player
    When the season is over and a winner is crowned
    Then the retrospective lists that wrong belief about the player with its believer and no claim, truth or intent
