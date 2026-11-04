# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0024 — Soul storage & memory recall. md narrative + engine-only vector; semantic recall.
# HARD rule: roles only. The vector index is Vault-side; player-facing recall is sentinel-clean.

# PAT-5 (#1982): `SoulProvider.recall`/`soulOf` have NO production caller (the live soul index is write-only; the live game's durable soul
# is each houseguest's `soul.memory` mirror via `recordSceneMemory`). The recall scenarios therefore drive what the live game DOES recall
# for the narrator, `session.recallSceneMemories` (player-visible, relevance-ranked); scenarios tagged @standalone-module cover SoulStore only.

Feature: Soul storage & memory recall — the house remembers the RIGHT moment

  The dynamic Soul is a growing markdown narrative plus an engine-only vector index. Semantic recall
  surfaces the most relevant past moments — feeding both how a houseguest behaves and what they can
  vividly remember — while the static Character stays byte-stable and the player sees no hidden soul.

  Background:
    Given a running game sandbox with a fully populated Producer's Vault

  Scenario: Recall returns the relevant memory, not just the recent one
    Given a houseguest whose soul holds one old salient memory and many recent trivial ones
    When memory is recalled for a context matching the old salient one
    Then the old salient memory is recalled
    And it is not crowded out by the recent trivial memories

  # @standalone-module: SoulProvider.recall has no production caller and nothing in the live game feeds a recalled memory into the
  # relationship read. The standalone module is proven by tests/unit/soul.test.ts; live relationship folds by 0023 (recordInteraction)
  # and tests/unit/consequence.test.ts.
  @standalone-module
  Scenario: Recall sharpens the relationship read (mechanics)
    Given a houseguest with a relevant adverse memory of the player
    When that memory is recalled into the relationship read
    Then the read reflects the adverse history even after a quiet recent stretch

  Scenario: Recall gives the narrator a specific memory (narration)
    Given a houseguest about to speak to the player about a past event they both witnessed
    When the narrator's context is assembled
    Then it includes the recalled specific memory
    And the houseguest can reference that specific past beat

  # AMEND 0024 #4: this used to end "behavior MAY still reflect it" - a clause that cannot fail, and soul.memory notes have no behavioural reader today (only the numeric mood and the
  # NPC-memory ledger move behaviour; see 0041). The scenario now claims only what is true and testable: the hidden memory is held engine-side, survives a save-and-resume, and never leaks.
  Scenario: A hidden memory is held engine-side and survives resume, but never leaks
    Given a houseguest recalls a memory the player did not witness and was never told
    When any player-facing surface is produced
    Then the hidden memory does not appear
    And no Vault sentinel value appears
    But the engine keeps the hidden memory and it survives a save-and-resume

  # @standalone-module: SoulStore.soulOf (the sectioned narrative) has no production reader; the live durable soul is hg.soul.memory.
  # The standalone sectioning is proven by tests/unit/soul.test.ts ("Option B" block).
  @standalone-module
  Scenario: The inner diary is organised into sections (memories / leanings / feelings)
    Given a houseguest whose soul holds a plain happening, a strategic lean, and an emotional beat
    When the soul's inner diary is rendered
    Then the diary groups memories under a Memories, a Leanings, and a Feelings section
    And a section with no memories shows no heading
    And the sectioning never thins the authoritative memory record

  # @standalone-module: SoulStore.soulOf has no production reader. The standalone deepening is proven by tests/unit/soul.test.ts; live soul
  # deepening by 0038 (off-screen scenes deepen the souls, via snapshot soul.memory) and tests/unit/soulIndexDrain.test.ts, and 0041's
  # persisted emotionalHistory; character byte-stability by 0004/0015.
  @standalone-module
  Scenario: The soul deepens over a game; the character does not
    Given a houseguest at premiere
    When many events accumulate over the season
    Then the soul's narrative and indexed-memory count grow
    And the growth is monotonic — no memory is thinned away
    And the static Character baseline is unchanged

  Scenario: The vector index is engine-only
    When the dependency graph is checked
    Then no outward module depends on the vector index or the full soul

  Scenario: Recall is deterministic under a seed
    Given a fixed seed and the deterministic test embedding
    When memory is recalled twice for the same context
    Then both recalls return the same memories
