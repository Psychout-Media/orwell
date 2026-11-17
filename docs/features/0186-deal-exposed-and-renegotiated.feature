# Feature 0186 - a deal exposed; renegotiation after a twist (Theme 3 slice 14, from the Theme 3 slice plan: "A second final two comes out"). Design note: 0186-deal-exposed-and-renegotiated.md. Engine-only. Roles only.

Feature: A second final two costs the double-dealer trust, and a twist reopens deals

  Scenario: A second final two comes out
    Given a double-dealer who holds a final two with partner one and partner two
    And partner one holds that the double-dealer is allied with partner two
    When exposed: the night passes
    Then exposed: partner one is hit and partner two is not

  Scenario: A pair made public hits every other holder
    Given a double-dealer who holds a final two with partner one and partner two
    And exposed: most of the house holds that the double-dealer is allied with partner two
    When exposed: the night passes
    Then exposed: partner one is hit and partner two is not

  Scenario: The NPCs who hold final twos with each other are exposed too
    Given a double-dealer who holds a final two with partner one and partner two
    And partner one holds that the double-dealer is allied with partner two
    And exposed: the double-dealer is a houseguest and not the player
    When exposed: the night passes
    Then exposed: partner one is hit and partner two is not

  Scenario: The player as the double-dealer is exposed like anyone
    Given a double-dealer who holds a final two with partner one and partner two
    And partner one holds that the double-dealer is allied with partner two
    And exposed: the double-dealer is the player
    When exposed: the night passes
    Then exposed: partner one is hit and partner two is not

  Scenario: A partner who holds nothing is not hit, and the same night twice hits once
    Given a double-dealer who holds a final two with partner one and partner two
    When exposed: the night passes
    Then exposed: nobody is hit
    And exposed: a repeat night hits no one twice

  Scenario: A partner's win reopens their deals, a double eviction reopens all
    Given exposed: three open deals among four houseguests
    Then exposed: a win by one party reopens only the deals it is party to
    And exposed: a double eviction reopens every open deal

  Scenario: The same seed gives the same hits and nothing is ever a number
    Given a double-dealer who holds a final two with partner one and partner two
    And partner one holds that the double-dealer is allied with partner two
    Then exposed: two runs give identical hits
    And exposed: the hit carries no number the player could read
