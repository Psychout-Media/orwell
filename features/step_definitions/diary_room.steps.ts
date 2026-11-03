import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { deriveNpcKnowledge, producerPrompt } from "../../src/engine/diaryRoom";
import type { Beat } from "../../src/engine/diaryRoom";
import { npcExpress } from "../../src/engine/conversation";
import { PLAYER, npc } from "../../src/domain/ids";

// The NPCs the test sandbox seeds any state for — npc(1..8). The DR→NPC guarantee itself is
// structural (`deriveNpcKnowledge`) and cast-size-independent; this list only bounds the redundant
// per-NPC belt-and-suspenders sweeps (so BOTH sweeps below iterate the SAME set, not 8 vs 4).
const SEEDED_NPCS = Array.from({ length: 8 }, (_, i) => npc(i + 1));

// Reused steps (defined elsewhere, matched by text regardless of keyword):
//  - Background "a running game sandbox with a fully populated Producer's Vault" (mcp_boundary)
//  - "the player speaks privately in the Diary Room" (event_visibility) — sets this.factContent
//  - "an NPC confessional recorded with a witness set that excludes the player" (vault_wall) — this.specific
//  - "any player-facing surface is produced" (vault_wall) — this.lastOutput
//  - "its sentinel value does not appear" (vault_wall)

// --- Player DR content is the player's own knowledge --------------------------

Then("that content is part of the player's knowledge", function (this: BbWorld) {
  const known = this.sandbox!.engine.knowledge.knownTo(PLAYER);
  assert.ok(known.some((k) => k.content === this.factContent), "DR content is player knowledge");
});

// --- Player DR content reaches no NPC -----------------------------------------

Then("no NPC's knowledge state gains that content", function (this: BbWorld) {
  // The REAL, cast-size-independent guarantee: the DR → NPC wall strips DR content even if player
  // knowledge were fed to NPC derivation.
  const derived = deriveNpcKnowledge(this.sandbox!.engine.knowledge.knownTo(PLAYER));
  assert.ok(!derived.some((k) => k.content === this.factContent), "deriveNpcKnowledge excludes DR content");
  // Belt-and-suspenders: no seeded NPC's knowledge contains it.
  for (const id of SEEDED_NPCS) {
    const known = this.sandbox!.engine.knowledge.knownTo(id);
    assert.ok(!known.some((k) => k.content === this.factContent), `${id} must not know DR content`);
  }
});

Then("no NPC decision changes because of it", function (this: BbWorld) {
  // An NPC cannot assert or even suspect a DR-only fact — it has no pathway to it,
  // so it can play no part in the NPC's reasoning.
  for (const id of SEEDED_NPCS) {
    const k = this.sandbox!.engine.knowledge;
    const expr = npcExpress({ content: this.factContent! }, k.knownTo(id), k.suspicionsOf(id));
    assert.equal(expr.mode, "silent", `${id} reasoning is untouched by DR content`);
  }
});

// --- The public/private gap ----------------------------------------------------

Given("the player says one thing to houseguests and a different thing in the Diary Room", function (this: BbWorld) {
  this.publicStmt = "I'm loyal to you and we go to the end together.";
  this.drStmt = "Honestly I'm cutting them next week.";
  const commands = new EngineCommandsAdapter(this.sandbox!.engine.events, this.sandbox!.engine.knowledge);
  // Said publicly → a witnessed event (the houseguest is in the witness set).
  commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: this.publicStmt });
  // Said in the DR → player-only knowledge, no NPC pathway.
  this.sandbox!.engine.knowledge.recordDiaryRoom(this.drStmt);
});

When("houseguests act", function (this: BbWorld) {
  // A houseguest acts on what it witnessed/knows — never on the DR.
  const k = this.sandbox!.engine.knowledge;
  this.npcActedOn = this.sandbox!.engine.events.query({ witnessedBy: npc(1) }).map((e) => e.content);
  // What the houseguest would actually SAY/act on, through the real expression rule over its own knowledge.
  this.npcExpressed = { dr: npcExpress({ content: this.drStmt! }, k.knownTo(npc(1)), k.suspicionsOf(npc(1))) };
});

Then("they act on what the player said publicly", function (this: BbWorld) {
  assert.ok(this.npcActedOn!.some((c) => c.includes(this.publicStmt!)), "NPC acts on public speech");
  // The witness set is what routes it: a houseguest outside it never saw the public statement either.
  const bystander = this.sandbox!.engine.events.query({ witnessedBy: npc(2) }).map((e) => e.content);
  assert.ok(!bystander.some((c) => c.includes(this.publicStmt!)), "a non-witness did not receive the public statement");
});

Then("never on what the player said in the Diary Room", function (this: BbWorld) {
  assert.ok(!this.npcActedOn!.some((c) => c.includes(this.drStmt!)), "NPC must not see the DR statement");
  assert.equal(this.npcExpressed!.dr.mode, "silent", "the DR statement is outside the houseguest's reasoning");
  const k = this.sandbox!.engine.knowledge;
  assert.ok(!k.knownTo(npc(1)).some((f) => f.content === this.drStmt), "DR not in NPC knowledge");
  assert.ok(!deriveNpcKnowledge(k.knownTo(PLAYER)).some((f) => f.content === this.drStmt), "DR stripped from NPC derivation");
});

// --- NPC confessionals are Vault-only -----------------------------------------

Then("the confessional does not appear", function (this: BbWorld) {
  assert.ok(!this.lastOutput.includes(this.specific!.content), "confessional content leaked to a player surface");
});

// --- Producer prompts at dramatic beats ---------------------------------------

Given("the player's position in the house has just shifted significantly", function (this: BbWorld) {
  this.beat = "position-shift";
});

Then("the producers may invite the player to the Diary Room", function (this: BbWorld) {
  assert.equal(producerPrompt(this.beat as Beat).invite, true);
});

Then("such prompts occur at dramatic beats, not on every turn", function () {
  // Over a realistic turn stream, prompts fire only at the dramatic beats.
  const stream: Beat[] = [
    "routine-chat", "idle", "nomination", "routine-chat", "downtime",
    "veto-ceremony", "idle", "routine-chat", "eviction", "downtime",
  ];
  const invited = stream.filter((b) => producerPrompt(b).invite);
  assert.equal(invited.length, 3, "fires only on the 3 dramatic beats");
  assert.ok(invited.length < stream.length, "not on every turn");
  // The routine beats never trigger a prompt.
  assert.equal(producerPrompt("routine-chat").invite, false);
  assert.equal(producerPrompt("idle").invite, false);
});
