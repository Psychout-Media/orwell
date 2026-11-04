import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { renderGameContext } from "../../src/engine/momentPrompts";
import { producerPrompt, deriveNpcKnowledge, NO_NPC_PATHWAY } from "../../src/engine/diaryRoom";
import type { Beat } from "../../src/engine/diaryRoom";
import { resolvePending } from "../support/answerPending";
import { PLAYER } from "../../src/domain/ids";

// Feature 0115 — the strategic Diary Room: the player's DR intent grounds the GM's narration while the
// house stays STRUCTURALLY deceived. Roles only — no cast names. FAKE randomness via the seeded engine.

let dsUsers = 0;
function drGame(w: BbWorld, seed = 11): void {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`dr${dsUsers++}`);
  sb.session.createCharacter({ playerName: "Player", seed });
  w.drSandbox = sb;
}
function reachLiveHouse(w: BbWorld): void {
  for (let i = 0; i < 60 && w.drSandbox!.session.snapshot().live?.hoh === undefined; i++) {
    const v = w.drSandbox!.session.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => w.drSandbox!.session.submitDecision(req));
  }
}

// --- Grounding ----------------------------------------------------------------

Given("a live game where the player has recorded a Diary-Room strategy", async function (this: BbWorld) {
  drGame(this, 11);
  await this.drSandbox!.mcp.player.callTool("diaryRoom", { entry: "I keep telling them we're ride-or-die but I am gunning for them" });
});

When("the narrator's game context is built for the player", function (this: BbWorld) {
  this.drContext = renderGameContext(this.drSandbox!.session.getGameState());
});

Then("it carries the player's Diary-Room strategy as a private steer", function (this: BbWorld) {
  assert.ok(this.drContext!.includes("gunning for them"), "the player's DR strategy reaches the narrator context");
  assert.match(this.drContext!.toLowerCase(), /diary.?room/, "the steer is labelled the Diary Room");
});

Then("that steer is marked as known to the GM but not to the houseguests", function (this: BbWorld) {
  assert.match(
    this.drContext!.toLowerCase(),
    /you know it; the house does not|never voice it|do not|not to the houseguests/,
    "the steer is fenced GM-only / do-not-voice",
  );
});

// --- The structural wall ------------------------------------------------------

Given("a live game where the player has recorded a secret Diary-Room strategy", async function (this: BbWorld) {
  drGame(this, 23);
  reachLiveHouse(this);
  this.drSecret = "DR_STRAT_SENTINEL_no_npc_may_know_115";
  await this.drSandbox!.mcp.player.callTool("diaryRoom", { entry: this.drSecret });
});

When("each houseguest's knowledge and voicing projection is derived", function (this: BbWorld) {
  // Sanity: the secret DID reach the player-facing side, so the wall assertions below are meaningful.
  assert.ok((this.drSandbox!.session.getGameState().playerDiaryRoom ?? []).join("|").includes(this.drSecret!));
});

Then("none of them knows the Diary-Room strategy", function (this: BbWorld) {
  const npcIds = this.drSandbox!.session.snapshot().house!.npcs.map((n) => n.id);
  for (const id of npcIds) {
    assert.ok(!this.drSandbox!.engine.knowledge.knownTo(id).some((k) => k.content.includes(this.drSecret!)), `${id} must not know the DR strategy`);
  }
});

Then("no houseguest voicing projection carries the Diary-Room strategy", function (this: BbWorld) {
  const npcIds = this.drSandbox!.session.snapshot().house!.npcs.map((n) => n.id);
  for (const id of npcIds) {
    const voice = this.drSandbox!.session.npcVoice(id);
    if (voice) assert.ok(!JSON.stringify(voice).includes(this.drSecret!), `${id}'s voice projection must not carry the DR strategy`);
  }
});

Then("the Diary-Room strategy is stripped from any NPC-knowledge derivation", function (this: BbWorld) {
  const drFact = this.drSandbox!.engine.knowledge.knownTo(PLAYER).find((k) => k.content.includes(this.drSecret!));
  assert.ok(drFact, "the DR fact is the player's own knowledge");
  assert.equal(drFact!.pathway, NO_NPC_PATHWAY);
  assert.deepEqual(deriveNpcKnowledge([drFact!]), [], "deriveNpcKnowledge strips the DR fact");
});

// --- Weighted producer prompts (pure — no game needed) ------------------------

When("the game reaches a dramatic beat", function () { /* pure producerPrompt below */ });

Then("the Diary-Room invitation asks a question specific to that beat", function () {
  for (const beat of ["nomination", "veto-ceremony", "eviction"] as Beat[]) {
    const p = producerPrompt(beat);
    assert.equal(p.invite, true, `${beat} invites`);
    assert.ok(p.reason && !/^dramatic beat:/.test(p.reason), `${beat} asks a real question, not the bare label`);
    assert.ok(p.reason!.endsWith("?"), `${beat} asks a question`);
  }
});

Then("at a routine beat there is no Diary-Room invitation", function () {
  for (const beat of ["routine-chat", "idle", "downtime"] as Beat[]) {
    assert.equal(producerPrompt(beat).invite, false, `${beat} does not invite`);
  }
});

// --- The retrospective through-line -------------------------------------------

Given("a finished season where the player recorded Diary-Room confessionals", async function (this: BbWorld) {
  drGame(this, 5);
  await this.drSandbox!.mcp.player.callTool("diaryRoom", { entry: "My whole game is quietly running the house" });
  assert.equal(this.drSandbox!.session.seasonRetrospective(), null, "the retrospective stays sealed while live");
  const s = this.drSandbox!.session;
  for (let i = 0; i < 4000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => s.submitDecision(req));
    if (v.finished || s.snapshot().live?.winner !== undefined) break;
  }
});

When("the post-season retrospective is unsealed", function (this: BbWorld) {
  this.drRetro = this.drSandbox!.session.seasonRetrospective();
});

Then("it surfaces the player's own confessionals alongside the hidden story", function (this: BbWorld) {
  assert.ok(this.drRetro, "the retrospective unseals once the season is finished");
  assert.ok(
    this.drRetro!.playerConfessionals.includes("My whole game is quietly running the house"),
    "the player's own confessional resurfaces",
  );
});

// --- Vault-free ---------------------------------------------------------------

Given("a live game whose Vault holds hidden scheming while the player keeps a Diary Room", async function (this: BbWorld) {
  drGame(this, 41);
  this.drSecret = "VAULT_115_SENTINEL";
  this.drSandbox!.engine.vault.writeHidden({ id: "v115", kind: "hidden-attribute", content: `hidden ${this.drSecret}` });
  await this.drSandbox!.mcp.player.callTool("diaryRoom", { entry: "my private read" });
});

Then("the narrator context carries no Vault sentinel value", function (this: BbWorld) {
  assert.ok(!this.drContext!.includes(this.drSecret!), "no Vault sentinel reaches the narrator context");
});
