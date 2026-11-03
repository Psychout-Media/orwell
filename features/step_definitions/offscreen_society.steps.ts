import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { diffuseGossip, makeSocialGraph } from "../../src/engine/gossip";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";

// Feature 0038 (live off-screen society). Real-time purge 2026-07-10: the house lives ONLY on the
// player's play-clock (turn-driven off-screen ticks) — there is no wall-clock watcher. HARD rule:
// roles only — no fixture names.

let osUsers = 0;
function osGame(w: BbWorld, seed: number): void {
  const reg = new GameSessionRegistry();
  const user = `os${osUsers++}`;
  const orch = new Orchestrator(reg, { now: () => seed }, { seed });
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  w.osRegistry = reg; w.osUser = user; w.osSandbox = sb; w.osOrch = orch;
}

const TYPED = new Set(["alliance", "gossip", "conflict", "bonding", "strategy", "showmance", "betrayal"]);

// --- 0038 Scenario: more than one kind of interaction --------------------------------

Given("a started game the player has left idle", function (this: BbWorld) {
  osGame(this, 21);
});

When("the off-screen simulation runs several ticks", function (this: BbWorld) {
  for (let t = 0; t < 8; t++) assert.equal(this.osOrch!.advance(this.osUser!, "offscreen-tick").integrity, "ok");
});

Then("more than one kind of NPC-to-NPC interaction occurs off-screen", function (this: BbWorld) {
  const kinds = new Set(this.osSandbox!.engine.events.queryAll().filter((e) => e.hidden && TYPED.has(e.type)).map((e) => e.type));
  assert.ok(kinds.size > 1, `varied off-screen life (saw: ${[...kinds].join(",")})`);
});

Then("none of it is witnessed by the player", function (this: BbWorld) {
  const scenes = this.osSandbox!.engine.events.queryAll().filter((e) => TYPED.has(e.type) && e.id.startsWith("offscreen:"));
  assert.ok(scenes.length > 0);
  for (const s of scenes) assert.ok(!s.witnessSet.includes(PLAYER), "the player witnesses no off-screen scene");
});

// --- 0038 Scenario: information travels and drifts ------------------------------------

Given("a hidden fact known to one houseguest", function (this: BbWorld) {
  osGame(this, 22);
  this.osFactOrigin = npc(1);
});

When("the off-screen society runs", function (this: BbWorld) {
  // The same diffusion machinery the live tick wires (deterministic fixture graph for the spread).
  const ids = [npc(1), npc(2), npc(3), npc(4), npc(5)];
  const edges = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b] as const));
  const { factId } = diffuseGossip({
    knowledge: this.osSandbox!.engine.knowledge,
    graph: makeSocialGraph(edges),
    rng: new SeededRandom(7),
    origin: this.osFactOrigin!,
    fact: { content: "a houseguest has a final-two nobody knows about" },
    rounds: 3,
  });
  this.osFactId = factId;
});

Then("the fact diffuses to other houseguests along the social graph", function (this: BbWorld) {
  const holders = [npc(2), npc(3), npc(4), npc(5)].filter((id) =>
    this.osSandbox!.engine.knowledge.knownTo(id).some((k) => k.factId === this.osFactId));
  assert.ok(holders.length >= 1, "the rumor spread beyond its origin");
});

Then("it carries a source and a confidence that decays with distance", function (this: BbWorld) {
  for (const id of [npc(2), npc(3), npc(4), npc(5)]) {
    const k = this.osSandbox!.engine.knowledge.knownTo(id).find((f) => f.factId === this.osFactId);
    if (!k) continue;
    assert.ok(k.source, "provenance travels with the belief");
    assert.ok((k.confidence ?? 1) < 1, "confidence decays away from the origin");
  }
});

Then("its content may drift from the original with each retelling", function (this: BbWorld) {
  const drifted = [npc(2), npc(3), npc(4), npc(5)]
    .map((id) => this.osSandbox!.engine.knowledge.knownTo(id).find((f) => f.factId === this.osFactId))
    .filter((k): k is NonNullable<typeof k> => !!k);
  assert.ok(drifted.some((k) => k.content !== k.originalContent), "a retelling drifted");
});

// --- 0038 Scenario: a distorted rumor reaches the player --------------------------------

Given("the off-screen society has diffused a fact toward the player", function (this: BbWorld) {
  // Drive the LIVE tick (the production wiring) until a rumor chain terminates at the player. A generous
  // seed search — WHICH seed lands a player-terminating chain shifted when the player began entering the
  // living room (more scenes fall in their earshot), but the diffusion-to-player itself is unchanged.
  // A genuine GOSSIP rumor (not a direct telling): a `told-by:` pathway carrying provenance + decayed
  // confidence — that's the diffusion this scenario is about.
  const isRumor = (f: { pathway: string; source?: unknown; confidence?: number }): boolean =>
    f.pathway.startsWith("told-by:") && !!f.source && (f.confidence ?? 1) < 1;
  for (const seed of Array.from({ length: 24 }, (_, i) => i + 1)) {
    osGame(this, seed);
    for (let t = 0; t < 60; t++) {
      assert.equal(this.osOrch!.advance(this.osUser!, "offscreen-tick").integrity, "ok", "legal gossip never reads as a leak");
      if (this.osSandbox!.engine.knowledge.knownTo(PLAYER).some(isRumor)) return;
    }
  }
  assert.fail("no rumor terminated at the player across the seed set");
});

When("a diffusion pathway terminates at the player", function (this: BbWorld) {
  this.osPlayerRumor = this.osSandbox!.engine.knowledge.knownTo(PLAYER)
    .find((f) => f.pathway.startsWith("told-by:") && !!f.source && (f.confidence ?? 1) < 1);
  assert.ok(this.osPlayerRumor, "the player holds the rumor");
});

Then("the player's knowledge gains the belief with its source and confidence", function (this: BbWorld) {
  assert.ok(this.osPlayerRumor!.source, "the player knows who told them");
  assert.ok((this.osPlayerRumor!.confidence ?? 1) < 1, "a rumor is never certainty");
});

Then("the player is shown no opinion number or hidden state", function (this: BbWorld) {
  const view = JSON.stringify(this.osSandbox!.session.getGameState()) + JSON.stringify(this.osSandbox!.player.getVisibleState());
  assert.ok(!/trust|threat|affinity|soul|hiddenElement/i.test(view), "no hidden-layer key on the player surface");
  const hidden = this.osSandbox!.engine.events.queryAll().filter((e) => e.hidden).map((e) => e.content);
  for (const h of hidden) assert.ok(!this.osPlayerRumor!.content.includes(h), "the rumor is a paraphrase, never the verbatim scene");
});

// --- 0038 Scenario: off-screen scenes deepen the souls ------------------------------------

When("the off-screen society runs several ticks", function (this: BbWorld) {
  for (let t = 0; t < 8; t++) assert.equal(this.osOrch!.advance(this.osUser!, "offscreen-tick").integrity, "ok");
});

Then("each houseguest's soul accumulates the off-screen scenes it lived", function (this: BbWorld) {
  const core = this.osSandbox!.session.snapshot();
  const deepened = core.house!.npcs.filter((n) => n.soul.memory.length > 0);
  assert.ok(deepened.length > 0, "off-screen life deepened the souls");
});

Then("a later recall can surface a specific past off-screen moment", function (this: BbWorld) {
  const core = this.osSandbox!.session.snapshot();
  const someone = core.house!.npcs.find((n) => n.soul.memory.length > 0)!;
  // Recall must genuinely RETURN the recorded off-screen content — not merely "answer" (T3). Query
  // the soul index with a specific lived note and assert that exact past moment comes back.
  const target = someone.soul.memory[0]!;
  const recalled = this.osSandbox!.engine.soul.recall(someone.id, target, 3);
  assert.ok(recalled.length >= 1, "the recall index surfaces at least one lived off-screen moment");
  assert.ok(
    recalled.some((m) => m.content === target),
    "the specific off-screen note the houseguest lived is recallable by its own content",
  );
});

Then("no previously recorded soul detail is lost", function (this: BbWorld) {
  const before = this.osSandbox!.session.snapshot().house!.npcs.map((n) => n.soul.memory.length);
  this.osOrch!.advance(this.osUser!, "offscreen-tick");
  const after = this.osSandbox!.session.snapshot().house!.npcs.map((n) => n.soul.memory.length);
  for (let i = 0; i < before.length; i++) assert.ok(after[i]! >= before[i]!, "soul memory only accumulates");
});

// --- 0038 Scenario: bounded and deterministic ----------------------------------------------

Given("two games started from the same seed and left idle", function (this: BbWorld) {
  osGame(this, 33);
  this.osSandboxA = this.osSandbox; this.osOrchA = this.osOrch; this.osUserA = this.osUser;
  // The SAME user key + seed: the per-user rng streams must match for determinism.
  const reg = new GameSessionRegistry();
  const user = this.osUserA!;
  const orch = new Orchestrator(reg, { now: () => 33 }, { seed: 33 });
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: 33 });
  this.osRegistry = reg; this.osUser = user; this.osSandbox = sb; this.osOrch = orch;
});

When("the same number of off-screen ticks is applied to each", function (this: BbWorld) {
  for (let t = 0; t < 6; t++) {
    this.osOrchA!.advance(this.osUserA!, "offscreen-tick");
    this.osOrch!.advance(this.osUser!, "offscreen-tick");
  }
});

Then("their resulting societies are identical", function (this: BbWorld) {
  const a = this.osSandboxA!.engine.events.queryAll().filter((e) => e.hidden).map((e) => `${e.type}:${e.content}`);
  const b = this.osSandbox!.engine.events.queryAll().filter((e) => e.hidden).map((e) => `${e.type}:${e.content}`);
  assert.deepEqual(a, b, "same seed ⇒ the same hidden society");
});

Then("a single committed turn fires at most one off-screen tick", function (this: BbWorld) {
  // Real-time purge 2026-07-10: the house lives ONLY on the player's play-clock — one bounded
  // off-screen tick per COMMITTED TURN (there is no wall-clock watcher and no per-wake cap). Spy
  // the orchestrator's `advance` and prove a single player-turn commit fires EXACTLY one off-screen
  // tick — the bound is the turn boundary itself, so the house never fast-forwards a season.
  const registry = new GameSessionRegistry();
  const orch = new Orchestrator(registry, new FakeClock(), { seed: 33, turnDriven: true });
  let offscreenTicks = 0;
  const realAdvance = orch.advance.bind(orch);
  orch.advance = (user, trigger, opts) => {
    if (trigger === "offscreen-tick") offscreenTicks++;
    return realAdvance(user, trigger, opts);
  };
  registry.sandboxFor("os-cap").session.createCharacter({ playerName: "The Player", seed: 33 });
  orch.commitPlayerTurn("os-cap"); // ONE player turn
  assert.equal(offscreenTicks, 1, `one committed turn fires exactly one off-screen tick (was ${offscreenTicks})`);
});

// --- 0038 Scenario: Vault-free and isolated --------------------------------------------------

Given("two users each have their own idle game whose Vault holds hidden scheming", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  const orch = new Orchestrator(reg, { now: () => 44 }, { seed: 44 });
  const a = reg.sandboxFor("os-iso-a");
  const b = reg.sandboxFor("os-iso-b");
  a.session.createCharacter({ playerName: "The Player", seed: 44 });
  b.session.createCharacter({ playerName: "The Player", seed: 45 });
  // T11: plant a UNIQUE hidden sentinel in each game's Vault + a houseguest's knowledge, so the
  // Then can prove genuine content/knowledge cross-absence — a distinctive marker can't collide
  // across stores the way generic templated scene text can.
  this.osSentinelA = "ISO-SENTINEL-A-7f3";
  this.osSentinelB = "ISO-SENTINEL-B-9k2";
  a.engine.vault.writeHidden({ id: "iso:a", kind: "hidden-thread", content: `secret scheme ${this.osSentinelA}` });
  b.engine.vault.writeHidden({ id: "iso:b", kind: "hidden-thread", content: `secret scheme ${this.osSentinelB}` });
  a.engine.knowledge.seedBelief(npc(1), { content: `a houseguest knows ${this.osSentinelA}`, factId: "iso-fact-a" }, "witnessed");
  b.engine.knowledge.seedBelief(npc(1), { content: `a houseguest knows ${this.osSentinelB}`, factId: "iso-fact-b" }, "witnessed");
  this.osRegistry = reg; this.osOrch = orch;
  this.osSandboxA = a; this.osSandbox = b;
  this.osUserA = "os-iso-a"; this.osUser = "os-iso-b";
});

When("the off-screen society runs across both", function (this: BbWorld) {
  for (let t = 0; t < 6; t++) {
    this.osOrch!.advance(this.osUserA!, "offscreen-tick");
    this.osOrch!.advance(this.osUser!, "offscreen-tick");
  }
});

Then("no player surface reveals a hidden scene or an opinion number", function (this: BbWorld) {
  for (const sb of [this.osSandboxA!, this.osSandbox!]) {
    const view = JSON.stringify(sb.session.getGameState()) + "\n" + JSON.stringify(sb.player.getVisibleState());
    const hidden = sb.engine.events.queryAll().filter((e) => e.hidden).map((e) => e.content);
    for (const h of hidden) assert.ok(!view.includes(h), "no verbatim hidden scene on a player surface");
    assert.ok(!/trust|threat|affinity|soul/i.test(view), "no opinion number");
  }
});

Then("no off-screen activity carries one user's content into the other's game", function (this: BbWorld) {
  // T11: prove CONTENT/KNOWLEDGE cross-absence — that the absent party genuinely cannot ACCESS the
  // other user's off-screen life — not merely disjoint id-sets (disjoint by construction). Each
  // game planted a UNIQUE hidden sentinel in its Vault + a houseguest's knowledge (the Given);
  // after both ran their off-screen society, that sentinel must be entirely unreachable from the
  // other game — in its full event/knowledge record AND on its player surface.
  const a = this.osSandboxA!; const b = this.osSandbox!;
  assert.notEqual(a.engine.events, b.engine.events, "separate event stores (0021)");
  assert.notEqual(a.engine.knowledge, b.engine.knowledge, "separate knowledge graphs (0021)");

  const recordAndKnowledgeOf = (sb: typeof a): string => {
    const core = sb.session.snapshot();
    const ids = [core.house!.player.id, ...core.house!.npcs.map((n) => n.id)];
    const known = ids.flatMap((id) => sb.engine.knowledge.knownTo(id).map((k) => `${k.content}|${k.originalContent ?? ""}`));
    return JSON.stringify(sb.engine.events.queryAll()) + "\n" + known.join("\n");
  };
  const surfaceOf = (sb: typeof a): string =>
    JSON.stringify(sb.session.getGameState()) + "\n" + JSON.stringify(sb.player.getVisibleState());

  // Each game holds its OWN sentinel in its hidden layer (sanity: the marker really is in A/B).
  assert.ok(recordAndKnowledgeOf(a).includes(this.osSentinelA!), "user A holds its own hidden sentinel");
  assert.ok(recordAndKnowledgeOf(b).includes(this.osSentinelB!), "user B holds its own hidden sentinel");

  // ...and NEITHER game's record/knowledge nor player surface can reach the OTHER's sentinel.
  const aReach = recordAndKnowledgeOf(a) + "\n" + surfaceOf(a);
  const bReach = recordAndKnowledgeOf(b) + "\n" + surfaceOf(b);
  assert.ok(!bReach.includes(this.osSentinelA!), "user A's hidden content/knowledge never reaches user B");
  assert.ok(!aReach.includes(this.osSentinelB!), "user B's hidden content/knowledge never reaches user A");
});
