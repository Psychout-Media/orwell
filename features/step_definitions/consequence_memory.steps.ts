import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { ConsequenceEngine, restoreMemory } from "../../src/engine/consequence";
import { RelationshipModel } from "../../src/engine/relationships";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { chooseNominations } from "../../src/engine/season";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import { startLiveSweep, setLive, liveOf, livePlayerSurfaces, livePlayerProse, livePlayerProjections } from "../support/liveSweep";
import { assertNoNumericRelationshipFields, assertNoRelationshipValueProse, assertNoOpinionChangedProse } from "../support/relationshipLeakChecks";

// Reuses: "a running game sandbox with a fully populated Producer's Vault" (Background),
// "any player-facing surface is produced" (vault_wall), "no Vault sentinel value appears" (god_mode).

function freshEngine(seed = 1): ConsequenceEngine {
  return new ConsequenceEngine(new InMemoryEventStore(), new RelationshipModel(0.5), new SeededRandom(seed));
}

// --- An action changes the hidden opinion -------------------------------------

Given("an NPC's hidden read of the player", function (this: BbWorld) {
  this.consequence = freshEngine(1);
  this.npc = npc(1);
  this.relBefore = { ...this.consequence.relationships().edge(this.npc, PLAYER) };
});

When("the player has a warm, bonding interaction with that NPC", function (this: BbWorld) {
  this.consequence!.record({ initiator: PLAYER, witnessSet: [PLAYER, this.npc!], content: "a warm kitchen chat", kind: "bonding" });
});

Then("the NPC's hidden trust and affinity toward the player increase", function (this: BbWorld) {
  const e = this.consequence!.relationships().edge(this.npc!, PLAYER);
  assert.ok(e.trust > this.relBefore!.trust, "trust up");
  assert.ok(e.affinity > this.relBefore!.affinity, "affinity up");
  this.relBefore = { ...e }; // baseline for the betrayal step
});

When("the player betrays that NPC", function (this: BbWorld) {
  this.consequence!.record({ initiator: PLAYER, witnessSet: [PLAYER, this.npc!], content: "a cold betrayal", kind: "betrayal" });
});

Then("the NPC's hidden trust drops and their hidden threat read rises", function (this: BbWorld) {
  const e = this.consequence!.relationships().edge(this.npc!, PLAYER);
  assert.ok(e.trust < this.relBefore!.trust, "trust dropped");
  assert.ok(e.threat > this.relBefore!.threat, "threat rose");
});

Then("the same actions under the same seed produce the same shifts", function () {
  const run = (): unknown => {
    const e = freshEngine(1);
    e.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a warm kitchen chat", kind: "bonding" });
    e.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a cold betrayal", kind: "betrayal" });
    return e.relationships().edge(npc(1), PLAYER);
  };
  assert.deepEqual(run(), run());
});

// --- The change is invisible --------------------------------------------------

When("the player's action shifts a houseguest's hidden opinion", function (this: BbWorld) {
  // PAT-2: drive the action through the LIVE game's own command seam (which folds the hidden opinion in the
  // engine's relationship model), with sentinels planted in that game's hidden state. The reused
  // "no Vault sentinel value appears" sweep then reads THAT game's surfaces (not a fresh engine's/the canary's).
  const live = startLiveSweep({ seed: 1, user: "pat2-opinion" });
  setLive(this, live);
  const mate = live.sb.session.snapshot().house!.npcs[0]!.id;
  live.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, mate], content: "a chat", kind: "bonding", toward: [mate] });
  // ONE moment-prompt read for the whole scenario: getMomentPrompt consumes the one-shot Producer Read, so the
  // sentinel sweep, the structured walk and the prose backstop must all look at this same prompt.
  live.momentPrompt = live.sb.session.getMomentPrompt({});
  this.lastView = livePlayerSurfaces(live.sb, live.momentPrompt);
});

/** The text to prose-sweep: the live game's ENGINE-GENERATED player text (the moment prompt's fixed instruction template is cut out; its dynamic context is swept). */
const proseOf = (w: BbWorld): string => {
  const live = liveOf(w);
  return live?.sb ? livePlayerProse(live.sb, live.momentPrompt) : w.lastOutput;
};

Then("no opinion number or relationship value appears", function (this: BbWorld) {
  // PAT-2: (1) the STRONG check walks the live game's STRUCTURED player projections (HUD, npcVoice, whereabouts,
  // journal, moment prompt) and fails on ANY numeric value under a trust/affinity/threat/opinion/relationship/edge
  // key; (2) the prose regex is the backstop for a value rendered into text ("trust 7", "threat (8)", "trust: 0.8").
  // The prose is the live game's engine-generated text (the fixed moment-prompt template is cut out, its dynamic context swept) — its plain words ("can I trust you?", a speech tell
  // "makes a threat sound like small talk") are legitimate, and the fixed moment-prompt template is not swept.
  const live = liveOf(this);
  assert.ok(live?.sb, "the scenario drives a live game, so its structured projections can be walked");
  assertNoNumericRelationshipFields(livePlayerProjections(live.sb!, live.momentPrompt));
  assertNoRelationshipValueProse(proseOf(this));
});

Then("no message states that the houseguest's opinion changed", function (this: BbWorld) {
  // PAT-2: clause-bounded (no `.*` across the text) so unrelated sentences don't match; covers "soured", "softened",
  // "warmed", "cooled", "thinks less of you", "no longer trusts you", "likes you more", ... Engine text only.
  assertNoOpinionChangedProse(proseOf(this));
});

// --- Wins and votes are consequential -----------------------------------------

When("a competition is won", function (this: BbWorld) {
  this.consequence = freshEngine(1);
  this.consequence.recordCompetitionWin(npc(1), "endurance");
});

Then("the win is recorded as an event", function (this: BbWorld) {
  assert.ok(this.consequence!.snapshot().events.some((e) => e.type === "competition"));
});

When("a houseguest votes to evict the player's ally", function (this: BbWorld) {
  this.threatBefore = this.consequence!.relationships().edge(npc(2), PLAYER).threat;
  this.consequence!.recordVoteAgainstPlayer(npc(2), npc(3));
});

Then("that vote is recorded as an event", function (this: BbWorld) {
  assert.ok(this.consequence!.snapshot().events.some((e) => e.type === "vote"));
});

Then("the responsible houseguest's hidden threat read toward the player rises", function (this: BbWorld) {
  assert.ok(this.consequence!.relationships().edge(npc(2), PLAYER).threat > this.threatBefore!);
});

// --- Persistence: lossless, monotonic -----------------------------------------

Given("a game with many recorded events", function (this: BbWorld) {
  this.consequence = freshEngine(2);
  this.consequence.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "scheme", kind: "strategy" });
  this.consequence.record({ initiator: npc(2), witnessSet: [npc(2), npc(3)], content: "off-screen plot", kind: "gossip" });
  this.consequence.recordCompetitionWin(npc(4), "puzzle");
  this.consequence.recordVoteAgainstPlayer(npc(5), npc(6));
  for (let i = 0; i < 3; i++) this.consequence.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "bond", kind: "bonding" });
});

When("the game is saved and reloaded from the long-term store", function (this: BbWorld) {
  this.snap = this.consequence!.snapshot();
  this.reloaded = restoreMemory(this.snap);
});

Then("every event's content, witnesses, hidden flag, timestamp, and kind survive unchanged", function (this: BbWorld) {
  assert.deepEqual(this.reloaded!.snapshot().events, this.snap!.events);
});

Then("the total event count after reload is at least what it was before", function (this: BbWorld) {
  assert.ok(this.reloaded!.snapshot().events.length >= this.snap!.events.length);
});

Then("no event detail is thinned or dropped", function (this: BbWorld) {
  assert.equal(this.reloaded!.snapshot().events.length, this.snap!.events.length);
});

// --- Recall after leaving / restart -------------------------------------------

Given("the player wronged a houseguest several weeks ago", function (this: BbWorld) {
  this.consequence = freshEngine(3);
  this.consequence.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "an old betrayal", kind: "betrayal" });
  for (let i = 0; i < 5; i++) this.consequence.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(2)], content: "alliance", kind: "alliance" });
  this.relBefore = { ...this.consequence.relationships().edge(npc(1), PLAYER) };
});

When("the player leaves and the game is reloaded from the long-term store", function (this: BbWorld) {
  this.snap = this.consequence!.snapshot();
  this.reloaded = restoreMemory(this.snap);
});

Then("the full event history is restored", function (this: BbWorld) {
  assert.deepEqual(this.reloaded!.snapshot().events, this.snap!.events);
});

Then("that houseguest's hidden read of the player equals what it was before leaving", function (this: BbWorld) {
  assert.deepEqual(this.reloaded!.relationships().edge(npc(1), PLAYER), this.relBefore);
});

Then("an alliance the player built is still intact", function (this: BbWorld) {
  assert.ok(this.reloaded!.relationships().bondStrength(npc(2), PLAYER) > 0.5, "the alliance bond survived");
});

// --- Restart (fresh stores) ---------------------------------------------------

Given("a game persisted to the long-term store", function (this: BbWorld) {
  this.consequence = freshEngine(4);
  for (let i = 0; i < 4; i++) this.consequence.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "bond", kind: "bonding" });
  this.snap = this.consequence.snapshot();
});

When("the engine process is restarted and the game is loaded fresh", function (this: BbWorld) {
  this.reloaded = restoreMemory(this.snap!); // brand-new EventStore + RelationshipModel
});

Then("the events and the hidden relationship state are restored as a superset", function (this: BbWorld) {
  assert.ok(this.reloaded!.snapshot().events.length >= this.snap!.events.length);
  assert.deepEqual(this.reloaded!.relationships().serialize(), this.snap!.relationships);
});

// --- A hidden change drives behavior ------------------------------------------

Given("the player has quietly earned a houseguest's distrust", function (this: BbWorld) {
  this.consequence = freshEngine(5);
  this.consequence.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a quiet betrayal", kind: "betrayal" });
});

When("houseguest behavior is resolved later", function (this: BbWorld) {
  this.noms = chooseNominations(npc(1), [npc(1), PLAYER, npc(2), npc(3)], this.consequence!.relationships());
});

Then("that houseguest is more likely to seek the player out warily or target them", function (this: BbWorld) {
  assert.ok(this.noms!.includes(PLAYER), "the distrustful HOH targets the player");
});

Then("this happens without any opinion value ever being shown to the player", function (this: BbWorld) {
  const surfaces = this.sandbox!.allPlayerOutputs();
  assert.ok(!/trust|affinity|threat/i.test(surfaces));
});

// --- The whole loop, end to end -----------------------------------------------

Given("a multi-step game of conversations, a competition, and a vote", function (this: BbWorld) {
  this.consequence = freshEngine(6);
  for (let i = 0; i < 4; i++) this.consequence.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(2)], content: "bond", kind: "bonding" });
  this.consequence.record({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "betrayal", kind: "betrayal" });
  this.consequence.recordCompetitionWin(PLAYER, "endurance");
  this.consequence.recordVoteAgainstPlayer(npc(5), npc(6));
});

When("everything is recorded, applied, saved, and reloaded", function (this: BbWorld) {
  this.snap = this.consequence!.snapshot();
  this.reloaded = restoreMemory(this.snap);
});

Then("the house's later behavior is consistent with everything that happened", function (this: BbWorld) {
  const r = this.reloaded!.relationships();
  // bonded ally reads warmer than the betrayed houseguest; the betrayed one targets the player.
  assert.ok(r.bondStrength(npc(2), PLAYER) > r.bondStrength(npc(1), PLAYER), "ally warmer than the betrayed");
  assert.ok(r.edge(npc(5), PLAYER).threat > 0.1, "the voter holds threat toward the player");
  assert.ok(chooseNominations(npc(1), [npc(1), PLAYER, npc(2), npc(3)], r).includes(PLAYER));
});

Then("nothing the player legitimately changed was lost", function (this: BbWorld) {
  // Superset, never a thinning (0007/0023): every persisted event + edge is preserved exactly.
  // (Lazily-created neutral edges from later reads don't count as "lost" data.)
  assert.deepEqual(this.reloaded!.snapshot().events, this.snap!.events);
  const now = this.reloaded!.relationships();
  for (const e of this.snap!.relationships.edges) {
    assert.deepEqual(
      now.edge(e.from, e.to),
      {
        trust: e.trust, affinity: e.affinity, threat: e.threat, alignment: e.alignment, confidence: e.confidence,
        // E54: `reliability` rides the same lossless round-trip (pre-E54 snapshots load at baseline).
        reliability: e.reliability ?? RELATIONSHIP_CONSTANTS.baseline.reliability,
      },
      `edge ${e.from}->${e.to} preserved`,
    );
  }
});
