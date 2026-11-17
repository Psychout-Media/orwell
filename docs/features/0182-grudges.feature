# Feature 0182 - the grudge book (Theme 3 slice 5, PR 1). Design note: 0182-grudges.md. Engine-only: nothing is shown and nothing decides from it yet. Roles only.

Feature: A broken bond leaves a grudge with a memory that fades but is never zero

  Scenario: A broken bond leaves a grudge with a memory that fades but is never zero
    Given a houseguest who was cut by an ally in week 1
    Then the houseguest holds a grudge against that ally
    And the grudge is sharper in week 2 than in week 40
    And the grudge in week 40 is still above zero

  Scenario: Repair eases a grudge partly and never fully
    Given a houseguest who was cut by an ally in week 1
    When the wrong is eased again and again
    Then the grudge is fainter than before
    And the grudge is still above zero

  Scenario: A stronger wrong replaces a weaker one and nothing is lost
    Given a houseguest who was cut by an ally in week 1
    When the same ally lies to them later and harder
    Then the grudge remembers the lie
    And the strongest severity held is kept
