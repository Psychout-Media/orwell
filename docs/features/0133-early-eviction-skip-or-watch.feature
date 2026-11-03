Feature: Early eviction — skip to the finale or watch the skeleton season, and still be in the finale
  The player is voted out before the jury forms. They choose to skip to the finale reveal or keep watching a
  condensed version of the rest of the season, and either way they take part in the finale.

  Background:
    Given a seeded live season where the player is evicted before the jury forms

  Scenario: The player is offered both options on a card
    Then a "spectator-choice" decision is pending for the player
    And the decision offers exactly "watch" and "skip"

  Scenario: Watching yields one public digest per remaining week
    When the player chooses to watch
    And the remaining weeks are advanced
    Then each completed week produced exactly one week digest
    And every digest contains only public broadcast facts
    And every digest is recorded as a non-hidden event the player witnessed

  Scenario: Skipping fast-forwards to the finale reveal in one step
    When the player chooses to skip
    Then the season is at the finale reveal
    And the skipped weeks' digests are available to read

  Scenario: Skip is irreversible but watch can become skip
    When the player chooses to watch
    And the player switches to skip
    Then the season is at the finale reveal
    When the player is offered the choice again
    Then the answer is refused

  Scenario: The choice never changes the season's outcome
    Then the winner, finalists and jury are identical whether the player watches, skips, or neither is offered

  Scenario: Either way the player is interviewed at the finale
    When the player chooses <mode>
    And the season reaches the finale reveal
    Then a "finale-interview" decision is pending for the player
    When the player answers with a stance and optional words
    Then the interview is recorded as a public event
    And it appears in the season-end retrospective
    And no jury vote and no winner changed

  Scenario Outline: The interview never blocks the crowning
    When the player chooses <mode>
    And the player does not answer the finale interview
    Then the season still crowns its winner
    Examples:
      | mode  |
      | watch |
      | skip  |

  Scenario: The hidden story stays sealed until the crowning
    When the player chooses to skip
    Then no digest, summary or interview projection contains hidden or Vault content before the winner is crowned

  Scenario: A self-evicted player forfeits all of it
    Given the player confirmed a self-eviction instead
    Then no "spectator-choice" and no "finale-interview" decision is ever raised
