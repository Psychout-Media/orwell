import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { confessionalFor, isBareGame } from "../../src/engine/confessionals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import type { UserSandbox } from "../../src/composition/registry";
import { resolvePending } from "../support/answerPending";

// HARD rule: roles only — NPC, HOH, nominee, ally. No names.
const A = npc(1);
const B = npc(2);
const C = npc(3);
const D = npc(4);
const seededRng = (): SeededRandom => new SeededRandom(42);

function confessionalEvents(sb: UserSandbox) {
  return sb.engine.events.queryAll().filter((e) => e.type === "confessional");
}

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

/** A production-shaped live season with the in-game clock + depth flag configured. */
function liveHouse(seed: number, user: string, depthOn: boolean): UserSandbox {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "P", seed });
  sb.session.setPerConversationClockEnabled(true);
  sb.session.setConfessionalDepthEnabled(depthOn);
  const orch = new Orchestrator(reg, new FakeClock(), { seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  // Drive the season a while so relationships develop (ceremonies fold + the off-screen society runs).
  for (let i = 0; i < 90; i++) {
    if (sb.session.snapshot().live?.hoh === undefined) {
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
      if (a.finished) break;
    } else {
      const n = sb.session.livingIds().find((id) => id !== PLAYER)!;
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, n], content: `talk ${i}` });
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
      if (a.finished) break;
      if (i > 40) break;
    }
  }
  return sb;
}

// ── Scenario: most houseguests confess each in-game day ───────────────────────────────────────────
Given("a started game with the daily-confessional depth on and the in-game clock live", function (this: BbWorld) {
  this.ddcSandbox = liveHouse(7, "ddc-most", true);
  assert.equal(this.ddcSandbox.session.perConversationClockLive(), true, "the in-game clock is live");
  this.ddcLivingNpcs = this.ddcSandbox.session.livingIds().filter((id) => id !== PLAYER).length;
  this.ddcSweptBefore = confessionalEvents(this.ddcSandbox).length;
});

When("an in-game day passes", function (this: BbWorld) {
  this.ddcSandbox!.session.turnIn(); // the player's bedtime closes the day → the sweep fires
});

Then("most of the living houseguests recorded a confessional that day", function (this: BbWorld) {
  const swept = confessionalEvents(this.ddcSandbox!).slice(this.ddcSweptBefore!);
  assert.ok(
    swept.length >= Math.ceil(this.ddcLivingNpcs! / 2),
    `only ${swept.length} of ${this.ddcLivingNpcs} confessed`,
  );
  // Vault-only: each is witnessed by the confessing NPC alone (the player is never a witness).
  for (const e of swept) {
    assert.equal(e.hidden, true);
    assert.deepEqual(e.witnessSet, [e.initiator]);
    assert.ok(!e.witnessSet.includes(PLAYER));
  }
});

// ── Scenario: a bare game stays quiet ─────────────────────────────────────────────────────────────
Given("a confessing houseguest with no recent meaningful events and no clear target or ally", function (this: BbWorld) {
  this.confRel = new RelationshipModel(0.5); // fresh baseline edges — no clear read
  this.confessor = A;
});

When("the daily confessional sweep considers them", function (this: BbWorld) {
  // The sweep's gate: a houseguest with no clear target/ally AND no salient recent beat is bare.
  this.ddcBareIsSkipped = isBareGame(this.confessor!, [A, B, C], this.confRel!, false);
});

Then("that houseguest is skipped and records no confessional that day", function (this: BbWorld) {
  assert.equal(this.ddcBareIsSkipped, true);
});

// ── Scenario: plan grounded in the target ─────────────────────────────────────────────────────────
Given("a confessing houseguest who reads one peer as their clear top threat", function (this: BbWorld) {
  const rel = new RelationshipModel(0.5);
  rel.edge(A, B).threat = 0.9; // B is the clear top threat → A's target
  this.confRel = rel;
  this.confessor = A;
});

When("that houseguest records a deep confessional as the Head of Household", function (this: BbWorld) {
  this.ddcDepth = { role: "hoh" };
  this.confessional = confessionalFor(this.confessor!, [A, B, C], this.confRel!, { rng: seededRng(), depth: this.ddcDepth });
});

Then("the deep confessional states the move they intend against that threat", function (this: BbWorld) {
  assert.ok(this.confessional!.plan, "an HOH voices a plan");
  assert.ok(this.confessional!.plan!.includes(B));
});

Then("the plan is grounded in their real target", function (this: BbWorld) {
  assert.equal(this.confessional!.target, B); // the plan's named threat IS the engine-computed target
});

// ── Scenario: standing (safe vs exposed) ──────────────────────────────────────────────────────────
Given("a confessing houseguest who is on the block", function (this: BbWorld) {
  this.confRel = new RelationshipModel(0.5);
  this.confessor = A;
});

When("that nominee records a deep confessional", function (this: BbWorld) {
  this.confessional = confessionalFor(this.confessor!, [A, B, C], this.confRel!, { rng: seededRng(), depth: { role: "nominee" } });
});

Then("the deep confessional reads as exposed", function (this: BbWorld) {
  assert.equal(this.confessional!.standing, "exposed");
});

Then("a power-holder's deep confessional reads as safe instead", function (this: BbWorld) {
  const asHoh = confessionalFor(this.confessor!, [A, B, C], this.confRel!, { rng: seededRng(), depth: { role: "hoh" } });
  assert.equal(asHoh.standing, "safe");
});

// ── Scenario: grudge distinct from target ─────────────────────────────────────────────────────────
Given("a confessing houseguest betrayed by one peer but targeting another", function (this: BbWorld) {
  const rel = new RelationshipModel(0.5);
  rel.edge(A, C).threat = 0.9; // C is the top threat → A's target
  rel.edge(A, B).trust = 0.05; // B burned A → the grudge (distinct from the target)
  this.confRel = rel;
  this.confessor = A;
});

When("that betrayed houseguest records a deep confessional", function (this: BbWorld) {
  this.confessional = confessionalFor(this.confessor!, [A, B, C], this.confRel!, { rng: seededRng(), depth: { role: "none" } });
});

Then("the deep confessional names the betrayer as a grudge", function (this: BbWorld) {
  assert.equal(this.confessional!.grudge, B);
});

Then("it names the other peer as their current target", function (this: BbWorld) {
  assert.equal(this.confessional!.target, C);
});

Then("the grudge and the target are two different reads", function (this: BbWorld) {
  assert.notEqual(this.confessional!.grudge, this.confessional!.target);
});

// ── Scenario: big-conversation aftermath ──────────────────────────────────────────────────────────
Given("a confessing houseguest who just had a significant conversation with an ally", function (this: BbWorld) {
  const rel = new RelationshipModel(0.5);
  rel.edge(A, D).trust = 0.8; // a real bond with D (the ally they spoke with)
  rel.edge(A, D).affinity = 0.8;
  this.confRel = rel;
  this.confessor = A;
});

When("that houseguest records a deep confessional after the talk", function (this: BbWorld) {
  this.confessional = confessionalFor(this.confessor!, [A, B, C, D], this.confRel!, { rng: seededRng(), depth: { role: "none", recentTalk: D } });
});

Then("the deep confessional reflects how that conversation sat with them", function (this: BbWorld) {
  assert.equal(this.confessional!.aftermath, D);
  assert.ok(this.confessional!.content.includes(D));
});

// ── Scenario: adjacent move ───────────────────────────────────────────────────────────────────────
Given("a confessing houseguest whose ally just won power on the public board", function (this: BbWorld) {
  this.confRel = new RelationshipModel(0.5);
  this.confessor = A;
  this.ddcDepth = { role: "none", adjacent: { relation: D, bond: "ally", beat: "won-power" } };
});

When("that houseguest records a deep confessional about the board", function (this: BbWorld) {
  this.confessional = confessionalFor(this.confessor!, [A, B, C, D], this.confRel!, { rng: seededRng(), depth: this.ddcDepth });
});

Then("the deep confessional reacts to that beat through their bond with the ally", function (this: BbWorld) {
  assert.deepEqual(this.confessional!.adjacent, { relation: D, bond: "ally", beat: "won-power" });
  assert.ok(this.confessional!.content.includes(D));
});

// ── Scenario: Vault-sealed + calibration-neutral ──────────────────────────────────────────────────
Given("a started game whose houseguests have swept deep confessionals", function (this: BbWorld) {
  const sb = liveHouse(7, "ddc-vault", true);
  sb.session.turnIn(); // fire the sweep
  assert.ok(confessionalEvents(sb).length > 0, "the house swept confessionals");
  this.ddcSandbox = sb;
});

When("the player surface and the admin surface are both read for confessionals", function (this: BbWorld) {
  const sb = this.ddcSandbox!;
  sb.syncAdmin();
  this.lastOutput = JSON.stringify(sb.session.getGameState())
    + JSON.stringify(sb.session.gameStatus())
    + JSON.stringify(sb.player.getVisibleState())
    + JSON.stringify(sb.session.getMomentPrompt({}))
    + JSON.stringify(sb.admin.inspect());
});

Then("no deep confessional content appears on either", function (this: BbWorld) {
  const surface = this.lastOutput!;
  for (const e of confessionalEvents(this.ddcSandbox!)) {
    assert.ok(!surface.includes(e.content), "a confessional leaked onto a player/admin surface");
  }
  // Structural: no confessional ever witnessed the player.
  for (const e of confessionalEvents(this.ddcSandbox!)) assert.ok(!e.witnessSet.includes(PLAYER));
});

Then("with the depth layer off the day-close sweep does not fire", function (this: BbWorld) {
  const off = liveHouse(7, "ddc-off", false);
  const before = confessionalEvents(off).length;
  off.session.turnIn();
  const delta = confessionalEvents(off).length - before;
  const living = off.session.livingIds().filter((id) => id !== PLAYER).length;
  assert.ok(delta < Math.ceil(living / 2), `flag off must not run the majority sweep (delta ${delta})`);
});

Then("the same seed reproduces the same swept confessionals", function (this: BbWorld) {
  const a = liveHouse(7, "ddc-det", true);
  a.session.turnIn();
  // The WHOLE swept sequence (not just the final turnIn's slice): with the co-presence layer ON the day-close sweeps already fired while the season was driven, so the closing turnIn can land on an
  // already-swept in-game day and add none (62 confessionals existed beforehand) - the determinism claim is about the full recorded sequence.
  const seqA = confessionalEvents(a).map((e) => e.content).join("|");

  const b = liveHouse(7, "ddc-det", true);
  b.session.turnIn();
  const seqB = confessionalEvents(b).map((e) => e.content).join("|");

  assert.ok(seqA.length > 0);
  assert.equal(seqA, seqB);
});
