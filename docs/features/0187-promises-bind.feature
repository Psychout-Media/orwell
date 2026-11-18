# Feature 0187 - promises bind (ORW-586). Design note: 0187-promises-bind.md. Engine-only: a typed term on an open-ledger promise, judged by the engine from board facts. Roles only.

Feature: A promise with a term is kept or broken by what happens on the board, not by what a model says

  Scenario: A promise not to nominate is kept when they do not nominate and broken when they do
    Given a house where a promiser has promised a promisee not to nominate them
    When the promiser's nominations leave the promisee off the block
    Then the promise is closed as kept by the engine
    And the promisee holds a favor toward the promiser
    Given a house where a promiser has promised a promisee not to nominate them
    When the promiser nominates the promisee
    Then the promise is closed as broken by the engine
    And the promisee trusts the promiser less and believes they were lied to

  Scenario: The front end cannot mark a termed promise kept or broken
    Given a house where a promiser has promised a promisee not to nominate them
    When the front end tries to mark that promise kept or broken
    Then the engine refuses both
    And the front end may still withdraw it

  Scenario: A promise in plain words with no term is never judged
    Given a house where a promiser has promised a promisee to share what they hear
    When the promiser nominates the promisee
    Then the promise stays open

  Scenario: A sealed-ballot break names nobody
    Given a house where a promiser has promised a promisee not to vote out a third houseguest
    When the promiser votes the third houseguest out in the sealed ballot
    Then the promisee blames every possible voter by the same share
    And no lied-to-me claim names anyone
    And the visible promise stays open

  Scenario: A save and load keeps the term and the outcome
    Given a house where a promiser has promised a promisee not to nominate them
    When the promiser nominates the promisee
    And promise terms: the season is saved and loaded
    Then the promise still carries its term and reads broken

  Scenario: With the flag off nothing is written and nothing is judged
    Given a house with promise terms switched off
    Then recording a promise term is refused
    And a nomination leaves the ledger empty

  Scenario: No view shows a term or a judgement note
    Given a house where a promiser has promised a promisee not to nominate them
    When the promiser nominates the promisee
    Then no player or admin view shows a promise term or a judgement note

  Scenario: The player's typed promise on a recorded scene is judged by the engine at the nominations
    Given promise terms: a house where the player typed a promise not to nominate a houseguest
    When promise terms: the player's nominations leave that houseguest off the block
    Then promise terms: the typed promise is closed as kept by the engine and its assurance is kept
    And promise terms: a malformed promise on a recorded scene is ignored and the scene still records

  Scenario: A withdrawn promise cannot be broken later
    Given a house where a promiser has promised a promisee not to nominate them
    When promise terms: the promiser's promise is withdrawn and they then nominate the promisee
    Then promise terms: nothing is folded and the assurance row is lapsed

  Scenario: A kept veto promise leans the promiser's own save and the veto settles it
    Given promise terms: a house where a promiser has promised a promisee to use the veto on them
    And promise terms: the promiser has nothing to gain from breaking it
    Then promise terms: the promiser's own save read leans toward the promisee
    When promise terms: the promiser uses the veto on a third houseguest
    Then promise terms: the veto promise is closed as broken by the engine and the promisee trusts the promiser less

  Scenario: A promiser who gains from breaking a veto promise does not feel its lean
    Given promise terms: a house where a promiser has promised a promisee to use the veto on them
    And promise terms: breaking it would pay the promiser in full
    Then promise terms: the promiser's own save read has no lean toward the promisee

  Scenario: A final-two promise is kept by the final two and broken without the promisee
    Given promise terms: a house where a promiser has promised a promisee to take them to the final two
    When promise terms: the final two is the promiser and a third houseguest
    Then promise terms: the final-two promise is closed as broken by the engine and the promisee trusts the promiser less

  Scenario: A promiser whose plan says to break it breaks it at the planned moment, once
    Given ledger plan: a house where a promiser promised a promisee not to nominate them and plans to break it at the nominations
    Then ledger plan: the promiser does not keep the promise at the nominations
    When ledger plan: the promiser nominates the promisee twice
    Then ledger plan: the promise is closed as broken by the engine and the promisee trusts the promiser less exactly once

  Scenario: A promiser whose plan is to keep it keeps it
    Given ledger plan: a house where a promiser promised a promisee not to nominate them and plans to keep it
    Then ledger plan: the promiser keeps the promise at the nominations

  Scenario: An improvised promise's plan never reaches a player or admin view
    Given ledger plan: a house where a promiser promised a promisee not to nominate them and plans to break it at the nominations
    Then ledger plan: no player or admin view shows the plan or its key

  Scenario: With deal plans switched off an improvised promise gets no plan
    Given ledger plan: a house with deal plans switched off where a promiser promised a promisee not to nominate them
    Then ledger plan: no plan was made for the promise
