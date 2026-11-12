import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import {
  runPlayerOOBE, startNewGame, ARCHETYPES, playerAptitudesWithinNpcBounds,
} from "../../src/engine/characterFactory";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { deriveNpcKnowledge } from "../../src/engine/diaryRoom";
import { PLAYER, npc } from "../../src/domain/ids";
import { GameSessionRegistry } from "../../src/composition/registry";

// --- Single authored profile --------------------------------------------------

When("a new save is created through character creation", function (this: BbWorld) {
  this.house = startNewGame({ seed: 1, playerName: "The Author" });
});

Then("exactly one houseguest profile originates from human authoring", function (this: BbWorld) {
  const all = [this.house!.player, ...this.house!.npcs];
  assert.equal(all.filter((h) => h.authored === "oobe").length, 1);
});

Then("that profile is the player", function (this: BbWorld) {
  assert.equal(this.house!.player.authored, "oobe");
});

Then("the other fifteen houseguests are generated", function (this: BbWorld) {
  assert.equal(this.house!.npcs.length, 15);
  assert.ok(this.house!.npcs.every((n) => n.authored === "generated"));
});

// --- Character / Soul split ---------------------------------------------------

When("the player is authored", function (this: BbWorld) {
  this.player = runPlayerOOBE({ name: "The Author", archetype: "mastermind", backstory: "a long road to the house" });
});

Then("the player has a static Character carrying identity, backstory, and core aptitudes", function (this: BbWorld) {
  const c = this.player!.character;
  assert.ok(c.archetype && c.background.length > 0);
  for (const v of Object.values(c.stats)) assert.ok(v >= 0 && v <= 1);
});

Then("the player has an initial Soul carrying an emotional baseline", function (this: BbWorld) {
  assert.equal(typeof this.player!.soul.emotionalBaseline, "number");
});

Then("the player's Soul holds no relationship beliefs yet", function (this: BbWorld) {
  // Relationships are computed from play (0017), never stored on the soul; memory + arc start empty.
  assert.deepEqual(this.player!.soul.memory, []);
  assert.deepEqual(this.player!.soul.emotionalHistory, []); // the season arc (0041) starts empty
  assert.deepEqual(Object.keys(this.player!.soul).sort(), ["emotionalBaseline", "emotionalHistory", "emotionalState", "memory", "volatility"]);
});

// --- Validation ---------------------------------------------------------------

Given("a character-creation input with no name", function (this: BbWorld) {
  this.oobeRejected = undefined; // intent: the next submit uses an input with no name
});

When("the input is submitted", function (this: BbWorld) {
  try {
    runPlayerOOBE({ name: "" });
    this.oobeRejected = false;
  } catch {
    this.oobeRejected = true;
  }
});

Then("character creation is rejected", function (this: BbWorld) {
  assert.equal(this.oobeRejected, true);
});

When("a complete character-creation input is submitted instead", function (this: BbWorld) {
  this.player = runPlayerOOBE({ name: "The Author", archetype: "mastermind", strategyStyle: "strategic" });
});

Then("the resulting player profile is internally consistent", function (this: BbWorld) {
  const c = this.player!.character;
  const spec = ARCHETYPES.find((s) => s.archetype === c.archetype)!;
  assert.ok(spec, "archetype is a known archetype");
  assert.ok(spec.styles.includes(c.strategyStyle), "strategy style fits the archetype");
  assert.ok(this.player!.name.length > 0);
});

// --- Anti-sycophancy bound ----------------------------------------------------

Given("a character-creation input that attempts to maximize every aptitude", function () {
  // The OOBE schema has no free stat allocation, so a "max everything" attempt cannot set stats;
  // aptitudes are derived from the authored archetype within the cast bounds. (Asserted below.)
});

Then("the player's core aptitudes fall within the same bounds as the generated houseguests", function (this: BbWorld) {
  assert.ok(playerAptitudesWithinNpcBounds(this.player!));
});

Then("no authored input places an aptitude outside those bounds", function () {
  for (const spec of ARCHETYPES) {
    const p = runPlayerOOBE({ name: "MaxMe", archetype: spec.archetype });
    assert.ok(playerAptitudesWithinNpcBounds(p), `archetype ${spec.archetype} stays within NPC bounds`);
  }
});

// --- No outcome protection ----------------------------------------------------

Given("the authored player enters seeded competitions", function (this: BbWorld) {
  this.house = startNewGame({ seed: 3, playerName: "The Author", archetype: "floater" });
});

Then("the player can lose", function (this: BbWorld) {
  const field = [
    { id: this.house!.player.id, stats: this.house!.player.character.stats, emotionalState: 0.5 },
    ...this.house!.npcs.map((n) => ({ id: n.id, stats: n.character.stats, emotionalState: n.soul.emotionalState })),
  ];
  let wins = 0;
  for (let s = 1; s <= 60; s++) {
    const { winner } = resolveCompetition(field, "endurance", new CompetitionIntents(), new SeededRandom(s));
    if (winner === this.house!.player.id) wins++;
  }
  assert.ok(wins < 60, "the player does not win every competition");
});

Then("the authored profile grants the player no outcome guarantee", function (this: BbWorld) {
  // The aptitudes are bounded like any NPC's...
  assert.ok(playerAptitudesWithinNpcBounds(this.house!.player));
  // ...and the engine treats the authored player exactly like a generated houseguest of identical aptitudes: against a
  // stat-for-stat clone NPC, the two win about equally often. Any thumb on the scale (a bonus, a floor) shows as a gap.
  const p = this.house!.player;
  const RUNS = 6000;
  // The win-rate gap between the authored player and a clone NPC whose stats are the player's plus `bump` (0 = identical).
  const gapWith = (bump: number): number => {
    const bumped = { physical: p.character.stats.physical + bump, mental: p.character.stats.mental + bump, social: p.character.stats.social + bump };
    const clone = { id: npc(99), stats: bump === 0 ? p.character.stats : bumped, emotionalState: 0.5 };
    const field = [
      { id: p.id, stats: p.character.stats, emotionalState: 0.5 }, clone,
      ...this.house!.npcs.slice(0, 6).map((n) => ({ id: n.id, stats: n.character.stats, emotionalState: n.soul.emotionalState })),
    ];
    const wins: Record<string, number> = { [p.id]: 0, [clone.id]: 0 };
    for (let seed = 1; seed <= RUNS; seed++) {
      const { winner } = resolveCompetition(field, "endurance", new CompetitionIntents(), new SeededRandom(seed));
      if (winner in wins) wins[winner]!++;
    }
    return Math.abs(wins[p.id]! - wins[clone.id]!) / RUNS;
  };
  // Sampling noise on a 6000-run gap in an 8-player field is ~0.007, so 0.025 is a tight bound (was 0.05, ~40% of the base rate).
  const BOUND = 0.025;
  assert.ok(gapWith(0) <= BOUND, `the authored player is protected or handicapped (win-rate gap ${gapWith(0)} over ${RUNS} runs)`);
  // Power check: the same test DOES see a modest thumb on the scale (a +0.1 aptitude edge on the clone), so a pass means something.
  assert.ok(gapWith(0.1) > BOUND, "the gap test is too weak to detect a modest aptitude edge");
});

// --- Private strategy → no NPC at start (DR wall, 0013) ------------------------

When("the player authors a private strategic lean", function (this: BbWorld) {
  this.privateFact = "I plan to backstab my closest ally at the final four";
  const knowledge = new InMemoryKnowledgeService(new InMemoryEventStore());
  knowledge.recordDiaryRoom(this.privateFact); // player-only knowledge, tagged NO_NPC_PATHWAY
  this.oobeKnowledge = knowledge;
});

Then("that material is part of the player's own knowledge", function (this: BbWorld) {
  assert.ok(this.oobeKnowledge!.knownTo(PLAYER).some((k) => k.content === this.privateFact));
});

Then("no houseguest's knowledge state holds it at the start of the game", function (this: BbWorld) {
  for (let i = 1; i <= 15; i++) {
    assert.ok(!this.oobeKnowledge!.knownTo(npc(i)).some((k) => k.content === this.privateFact));
  }
  assert.ok(!deriveNpcKnowledge(this.oobeKnowledge!.knownTo(PLAYER)).some((k) => k.content === this.privateFact));
});

// --- OOC / no witnesses -------------------------------------------------------

Then("character creation produces no witnessed event", function (this: BbWorld) {
  // Create a character through the REAL session path and look at the engine's own event store afterwards.
  const sb = new GameSessionRegistry().sandboxFor("oobe-events");
  sb.session.createCharacter({ playerName: "The Author", seed: 5, backstory: "OOBE-BACKSTORY-SENTINEL", motivation: "OOBE-MOTIVE-SENTINEL" });
  assert.equal(sb.engine.events.queryAll().length, 0, "creating the character recorded an in-game event");
  this.oobeSandbox = sb;
});

Then("nothing from it is narrated to any houseguest", function (this: BbWorld) {
  const sb = this.oobeSandbox!;
  for (let i = 1; i <= 15; i++) {
    const blob = JSON.stringify(sb.engine.knowledge.knownTo(npc(i))) + JSON.stringify(sb.engine.knowledge.suspicionsOf(npc(i)));
    assert.ok(!blob.includes("OOBE-BACKSTORY-SENTINEL") && !blob.includes("OOBE-MOTIVE-SENTINEL"), `npc ${i} was told the authored material`);
  }
  assert.equal(sb.engine.events.queryAll().filter((e) => e.witnessSet.some((w) => w !== PLAYER)).length, 0, "no houseguest witnessed creation");
});

// --- Balanced ensemble around the player --------------------------------------

When("the house is generated", function (this: BbWorld) {
  this.house = startNewGame({ seed: 7, playerName: "The Author" });
});

// NOTE: "the cast spans a spread of distinct archetypes and strategy styles" is defined in
// replayability.steps.ts (0004) and reused here (it reads this.house, set by "the house is generated").

Then("the player is not dropped into a clump of near-identical houseguests", function (this: BbWorld) {
  const sameAsPlayer = this.house!.npcs.filter((n) => n.character.archetype === this.house!.player.character.archetype);
  assert.ok(sameAsPlayer.length < this.house!.npcs.length / 2, "the player's archetype is not the bulk of the house");
});

// --- No carryover -------------------------------------------------------------

Given("a player authored in one save", function (this: BbWorld) {
  this.house = startNewGame({ seed: 1, playerName: "The Author" });
});

Given("a player authored in another save", function (this: BbWorld) {
  this.house2 = startNewGame({ seed: 2, playerName: "The Author" });
});

Then("the two saves share no houseguest identities", function (this: BbWorld) {
  const a = new Set(this.house!.npcs.map((n) => n.name));
  assert.equal(this.house2!.npcs.filter((n) => a.has(n.name)).length, 0);
});
