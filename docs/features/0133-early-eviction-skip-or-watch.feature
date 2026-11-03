Feature: Early eviction — skip to the finale or watch the skeleton season, and still be in the finale
  The player is voted out before the jury forms. They choose to skip to the finale reveal or keep watching a
  condensed version of the rest of the season, and either way they take part in the finale.

  Scenario: The player is offered both options on a card
    Given a seeded live season where the player is evicted before the jury forms
    Then a "spectator-choice" decision is pending for the player
    And the decision offers exactly "watch" and "skip"

  Scenario: Watching yields one public digest per remaining week
    Given a seeded live season where the player is evicted before the jury forms
    When the player chooses to watch
    And the remaining weeks are advanced
    Then each completed eviction night produced exactly one week digest
    And every digest contains only public broadcast facts
    And the digests are public game-state records, never hidden events

  Scenario: Skipping fast-forwards to the finale reveal in one step
    Given a seeded live season where the player is evicted before the jury forms
    When the player chooses to skip
    And the game is advanced once
    Then the season is at the finale reveal
    And the skipped weeks' digests are available to read

  Scenario: Skip is irreversible but watch can become skip
    Given a seeded live season where the player is evicted before the jury forms
    When the player chooses to watch
    And the player switches to skip
    And the game is advanced once
    Then the season is at the finale reveal
    When the player tries to choose watch again
    Then the answer is refused and the player is still skipping

  Scenario: The choice never changes the season's outcome
    Given a seeded live season where the player is evicted before the jury forms
    Then the winner, finalists and jury are identical whether the player watches, skips, or neither is offered

  Scenario Outline: Either way the player is interviewed on the finale night
    Given a seeded live season where the player is evicted before the jury forms
    When the player chooses <mode>
    And the season reaches the crowning
    Then a "finale-interview" decision is pending for the player
    When the player answers with a stance and optional words
    Then the interview is recorded on the season's public record
    And it appears in the season-end retrospective
    And no jury vote and no winner changed

    Examples:
      | mode  |
      | watch |
      | skip  |

  Scenario Outline: The interview never blocks the crowning
    Given a seeded live season where the player is evicted before the jury forms
    When the player chooses <mode>
    And the season reaches the crowning
    And the player does not answer the finale interview
    Then the season has crowned its winner
    And the unanswered interview does not prevent any further reads

    Examples:
      | mode  |
      | watch |
      | skip  |

  Scenario: The hidden story stays sealed until the crowning
    Given a seeded live season where the player is evicted before the jury forms
    When the player chooses to skip
    Then no digest, summary or interview projection contains hidden or Vault content before the winner is crowned

  Scenario: A self-evicted player forfeits all of it
    Given a seeded live season where the player confirms a self-eviction
    When the season is advanced to its end
    Then no "spectator-choice" and no "finale-interview" decision is ever raised
