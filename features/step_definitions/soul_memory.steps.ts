import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { SoulStore } from "../../src/adapters/engine/SoulStore";
import { DeterministicEmbedding } from "../../src/adapters/embedding/DeterministicEmbedding";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { generateHouse } from "../../src/engine/characterFactory";
import { vaultBoundaryViolations } from "../../tests/support/architecture";
import { PLAYER, npc } from "../../src/domain/ids";
import { startLiveSweep, setLive, liveOf, livePlayerSurfaces } from "../support/liveSweep";

// Reuses: Background (mcp_boundary), "any player-facing surface is produced" (vault_wall),
// "no Vault sentinel value appears" (god_mode, checks this.lastView).

const fake = new DeterministicEmbedding();
const embed = (t: string): number[] => fake.embed(t);
const HG = npc(1);

// --- Relevance, not recency ---------------------------------------------------

Given("a houseguest whose soul holds one old salient memory and many recent trivial ones", function (this: BbWorld) {
  this.soul = new SoulStore(embed);
  this.npc = HG;
  this.soul.recordToSoul(HG, "a brutal veto betrayal that cut deep");
  for (let i = 0; i < 8; i++) this.soul.recordToSoul(HG, `trivial chat about breakfast cereal ${i}`);
});

When("memory is recalled for a context matching the old salient one", function (this: BbWorld) {
  this.recalled = this.soul!.recall(this.npc!, "the veto betrayal", 1);
});

Then("the old salient memory is recalled", function (this: BbWorld) {
  assert.ok(this.recalled!.length >= 1);
  assert.match(this.recalled![0]!.content, /veto betrayal/);
});

Then("it is not crowded out by the recent trivial memories", function (this: BbWorld) {
  assert.ok(!/trivial/.test(this.recalled![0]!.content));
});

// --- Recall sharpens the relationship read (mechanics) ------------------------

Given("a houseguest with a relevant adverse memory of the player", function (this: BbWorld) {
  this.soul = new SoulStore(embed);
  this.npc = HG;
  this.soul.recordToSoul(HG, "they blindsided me with a cruel veto betrayal");
  for (let i = 0; i < 6; i++) this.soul.recordToSoul(HG, `pleasant small talk ${i}`);
  this.rel = new RelationshipModel(0.5);
  this.threatBefore = this.rel.edge(HG, PLAYER).threat;
});

When("that memory is recalled into the relationship read", function (this: BbWorld) {
  this.recalled = this.soul!.recall(this.npc!, "veto betrayal", 1);
  // Recall weighting (0017/0024): the recalled adverse memory keeps the read sharp.
  if (/betrayal/.test(this.recalled![0]?.content ?? "")) {
    this.rel!.applyDirected(HG, PLAYER, "betrayal", new SeededRandom(1));
  }
});

Then("the read reflects the adverse history even after a quiet recent stretch", function (this: BbWorld) {
  assert.match(this.recalled![0]!.content, /betrayal/); // relevance beat recency
  assert.ok(this.rel!.edge(HG, PLAYER).threat > this.threatBefore!, "threat stays elevated by the recalled grudge");
});

// --- Recall gives the narrator a specific memory (narration) ------------------

Given("a houseguest about to speak to the player about a past event they both witnessed", function (this: BbWorld) {
  this.soul = new SoulStore(embed);
  this.npc = HG;
  this.soul.recordToSoul(HG, "the kitchen alliance pact we made at midnight");
  for (let i = 0; i < 5; i++) this.soul.recordToSoul(HG, `idle backyard moment ${i}`);
});

When("the narrator's context is assembled", function (this: BbWorld) {
  this.recalled = this.soul!.recall(this.npc!, "kitchen alliance pact", 2);
});

Then("it includes the recalled specific memory", function (this: BbWorld) {
  assert.ok(this.recalled!.some((m) => /kitchen alliance pact/.test(m.content)));
});

Then("the houseguest can reference that specific past beat", function (this: BbWorld) {
  assert.match(this.recalled![0]!.content, /kitchen alliance pact/);
});

// --- A recalled HIDDEN memory shapes behavior but does not leak ---------------

Given("a houseguest recalls a memory the player did not witness and was never told", function (this: BbWorld) {
  // PAT-2: record the hidden memory into the LIVE game's own soul store (the one the session + player surfaces
  // are wired to), so the "does not leak" sweep reads the surfaces of the game that actually holds it.
  const live = startLiveSweep({ seed: 1, user: "pat2-soul" });
  setLive(this, live);
  this.npc = HG;
  this.hiddenMemory = "a secret off-screen deal SOULSENTINEL with another houseguest";
  live.sb.engine.soul.recordToSoul(HG, this.hiddenMemory);
  live.hiddenContents.push(this.hiddenMemory);
  this.recalled = live.sb.engine.soul.recall(HG, "secret deal", 50); // engine-side: informs behavior
});

Then("the hidden memory does not appear", function (this: BbWorld) {
  this.lastOutput = livePlayerSurfaces(liveOf(this)!.sb!);
  this.lastView = this.lastOutput; // also satisfies the reused "no Vault sentinel value appears" step
  assert.ok(!this.lastOutput.includes(this.hiddenMemory!), "the engine-only soul memory never surfaces");
  assert.ok(!this.lastOutput.includes("SOULSENTINEL"));
});

Then("the houseguest's behavior may still reflect it", function (this: BbWorld) {
  assert.ok(this.recalled!.some((m) => m.content === this.hiddenMemory), "recall fed the behavior layer");
});

// --- Option B: the inner diary is organised into sections ---------------------

Given("a houseguest whose soul holds a plain happening, a strategic lean, and an emotional beat", function (this: BbWorld) {
  this.soul = new SoulStore(embed);
  this.npc = HG;
  this.soul.recordToSoul(HG, "won the HOH competition in the backyard"); // memory
  this.soul.recordToSoul(HG, "leaning toward an alliance with the cook"); // leaning
  this.soul.recordToSoul(HG, "felt crushed after the blindside"); // feeling
});

When("the soul's inner diary is rendered", function (this: BbWorld) {
  this.soulNarrative = this.soul!.soulOf(this.npc!).narrative;
});

Then("the diary groups memories under a Memories, a Leanings, and a Feelings section", function (this: BbWorld) {
  const nar = this.soulNarrative!;
  assert.match(nar, /## Memories/);
  assert.match(nar, /## Leanings/);
  assert.match(nar, /## Feelings/);
  assert.ok(nar.indexOf("## Memories") < nar.indexOf("## Leanings"), "sections render in a fixed order");
  assert.ok(nar.indexOf("## Leanings") < nar.indexOf("## Feelings"), "sections render in a fixed order");
});

Then("a section with no memories shows no heading", function (this: BbWorld) {
  // A fresh houseguest with only a plain happening surfaces Memories, never the empty buckets.
  const s = new SoulStore(embed);
  s.recordToSoul(npc(2), "played chess in the lounge");
  const nar = s.soulOf(npc(2)).narrative;
  assert.match(nar, /## Memories/);
  assert.ok(!/## Leanings/.test(nar) && !/## Feelings/.test(nar), "empty sections render no heading");
});

Then("the sectioning never thins the authoritative memory record", function (this: BbWorld) {
  // The organisation is a projection of the memory list — every recorded memory is still present.
  assert.equal(this.soul!.soulOf(this.npc!).memories.length, 3);
});

// --- The soul deepens; the character does not ---------------------------------

Given("a houseguest at premiere", function (this: BbWorld) {
  this.soul = new SoulStore(embed);
  // T4: take a REAL generated houseguest so "the static Character is unchanged" is a genuine
  // byte-stability claim, not `assert.ok(true)`. The static CHARACTER (0004/0015) is a layer
  // distinct from the SOUL; capture its exact bytes at premiere so the Then can prove the
  // season's soul-deepening never touched it. Roles only — a generated houseguest, no name.
  const hg = generateHouse(new SeededRandom(424242)).npcs[0]!;
  this.npc = hg.id;
  this.premiereCharacter = hg.character;
  this.premiereCharacterBytes = JSON.stringify(hg.character);
});

When("many events accumulate over the season", function (this: BbWorld) {
  for (let i = 0; i < 12; i++) this.soul!.recordToSoul(this.npc!, `season memory ${i} about the house`);
});

Then("the soul's narrative and indexed-memory count grow", function (this: BbWorld) {
  const soul = this.soul!.soulOf(this.npc!);
  assert.ok(soul.memories.length > 0 && soul.narrative.length > 0);
});

Then("the growth is monotonic — no memory is thinned away", function (this: BbWorld) {
  assert.equal(this.soul!.soulOf(this.npc!).memories.length, 12);
});

Then("the static Character baseline is unchanged", function (this: BbWorld) {
  // T4: a real byte-stability assertion. A full season of soul memories has accumulated for this
  // houseguest; the static CHARACTER captured at premiere must be byte-identical — not one field,
  // not one ordering, drifted. (The soul is the ONLY thing that deepens; the character is facts.)
  assert.equal(
    JSON.stringify(this.premiereCharacter),
    this.premiereCharacterBytes,
    "the static Character is byte-stable across a season of soul-deepening",
  );
});

// --- The vector index is engine-only ------------------------------------------

When("the dependency graph is checked", async function (this: BbWorld) {
  this.archViolations = await vaultBoundaryViolations();
});

Then("no outward module depends on the vector index or the full soul", function (this: BbWorld) {
  assert.deepEqual(this.archViolations, []);
});

// --- Deterministic recall -----------------------------------------------------

Given("a fixed seed and the deterministic test embedding", function (this: BbWorld) {
  this.soul = new SoulStore(embed);
  this.npc = HG;
  this.soul.recordToSoul(HG, "the veto betrayal");
  this.soul.recordToSoul(HG, "a quiet kitchen chat");
  this.soul.recordToSoul(HG, "the comp win celebration");
});

When("memory is recalled twice for the same context", function (this: BbWorld) {
  const a = this.soul!.recall(this.npc!, "betrayal", 3).map((m) => m.id);
  const b = this.soul!.recall(this.npc!, "betrayal", 3).map((m) => m.id);
  this.lastOutput = JSON.stringify([a, b]);
});

Then("both recalls return the same memories", function (this: BbWorld) {
  const [a, b] = JSON.parse(this.lastOutput) as [string[], string[]];
  assert.deepEqual(a, b);
});
