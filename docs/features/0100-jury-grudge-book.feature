Feature: 0100 — The jury grudge book, made felt (evicted jurors gossip; goodbyes decide the crown)
  The last nine evictees keep living in a sequestered jury house where they gossip about the
  player and each other. A grievance one juror carries out of the game can spread to another,
  and the accumulated treatment — what the player did on the way out, hardened or softened by
  the jury house — folds into each juror's final vote. The engine tallies the vote from sealed
  state on a seeded stream; the model only voices a juror's bearing. The grudge is hidden state
  behind the Vault Wall, it reaches the player only through behavior (a cold juror, a vote that
  breaks the wrong way), and secret ballots stay sealed until the post-season retrospective.
  This builds on the existing jury (0014/0037/0045) and off-screen society + gossip (0038/0002);
  it adds a second society, not a new jury system.

  # Role-only (testing rule): the-player, a finalist, a juror, another-juror, a betrayed-juror,
  # a respected-juror, the last-evicted-juror, a pre-jury-evictee.

  Background:
    Given a started season with the jury house enabled
    And the season has reached the jury phase with sequestered jurors

  Rule: The jury house is a living, hidden second society

    Scenario: Sequestered jurors keep living and gossip among themselves
      When time passes between turns
      Then the jurors produce hidden scenes among themselves in the jury house
      And those scenes carry more than one interaction nature, not a single canned verb
      And the living main house still excludes every evicted houseguest
      And no jury-house scene is witnessed by the player

    Scenario: Pre-jury evictees are not in the jury house
      Given a pre-jury-evictee who was cut before the jury formed
      When time passes between turns
      Then the pre-jury-evictee takes part in no jury-house society
      And the pre-jury-evictee casts no final vote

  Rule: Bitterness is contagious, bounded, and only travels by pathway

    Scenario: A betrayed juror sours a juror who left on good terms
      Given a betrayed-juror who carries a grievance against the player
      And another-juror who left with no grievance but is close to the betrayed-juror
      When the grievance diffuses through the jury house over several stretches
      Then the another-juror's hidden read of the player turns colder
      And the shift is confidence-scaled and stays within the saturation bound

    Scenario: A juror with no pathway to the grievance is unmoved
      Given a betrayed-juror who carries a grievance against the player
      And another-juror who is isolated from the betrayed-juror in the jury house
      When the grievance diffuses through the jury house over several stretches
      Then the isolated juror's hidden read of the player is unchanged by it
      And no juror's read ever reflects a grudge they had no pathway to

  Rule: The accumulated grudge folds into the engine-owned final vote

    Scenario: A bitter, well-connected jury hardens against the responsible finalist
      Given a finalist whose goodbyes left several jurors with grievances
      And those grievances diffuse through a well-connected jury house
      When the finale vote is tallied
      Then that finalist wins less often than the eviction-snapshot grudges alone would predict
      And the vote flows through the same jury lean, tally, and tie-break path as before
      And the engine decides every vote while the model only voices the jurors

    Scenario: A clean exit holds, and a strong finale still tips a close juror
      Given a finalist who cut every juror cleanly and respectfully
      When the jury house passes between turns and the finale is played
      Then the respected jurors' leans hold or improve
      And a strong finale appeal can still tip a close juror but never overturn a clear lead

  Rule: The grudge surfaces only through behavior — never a number

    Scenario: A soured juror reads colder at the finale and the player sees no grudge
      Given a juror whose read of the player soured in the jury house
      When the finale stages that juror's question and the vote reveal
      Then the juror's bearing reads colder to the player
      But the player is shown no lean, no grudge tally, and no "they are bitter" marker
      And the reason a juror is cold is left for the player to infer

  Rule: The Vault Wall holds for the player AND admin, and secret ballots stay sealed

    Scenario: No jury-house secret reaches the player or admin
      Given a populated jury house with grudges accumulating
      When the player views any player-facing surface
      And an administrator inspects any admin or God-Mode surface
      Then neither sees a jury-house scene, a grudge adjustment, or a juror's lean
      And the per-voter ballot stays sealed until the post-season retrospective
      And the staged vote reveal is anonymized

  Rule: The jury house is deterministic and calibration-neutral

    Scenario: With the jury house off, the seeded outcome is byte-identical
      Given the jury house is disabled
      When a seeded season is played to the finale
      Then no jury-house stretch runs and no grudge adjustment is applied
      And the jury vote and winner are byte-identical to the run without this feature

    Scenario: With the jury house on, the same seed reproduces the same jury house
      Given the jury house is enabled
      When the same seed and the same player choices are played twice
      Then the jury-house scenes, the grudge adjustments, and the final votes are identical both times

  Rule: A juror's feelings fade only a little, equally toward everyone, at a rate set by who they are

    Scenario: A grudge-keeper juror fades less than an easygoing juror, and always less than the in-house drift
      Given a grudge-keeper juror and an easygoing juror with the same history
      When a night passes in the jury house
      Then the grudge-keeper's feelings fade less than the easygoing juror's
      And both fade less than the same feeling would in the house
      And the same rule applies whether the subject is the player or another finalist
