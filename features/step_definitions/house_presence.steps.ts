import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { HOUSE_SIGHTLINE, areVisible, occupancyViolations } from "../../src/domain/house";
import type { Room, Occupancy } from "../../src/domain/house";
import { rollOverhears } from "../../src/engine/presence";
import { PRESENCE } from "../../src/engine/presenceConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";

// Feature 0049 — house presence & lingering play. HARD rule: roles only — no names.

let hpUsers = 0;
function newPresenceGame(w: BbWorld, seed: number, user = `hp${hpUsers++}`): void {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  w.hpRegistry = reg;
  w.hpUser = user;
  w.hpSandbox = sb;
}

/** The active roster (player + non-evicted NPCs) from the live session core. */
function activeIds(sb: NonNullable<BbWorld["hpSandbox"]>): EntityId[] {
  const core = sb.session.snapshot();
  const evicted = new Set(core.live?.evictionOrder ?? []);
  return [core.house!.player.id, ...core.house!.npcs.map((n) => n.id)].filter((id) => !evicted.has(id));
}

// --- Scenario: Every active houseguest is in exactly one room ----------------------

Given("a started game with a seeded house", function (this: BbWorld) {
  newPresenceGame(this, 31);
});

When("the off-screen life ticks across several days", function (this: BbWorld) {
  const orch = new Orchestrator(this.hpRegistry!, { now: () => 1 }, { seed: 31 });
  this.hpViolations = [];
  let previous: Occupancy | null = null;
  for (let t = 0; t < 12; t++) {
    const res = orch.advance(this.hpUser!, "offscreen-tick");
    assert.equal(res.integrity, "ok");
    const occ = this.hpSandbox!.session.occupancy()!;
    this.hpViolations.push(...occupancyViolations(activeIds(this.hpSandbox!), occ, previous ?? undefined));
    previous = occ;
  }
});

Then("every active houseguest occupies exactly one room at every tick", function (this: BbWorld) {
  assert.deepEqual(this.hpViolations, []);
});

Then("no evicted houseguest occupies any room", function (this: BbWorld) {
  // Drive a full season; after every beat, no one in the eviction order holds a room.
  const s = this.hpSandbox!.session;
  for (let i = 0; i < 600; i++) {
    const v = s.advanceGame();
    if (v.pending) {
      resolvePending(v.pending, (req) => s.submitDecision(req));
    }
    const evicted = new Set(s.snapshot().live?.evictionOrder ?? []);
    const occ = s.occupancy();
    if (occ) for (const id of occ.keys()) assert.ok(!evicted.has(id), "an evicted houseguest still occupied a room");
    if (v.finished) break;
  }
});

// --- Scenario: Movement follows the adjacency map and the seed ---------------------

Given("two games started with the same seed", function (this: BbWorld) {
  // Same seed AND same user: the orchestrator's per-user rng stream is part of the seed.
  newPresenceGame(this, 41, "hp-same-seed");
  this.hpSandboxA = this.hpSandbox;
  this.hpUserA = this.hpUser;
  this.hpRegistryA = this.hpRegistry;
  newPresenceGame(this, 41, "hp-same-seed");
});

When("the off-screen life ticks in both", function (this: BbWorld) {
  const trail = (reg: GameSessionRegistry, user: string, sb: NonNullable<BbWorld["hpSandbox"]>): string[] => {
    const orch = new Orchestrator(reg, { now: () => 1 }, { seed: 41 });
    const out: string[] = [];
    let previous: Occupancy | null = null;
    for (let t = 0; t < 10; t++) {
      orch.advance(user, "offscreen-tick");
      const occ = sb.session.occupancy()!;
      assert.deepEqual(occupancyViolations(activeIds(sb), occ, previous ?? undefined), []);
      previous = occ;
      out.push([...occ.entries()].map(([id, r]) => `${id}@${r}`).sort().join(","));
    }
    return out;
  };
  this.hpTrailA = trail(this.hpRegistryA!, this.hpUserA!, this.hpSandboxA!);
  this.hpTrailB = trail(this.hpRegistry!, this.hpUser!, this.hpSandbox!);
});

Then("every movement in both games is between adjacent rooms", function (this: BbWorld) {
  // Adjacency-only movement was asserted per-tick in the When (occupancyViolations names teleports).
  assert.ok(this.hpTrailA!.length > 0 && this.hpTrailB!.length > 0);
});

Then("both games produce identical occupancy trajectories", function (this: BbWorld) {
  assert.deepEqual(this.hpTrailA, this.hpTrailB);
});

// --- Scenario: Whereabouts shows only what a houseguest could see or hear ----------

Given("the player is in a room with some houseguests and others in adjacent rooms", function (this: BbWorld) {
  newPresenceGame(this, 8);
  // 0111: close the premiere champagne circle so whereabouts reads the seated presence + sightline rooms
  // (this scenario checks room/adjacency fog-of-war, not the opening gathered toast).
  this.hpSandbox!.session.advanceGame();
  // Plant a sentinel into hidden state so the read can be swept.
  this.hpSentinel = "SENTINEL-0049-whereabouts-bdd";
  const core = this.hpSandbox!.session.snapshot();
  core.house!.npcs[0]!.character.hiddenElements.push({ kind: "secret-motive", detail: this.hpSentinel });
  this.hpSandbox!.session.restore(core);
});

When("the player reads their whereabouts", function (this: BbWorld) {
  this.hpWhereabouts = this.hpSandbox!.session.whereabouts()!;
  assert.ok(this.hpWhereabouts, "whereabouts is grounded once a game starts");
});

Then("it lists who is present in the player's room", function (this: BbWorld) {
  const w = this.hpWhereabouts!;
  const occ = this.hpSandbox!.session.occupancy()!;
  const expected = [...occ.entries()].filter(([id, r]) => r === w.room && id !== PLAYER).map(([id]) => id).sort();
  assert.deepEqual(w.present.map((p) => p.id).sort(), expected);
});

Then("it lists who is in adjacent rooms", function (this: BbWorld) {
  const w = this.hpWhereabouts!;
  // 0077 Phase 2: `nearby` lists the rooms the player can SEE INTO (sightline), not every adjacent room.
  assert.deepEqual(w.nearby.map((n) => n.room), [...(HOUSE_SIGHTLINE.get(w.room as Room) ?? [])]);
  const occ = this.hpSandbox!.session.occupancy()!;
  for (const n of w.nearby) {
    const expected = [...occ.entries()].filter(([, r]) => r === n.room).map(([id]) => id).sort();
    assert.deepEqual(n.present.map((p) => p.id).sort(), expected);
  }
});

Then("it reveals nothing about non-adjacent rooms", function (this: BbWorld) {
  const w = this.hpWhereabouts!;
  // 0077 Phase 2: `nearby` is SIGHTLINE-scoped (eyeshot) — every reported room is one the player can
  // actually SEE into; a closed door one room over is never revealed (the stronger privacy claim).
  for (const n of w.nearby) assert.ok(areVisible(w.room as Room, n.room as Room), `${n.room} is in sightline`);
  // L21/L24 + 0077: duration + the tracked layer ride the view; `zone`/`conspicuous` are optional —
  // still no non-adjacent room's occupants appear in the visible (`nearby`) set.
  const required = ["companions", "nearby", "present", "room", "tracked", "turnsHere"];
  const allowed = [...required, "zone", "conspicuous"];
  assert.ok(required.every((k) => k in w), "the view carries the required keys");
  assert.ok(Object.keys(w).every((k) => allowed.includes(k)), "the view carries no unexpected keys");
});

Then("it contains no motive, number, hidden state, or Vault sentinel", function (this: BbWorld) {
  const blob = JSON.stringify(this.hpWhereabouts);
  assert.ok(!blob.includes(this.hpSentinel!), "no Vault sentinel crosses");
  assert.ok(!/trust|threat|affinity|motive|soul|hiddenElement/i.test(blob), "no hidden-layer key crosses");
  for (const ref of [...this.hpWhereabouts!.present, ...this.hpWhereabouts!.nearby.flatMap((n) => n.present)]) {
    assert.deepEqual(Object.keys(ref).sort(), ["id", "name"], "names only — never a number");
  }
});

// --- Scenario: Co-presence makes a witness -----------------------------------------

Given("the player talks with an NPC while another NPC is in the same room", function (this: BbWorld) {
  newPresenceGame(this, 14);
  const occupancy = new Map<EntityId, Room>([
    [PLAYER, "backyard"], [npc(1), "backyard"], [npc(2), "backyard"], [npc(3), "kitchen"],
  ]);
  this.hpSandbox!.commands.setPresenceProvider(() => occupancy);
});

When("the scene is recorded", function (this: BbWorld) {
  const { eventId } = this.hpSandbox!.commands.recordInteraction({
    initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a poolside strategy talk",
  });
  this.hpEventId = eventId;
});

Then("the other NPC is in the event's witness set", function (this: BbWorld) {
  const ev = this.hpSandbox!.engine.events.queryAll().find((e) => e.id === this.hpEventId)!;
  assert.ok(ev.witnessSet.includes(npc(2)), "the co-present NPC witnessed the scene");
});

Then("the event is not secret to any houseguest in the room", function (this: BbWorld) {
  const ev = this.hpSandbox!.engine.events.queryAll().find((e) => e.id === this.hpEventId)!;
  assert.equal(ev.hidden, false, "a player-witnessed scene is never secret (0002)");
});

// --- Scenario: An NPC in the next room can overhear the player ----------------------

Given("the player confides in an NPC while a schemer is in an adjacent room", function (this: BbWorld) {
  newPresenceGame(this, 15);
  const occupancy = new Map<EntityId, Room>([
    [PLAYER, "kitchen"], [npc(1), "kitchen"], [npc(2), "living-room"],
  ]);
  this.hpSandbox!.commands.setPresenceProvider(() => occupancy);
});

When("the adjacency overhear roll succeeds for the schemer", function (this: BbWorld) {
  // The roll is gated — record scenes until one lands within a sane bound.
  for (let i = 0; i < 80; i++) {
    const { eventId } = this.hpSandbox!.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: `the player confides a plan, take ${i}`,
    });
    const hit = this.hpSandbox!.engine.knowledge.knownTo(npc(2)).find((f) => f.pathway === `overheard:${eventId}`);
    if (hit) { this.hpEventId = eventId; this.hpOverheardFact = hit; return; }
  }
  assert.fail("no overhear landed within the bound — the gate is broken or closed");
});

Then("the schemer gains knowledge of the scene via an overheard pathway", function (this: BbWorld) {
  assert.ok(this.hpOverheardFact, "the schemer holds an overheard fact");
  assert.ok(this.hpOverheardFact!.pathway.startsWith("overheard:"));
});

Then("the pathway is traceable to the recorded event", function (this: BbWorld) {
  assert.equal(this.hpOverheardFact!.pathway, `overheard:${this.hpEventId}`);
  assert.ok(this.hpSandbox!.engine.events.queryAll().some((e) => e.id === this.hpEventId), "the overheard event exists");
  assert.ok(this.hpOverheardFact!.sourceEventId, "the surfacing itself was recorded");
});

Then("the schemer's confidence in it is lower than a witness's", function (this: BbWorld) {
  assert.equal(this.hpOverheardFact!.confidence, PRESENCE.overhearConfidence);
  assert.ok(this.hpOverheardFact!.confidence! < 1, "partial confidence — heard through a wall");
});

// --- Scenario: The player can overhear NPCs scheming in the next room ---------------

Given("two NPCs scheme in a room adjacent to the player", function (this: BbWorld) {
  newPresenceGame(this, 16);
});

When("the adjacency overhear roll succeeds for the player", function (this: BbWorld) {
  // Drive off-screen ticks until a hidden NPC scene lands in the player's knowledge by overhear.
  const orch = new Orchestrator(this.hpRegistry!, { now: () => 1 }, { seed: 16 });
  for (let t = 0; t < 120; t++) {
    const res = orch.advance(this.hpUser!, "offscreen-tick");
    assert.equal(res.integrity, "ok");
    const hit = this.hpSandbox!.engine.knowledge
      .knownTo(PLAYER)
      .find((f) => f.pathway.startsWith("overheard:offscreen:"));
    if (hit) { this.hpOverheardFact = hit; return; }
  }
  assert.fail("the player never overheard an off-screen scene within the bound");
});

Then("the player gains knowledge of the scheme via an overheard pathway", function (this: BbWorld) {
  assert.ok(this.hpOverheardFact!.pathway.startsWith("overheard:"));
  assert.ok(this.hpOverheardFact!.content.includes("overheard"), "framed as an overhear, not a witnessed fact");
});

Then("the surfacing is recorded as an explicit propagation event", function (this: BbWorld) {
  const srcId = this.hpOverheardFact!.sourceEventId!;
  const surfacing = this.hpSandbox!.engine.events.queryAll().find((e) => e.id === srcId);
  assert.ok(surfacing, "the surfacing is its own recorded event");
  assert.equal(surfacing!.hidden, false, "the player's own surfacing is player-witnessed");
});

Then("no Vault content beyond the overheard scene itself reaches the player", function (this: BbWorld) {
  // The fragment never carries a hidden event's FULL content, and nothing else hidden crosses.
  const hidden = this.hpSandbox!.engine.events.queryAll().filter((e) => e.hidden).map((e) => e.content);
  for (const f of this.hpSandbox!.engine.knowledge.knownTo(PLAYER)) {
    for (const h of hidden) assert.ok(!f.content.includes(h), "a verbatim hidden content crossed the wall");
  }
});

// --- Scenario: Overhearing is gated, not guaranteed ----------------------------------

Given("many seeded scenes with occupants in adjacent rooms", function (this: BbWorld) {
  newPresenceGame(this, 19);
});

When("the overhear outcomes are sampled across seeds", function (this: BbWorld) {
  const sb = this.hpSandbox!;
  const occupancy = new Map<EntityId, Room>([
    [npc(1), "kitchen"], [npc(2), "kitchen"], [npc(3), "living-room"], [npc(4), "bedroom-a"],
  ]);
  const content = "two houseguests plan the week in the kitchen";
  sb.engine.events.record({
    id: "hp:gate:scene", ts: 5_000_000, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content,
  });
  let heard = 0;
  const samples = 300;
  for (let i = 0; i < samples; i++) {
    const out = rollOverhears({
      eventId: "hp:gate:scene", room: "kitchen", content, participants: [npc(1), npc(2)],
      occupancy, knowledge: sb.engine.knowledge, rng: new SeededRandom(7000 + i),
    });
    assert.ok(!out.includes(npc(4)), "a non-adjacent occupant never overhears");
    if (out.includes(npc(3))) heard++;
  }
  this.hpGateSamples = samples;
  this.hpGateHits = heard;
});

Then("only a bounded fraction of adjacent occupants gain overheard pathways", function (this: BbWorld) {
  assert.ok(this.hpGateHits! > this.hpGateSamples! * 0.02, "the gate opens a real fraction of the time");
  assert.ok(this.hpGateHits! < this.hpGateSamples! * 0.3, "the gate never approaches certainty (rare by design)");
});

Then("an NPC with no presence-derived pathway to a fact still does not know it", function (this: BbWorld) {
  const facts = this.hpSandbox!.engine.knowledge.knownTo(npc(4));
  assert.ok(!facts.some((f) => f.pathway === "overheard:hp:gate:scene"), "no pathway ⇒ no knowledge (0002)");
});

// --- Scenario: Lingering never advances the week -------------------------------------

Given("a started game mid-week with a pending scheduled beat", function (this: BbWorld) {
  newPresenceGame(this, 23);
  this.hpClock = { t: 1000 };
  const clockRef = this.hpClock;
  this.hpOrch = new Orchestrator(this.hpRegistry!, { now: () => clockRef.t }, { seed: 23, turnDriven: true });
  this.hpRegistry!.setCommit((u) => this.hpOrch!.commitPlayerTurn(u));
  const s = this.hpSandbox!.session;
  let pending = s.advanceGame().pending;
  for (let i = 0; i < 300 && !pending; i++) pending = s.advanceGame().pending;
  assert.ok(pending, "the loop reached a pending player decision");
  this.hpBefore = { week: s.gameStatus().week, phase: s.gameStatus().phase, kind: pending!.kind };
  this.hpEventsBefore = this.hpSandbox!.engine.events.query({ hidden: false }).length;
});

When("the player spends many consecutive turns moving rooms, milling, and talking", function (this: BbWorld) {
  const s = this.hpSandbox!.session;
  for (let i = 0; i < 15; i++) {
    this.hpClock!.t += 60_000;
    assert.ok(s.whereabouts(), "milling: the player reads who's around");
    this.hpSandbox!.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: `mill-about chat ${i}`, kind: "bonding",
    });
  }
});

Then("the week, the phase, and the pending ceremony are unchanged", function (this: BbWorld) {
  const s = this.hpSandbox!.session;
  assert.equal(s.gameStatus().week, this.hpBefore!.week);
  assert.equal(s.gameStatus().phase, this.hpBefore!.phase);
  assert.equal(s.advanceGame().pending?.kind, this.hpBefore!.kind);
});

Then("the watcher treats the milling as activity rather than idleness", function (this: BbWorld) {
  // Every mill turn touched the idle clock — the player reads as ACTIVE at the final timestamp,
  // so the watcher's idle gate cannot fast-forward over a lingering player.
  assert.equal(this.hpOrch!.idleSince(this.hpUser!), this.hpClock!.t);
});

Then("the day's meaningful event is still the scheduled beat", function (this: BbWorld) {
  // The mill turns recorded conversations, but the SCHEDULED beat is still what's pending — no
  // mill turn produced a ceremony beat (the daily-event invariant is satisfied by the schedule).
  const s = this.hpSandbox!.session;
  assert.equal(s.advanceGame().pending?.kind, this.hpBefore!.kind, "the pending scheduled beat is unconsumed");
  const visibleNow = this.hpSandbox!.engine.events.query({ hidden: false }).length;
  assert.ok(visibleNow > this.hpEventsBefore!, "milling was recorded (it has consequence) without advancing the week");
});
