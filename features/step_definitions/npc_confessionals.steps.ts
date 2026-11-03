import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { SoulStore } from "../../src/adapters/engine/SoulStore";
import { DeterministicEmbedding } from "../../src/adapters/embedding/DeterministicEmbedding";
import { confessionalFor, involvedConfessionals, recordConfessionalToSoul } from "../../src/engine/confessionals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { startLiveSweep, setLive, liveOf, livePlayerSurfaces, liveAdminSurface } from "../support/liveSweep";
import { PLAYER, npc } from "../../src/domain/ids";

// HARD rule: roles only — NPC, HOH, nominee, juror. No names.
const A = npc(1);
const B = npc(2);
const C = npc(3);
const fake = new DeterministicEmbedding();
const embed = (t: string): number[] => fake.embed(t);

/** A started game advanced over off-screen ticks until the house has confessed (engine.events). */
function confessingSandbox(user: string, seed: number, ticks: number) {
  const reg = new GameSessionRegistry();
  reg.sandboxFor(user).session.createCharacter({ playerName: "P", seed });
  const orch = new Orchestrator(reg, new FakeClock(), { seed });
  for (let i = 0; i < ticks; i++) orch.advance(user, "offscreen-tick");
  return reg.sandboxFor(user);
}

function confessionals(sb: ReturnType<typeof confessingSandbox>) {
  return sb.engine.events.queryAll().filter((e) => e.type === "confessional");
}

// --- Scenario: houseguests confess at dramatic beats (live nomination ceremony) ---

Given("a started game that reaches a nomination ceremony", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  const session = reg.sandboxFor("conf-live").session;
  session.createCharacter({ playerName: "P", seed: 7 });
  // Advance until a nomination ceremony resolves; submit the player's noms if it is their turn.
  for (let i = 0; i < 16; i++) {
    const v = session.advanceGame();
    if (v.pending?.kind === "comp-intent") session.submitDecision({ kind: "comp-intent", intent: "compete" }); // B46
    else if (v.pending?.kind === "comp-round") session.submitDecision({ kind: "comp-round", intent: "compete" }); // 0006 staged-rounds
    else if (v.pending?.kind === "nominations") {
      const opts = v.pending.options.map((o) => o.id);
      session.submitDecision({ kind: "nominations", choice: [opts[0]!, opts[1]!] });
    }
    if (v.event?.beat === "nominations") break;
  }
  this.registry = reg;
  this.liveUser = "conf-live";
});

When("the beat resolves", function () {
  // The nomination beat resolved in the Given (confessionals are recorded at commit time).
});

Then("the directly-involved houseguests each record a private confessional", function (this: BbWorld) {
  const sb = this.registry!.sandboxFor(this.liveUser!);
  const confs = sb.engine.events.queryAll().filter((e) => e.type === "confessional");
  assert.ok(confs.length > 0, "at least one houseguest confessed at the ceremony");
  for (const e of confs) {
    assert.equal(e.hidden, true);
    assert.deepEqual(e.witnessSet, [e.initiator]); // private — the confessing NPC alone
    assert.ok(!e.witnessSet.includes(PLAYER));
  }
});

// --- Scenario: an engine-grounded read -----------------------------------------

Given("a houseguest whose hidden relationship reads mark a clear top threat", function (this: BbWorld) {
  this.confRel = new RelationshipModel(0.5);
  const rng = new SeededRandom(1);
  for (let i = 0; i < 6; i++) this.confRel.applyDirected(A, B, "betrayal", rng); // A reads B as the threat
  for (let i = 0; i < 4; i++) this.confRel.applyDirected(A, C, "bonding", rng);     // A trusts C
  this.confessor = A;
});

When("that houseguest confesses", function (this: BbWorld) {
  this.confessional = confessionalFor(this.confessor!, [A, B, C], this.confRel!);
});

Then("the confessional names that threat as their target", function (this: BbWorld) {
  assert.equal(this.confessional!.target, B);
  assert.ok(this.confessional!.content.includes(B));
});

Then("it reflects who they actually trust and distrust", function (this: BbWorld) {
  // The named ally is the ACTUAL strongest bond; the target is the ACTUAL top threat — queried, not invented.
  assert.equal(this.confessional!.ally, C);
  const e = (x: string) => this.confRel!.edge(A, x);
  assert.ok(e(B).threat >= e(C).threat, "B is read as more of a threat than the ally C");
});

Then("it is not an invented stance improvised by the narrator", function (this: BbWorld) {
  // Derived purely from the engine signals: the same reads always yield the same confessional, and a
  // DIFFERENT relationship truth yields a different target — there is no free narrative input.
  const again = confessionalFor(A, [A, B, C], this.confRel!);
  assert.deepEqual({ t: again.target, a: again.ally }, { t: this.confessional!.target, a: this.confessional!.ally });
  const flipped = new RelationshipModel(0.5);
  const rng = new SeededRandom(2);
  for (let i = 0; i < 6; i++) flipped.applyDirected(A, C, "betrayal", rng); // now C is the threat
  assert.equal(confessionalFor(A, [A, B, C], flipped).target, C);
});

// --- Scenarios: never reaches the player / admin (Vault wall, sentinel-checked) -
// Uses the canary sandbox, which records confessional events with unique sentinels and exposes the
// player + admin surfaces — so we can prove no confessional value bleeds onto either. ("no Vault
// sentinel value appears" reuses the god_mode step, which reads this.lastView + this.sandbox.sentinels.)

// PAT-2: the scenarios below run over a LIVE game (the real engine mints its confessionals as the off-screen
// clock advances) with sentinels planted in that same game's hidden state — not the canary fixture's separate
// engine, which the player/admin surfaces swept here never read.
const sandboxConfessionals = (w: BbWorld) =>
  liveOf(w)!.sb!.engine.events.queryAll().filter((e) => e.type === "confessional");

Given("a started game in which houseguests have confessed", function (this: BbWorld) {
  setLive(this, startLiveSweep({ seed: 3, ticks: 6, user: "pat2-confessed" }));
  assert.ok(sandboxConfessionals(this).length > 0, "the house has confessed");
});

When("any player surface is read", function (this: BbWorld) {
  if (this.blSandbox) {
    // 0043 reuses this phrase over a registry-built sandbox (the live object graph).
    this.lastOutput = JSON.stringify(this.blSandbox.session.getGameState())
      + JSON.stringify(this.blSandbox.session.gameStatus())
      + JSON.stringify(this.blSandbox.player.getVisibleState())
      + JSON.stringify(this.blSandbox.session.getMomentPrompt({}));
    this.lastView = this.blSandbox.player.getVisibleState();
    return;
  }
  const live = liveOf(this)!.sb!;
  this.lastOutput = livePlayerSurfaces(live);
  this.lastView = live.player.getVisibleState();
});

Then("no confessional content appears", function (this: BbWorld) {
  const surface = `${this.lastOutput}\n${JSON.stringify(this.lastView)}`;
  for (const e of sandboxConfessionals(this)) {
    assert.ok(!surface.includes(e.content), "a confessional leaked onto a surface");
  }
});

Then("no confessional witnesses the player", function (this: BbWorld) {
  for (const e of sandboxConfessionals(this)) {
    assert.ok(!e.witnessSet.includes(PLAYER));
  }
});

When("the admin \\/ God-Mode surface is read", function (this: BbWorld) {
  this.lastOutput = liveAdminSurface(liveOf(this)!.sb!);
  this.lastView = this.lastOutput;
});

// --- Scenario: deepen the soul (accumulate + recall) ---------------------------

Given("a houseguest who has confessed across several beats", function (this: BbWorld) {
  this.confSoul = new SoulStore(embed);
  const rel = new RelationshipModel(0.5);
  const rng = new SeededRandom(4);
  // Beat 1: A reads B as the threat.
  for (let i = 0; i < 6; i++) rel.applyDirected(A, B, "betrayal", rng);
  recordConfessionalToSoul(this.confSoul, confessionalFor(A, [A, B, C], rel));
  // Beat 2: A's read shifts toward C.
  for (let i = 0; i < 10; i++) rel.applyDirected(A, C, "betrayal", rng);
  recordConfessionalToSoul(this.confSoul, confessionalFor(A, [A, B, C], rel));
  this.confessor = A;
});

Then("their soul accumulates those confessionals without losing earlier ones", function (this: BbWorld) {
  const mems = this.confSoul!.soulOf(this.confessor!).memories;
  assert.ok(mems.length >= 2, "confessionals accumulate");
  assert.ok(mems.some((m) => m.content.includes(B)), "the earliest confessional (naming B) is retained");
});

Then("a later recall can surface a specific past confessional to keep their voice consistent", function (this: BbWorld) {
  const hits = this.confSoul!.recall(this.confessor!, `who is ${B}`, 3);
  assert.ok(hits.length > 0 && hits.some((m) => m.content.includes(B)), "recall surfaces the B confessional");
});

// --- Scenario: seed-deterministic ----------------------------------------------

Given("two confessing games started from the same seed", function (this: BbWorld) {
  // Same user + same seed in two independent registries — the per-user sandbox is seeded from the
  // user identity, so determinism is asserted for like-for-like games (as the engine guarantees).
  this.confSandboxA = confessingSandbox("det-user", 9, 6);
  this.confSandboxB = confessingSandbox("det-user", 9, 6);
});

When("the same beats are reached in each", function () {
  // Both advanced over the same number of ticks from the same seed in the Given.
});

Then("the same houseguests confess the same grounded reads", function (this: BbWorld) {
  const a = confessionals(this.confSandboxA!).map((e) => e.content).join("|");
  const b = confessionals(this.confSandboxB!).map((e) => e.content).join("|");
  assert.ok(a.length > 0, "the houses confessed");
  assert.equal(a, b);
});

// involvedConfessionals is exercised by the unit tests; reference it so the import stays meaningful.
void involvedConfessionals;
