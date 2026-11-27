# Feature 0182 - the grudge book (Theme 3 slice 5, PR 1 to 3). Design note: 0182-grudges.md. Engine-only: nothing is shown. Roles only.

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

  Scenario: A rift can be partly repaired
    Given two houseguests who fell out
    When one keeps a promise to the other
    Then the strain eases, but the memory stays

  Scenario: A betrayed juror votes bitter
    Given a juror whose ally cut them and who now sits on the jury against that ally
    Then at the finale the juror leans against that finalist
    And the lean is sharper when the grudge is fresh than when it is old
    And the lean is still there when the grudge is old
    And a wrong the juror's manner grievance already counts adds only the part beyond it
    And a deal the finalist broke, which no manner counts, makes the juror lean against them by a real amount
