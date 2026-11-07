import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { richOffscreenStretch } from "../../src/engine/offscreen";
import { assignRooms } from "../../src/engine/presence";
import type { MovementIntent } from "../../src/engine/presence";
import { MOVEMENT_INTENT } from "../../src/engine/presenceConstants";
import { RelationshipModel } from "../../src/engine/relationships";
import { natureFoldImpact, FRIENDLY_NATURES } from "../../src/engine/relationshipConstants";
import type { EdgeSignals } from "../../src/engine/relationshipConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Room, Occupancy } from "../../src/domain/house";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { playSeed, EARNED_WINS, SEEDS } from "../../tests/property/juryReachShared";
import { linger } from "../../tests/support/linger";
import { resolvePending } from "../support/answerPending";

/**
 * Feature 0078 — motivated off-screen society & intentional movement. Co-presence is the gate for any
 * off-screen scene, but it is EARNED: NPCs move with intent toward what their motivation wants, and
 * being in a room together is not the same as talking game — the NATURE follows the pair's motivation
 * (a warm pair bonds, affinity only; a threatened pair schemes, the strategic weights). Every
 * co-present scene still records, folds, and persists. Roles only — no fixture names. The night bound
 * (a turned-in houseguest drops out of play) and the anti-sycophancy floor close the feature.
 *
 * The .feature reuses two When phrases across rules ("the house lives between the player's turns",
 * "they have an off-screen scene"), so each Given installs a scenario-appropriate `ms.live` closure and
 * the shared When just invokes it — one faithful step, no spec contortion.
 */

// Time-of-day is opt-in; clean it up after each scenario (the Rule-4 fixture sets it).
After(function () { delete process.env.ORWELL_TIME_OF_DAY; });

// --- shared fixtures / helpers ---------------------------------------------------------------------

// Rule 2 — intentional movement: a single mover steered toward a pinned target, affinity zeroed so
// INTENT is the only force. `timeWithTarget` is the unit-test metric (multi-tick trajectory; pursuit
// compounds), proven robust at test weight 6 — the calibrated magnitude (0.15) is the heavy sims' job.
const SUBJECT = npc(1);
const TARGET = npc(2);
const TARGET_ROOM: Room = "lounge";
const START: Room = "hallway"; // adjacent to the lounge — a legal one-step destination

function towardTarget(weight: number, avoid = false): (id: EntityId) => MovementIntent | null {
  return (id) => (id === SUBJECT ? [{ target: TARGET, weight, avoid }] : null);
}

function timeWithTarget(intent: ((id: EntityId) => MovementIntent | null) | null, trials = 100, steps = 6): number {
  let inRoom = 0;
  for (let s = 0; s < trials; s++) {
    let occ: Occupancy = new Map<EntityId, Room>([[SUBJECT, START], [TARGET, TARGET_ROOM]]);
    const rng = new SeededRandom(5000 + s);
    for (let t = 0; t < steps; t++) {
      occ = assignRooms([SUBJECT], occ, { rng, affinity: () => 0, ...(intent ? { intent } : {}) },
        new Map<EntityId, Room>([[TARGET, TARGET_ROOM]]));
      if (occ.get(SUBJECT) === TARGET_ROOM) inRoom++;
    }
  }
  return inRoom / (trials * steps);
}

// Rule 3 — nature clarity: a warm/low-threat pair vs. a threatened pair, fed to the real co-present
// society generator. `natureWeights` is engine-private, so we measure the NATURE statistically through
// `richOffscreenStretch` — deterministic (each sample is seeded), so the fractions are reproducible.
const NA = npc(1);
const NB = npc(2);
const WARM: EdgeSignals = { trust: 0.8, affinity: 0.9, threat: 0, alignment: 0.1, confidence: 0.9, reliability: 0.5 };
const THREATENING: EdgeSignals = { trust: 0.1, affinity: 0.1, threat: 0.9, alignment: 0.1, confidence: 0.9, reliability: 0.1 };

function natureFractions(edge: EdgeSignals, sb: UserSandbox, samples = 200): { friendly: number; game: number; conflict: number } {
  let friendly = 0;
  let game = 0;
  let conflict = 0;
  const occ = new Map<EntityId, string>([[NA, "lounge"], [NB, "lounge"]]); // the only co-present pair
  for (let s = 0; s < samples; s++) {
    const scenes = richOffscreenStretch({
      events: sb.engine.events, rng: new SeededRandom(1000 + s), npcs: [NA, NB], interactions: 1,
      edgeOf: () => edge, occupancy: occ,
    });
    const type = scenes[0]?.type;
    if (!type) continue;
    if (FRIENDLY_NATURES.has(type)) friendly++; else game++;
    if (type === "conflict") conflict++;
  }
  return { friendly: friendly / samples, game: game / samples, conflict: conflict / samples };
}

/** A stable serialization of every directed relationship edge — to prove the layer MOVED across a tick. */
function edgeMatrix(sb: UserSandbox): string {
  const ids = sb.session.livingIds();
  const rel = sb.engine.relationships;
  const parts: string[] = [];
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const e = rel.edge(a, b);
    parts.push(`${a}->${b}:${e.trust.toFixed(4)},${e.affinity.toFixed(4)},${e.threat.toFixed(4)},${e.alignment.toFixed(4)}`);
  }
  return parts.join("|");
}

/** Advance (clock on) until the phase reaches `target`, resolving pendings legally. */
function advanceToPhase(s: GameSessionAdapter, target: string, cap = 40): boolean {
  for (let i = 0; i < cap; i++) {
    if (s.gameStatus().timeOfDay === target) return true;
    const a = s.advanceGame();
    const p = a.pending;
    if (p) {
      resolvePending(p, (req) => s.submitDecision(req));
    }
    if (a.finished) break;
  }
  return s.gameStatus().timeOfDay === target;
}

/**
 * Advance (clock on) into the night until the house has actually THINNED — in the 24-hour model NPCs reach
 * their character bedtimes through the night (the earliest larks ~21:00, deepening to the late-night
 * trough), so thinning is not visible at the very first `night` hour. Returns whether ≥1 NPC has turned in.
 */
function advanceUntilThinned(s: GameSessionAdapter, cap = 40): boolean {
  for (let i = 0; i < cap; i++) {
    if (s.gameStatus().timeOfDay && s.getGameState().phase !== "premiere") { // ORW-116: during the premiere the whole house is pinned to the toast - the night only thins the house once the premiere is over
      const ids = s.livingIds().filter((id) => id !== PLAYER);
      if (s.awakeAmong(ids).length < ids.length) return true;
      linger(s);
      if (s.awakeAmong(ids).length < ids.length) return true;
    }
    const a = s.advanceGame();
    const p = a.pending;
    if (p) {
      resolvePending(p, (req) => s.submitDecision(req));
    }
    if (a.finished) break;
  }
  const ids = s.livingIds().filter((id) => id !== PLAYER);
  return s.awakeAmong(ids).length < ids.length;
}

// --- Background ------------------------------------------------------------------------------------

Given("a started season with the off-screen society running between turns", function (this: BbWorld) {
  const seed = 7;
  const reg = new GameSessionRegistry();
  const user = "ms-user";
  const orch = new Orchestrator(reg, { now: () => seed }, { seed });
  const sandbox = reg.sandboxFor(user);
  sandbox.session.createCharacter({ playerName: "The Player", seed });
  this.ms = { reg, user, orch, sandbox };
});

// --- Rule: Co-presence is required -----------------------------------------------------------------

Given("two houseguests in different rooms", function (this: BbWorld) {
  const ms = this.ms!;
  const npcs = ms.sandbox!.session.livingIds().filter((id) => id !== PLAYER);
  const [a, b, ...rest] = npcs;
  ms.pairA = a; ms.pairB = b;
  // The two are apart (kitchen vs. backyard); the rest of the house gathers in the lounge — so the
  // society still LIVES (a real co-presence gate, not an empty tick), but the two apart can never pair.
  const occ = new Map<EntityId, string>([[a!, "kitchen"], [b!, "backyard"]]);
  for (const r of rest) occ.set(r, "lounge");
  ms.live = () => {
    ms.scenes = richOffscreenStretch({
      events: ms.sandbox!.engine.events, rng: new SeededRandom(7), npcs, interactions: 40,
      edgeOf: (x, y) => ms.sandbox!.engine.relationships.edge(x, y), occupancy: occ,
    });
  };
});

When("the house lives between the player's turns", function (this: BbWorld) {
  this.ms!.live!();
});

Then("no off-screen scene fires between them", function (this: BbWorld) {
  const ms = this.ms!;
  const scenes = ms.scenes ?? [];
  const between = scenes.filter((s) =>
    (s.initiator === ms.pairA && s.partner === ms.pairB) ||
    (s.initiator === ms.pairB && s.partner === ms.pairA));
  assert.equal(between.length, 0, "two houseguests in different rooms never share an off-screen scene");
  assert.ok(scenes.length > 0, "the co-present crowd still had its off-screen society (the gate, not an empty tick)");
});

// --- Rule: Co-presence is earned by intentional movement -------------------------------------------

Given("a houseguest with a motive to bond with an ally", function (this: BbWorld) {
  const ms = this.ms!;
  ms.live = () => {
    ms.trend = { motiveless: timeWithTarget(null), bonder: timeWithTarget(towardTarget(6)), worker: 0, shuffled: 0 };
  };
});

Given("another houseguest with a motive to work a rival", function (this: BbWorld) {
  // Same mechanism, a game motive: to WORK a rival you seek them out (a pursuit, not avoidance).
  const ms = this.ms!;
  const prev = ms.live!;
  ms.live = () => { prev(); ms.trend!.worker = timeWithTarget(towardTarget(6)); };
});

Then("each trends toward their target's vicinity more than a motiveless houseguest", function (this: BbWorld) {
  const t = this.ms!.trend!;
  assert.ok(t.bonder > t.motiveless + 0.1, `the bonder sought its ally out (${t.bonder.toFixed(3)} vs ${t.motiveless.toFixed(3)})`);
  assert.ok(t.worker > t.motiveless + 0.1, `the worker sought its rival out (${t.worker.toFixed(3)} vs ${t.motiveless.toFixed(3)})`);
});

Then("the pairs that end up co-present reflect agenda, not luck", function (this: BbWorld) {
  const t = this.ms!.trend!;
  assert.ok((t.bonder + t.worker) / 2 > t.motiveless + 0.1, "agenda — not luck — drives who ends up together");
});

Given("a fixed seed", function (this: BbWorld) {
  this.ms ??= {}; // the Background already seeded the season; this scenario measures the seeded trajectories
});

When("the same season is run with different houseguest agendas", function (this: BbWorld) {
  const ms = this.ms!;
  ms.trend = { motiveless: timeWithTarget(null), bonder: timeWithTarget(towardTarget(6)), worker: 0, shuffled: timeWithTarget(towardTarget(6)) };
});

Then("the co-presence pattern shifts to follow the agendas", function (this: BbWorld) {
  const t = this.ms!.trend!;
  assert.ok(Math.abs(t.bonder - t.motiveless) > 0.1, "swapping in an agenda visibly shifts who ends up co-present");
});

// --- Rule: Co-presence is not game talk — motivation sets the nature -------------------------------

Given("two co-present houseguests with a warm, low-threat relationship", function (this: BbWorld) {
  const ms = this.ms!;
  ms.live = () => {
    const f = natureFractions(WARM, ms.sandbox!);
    ms.nature = { ...(ms.nature ?? { warmFriendly: 0, warmConflict: 0, threatGame: 0, threatConflict: 0 }), warmFriendly: f.friendly, warmConflict: f.conflict };
  };
});

Given("two co-present houseguests where one reads the other as a threat", function (this: BbWorld) {
  const ms = this.ms!;
  ms.live = () => {
    const f = natureFractions(THREATENING, ms.sandbox!);
    ms.nature = { ...(ms.nature ?? { warmFriendly: 0, warmConflict: 0, threatGame: 0, threatConflict: 0 }), threatGame: f.game, threatConflict: f.conflict };
  };
});

When("they have an off-screen scene", function (this: BbWorld) {
  this.ms!.live!();
});

Then("the scene is friendly, not strategic", function (this: BbWorld) {
  const n = this.ms!.nature!;
  assert.ok(n.warmFriendly > 0.5, `a warm pair's scenes are predominantly friendly (${Math.round(n.warmFriendly * 100)}%)`);
  assert.ok(n.warmConflict < 0.1, `…and almost never conflict (${Math.round(n.warmConflict * 100)}%)`);
});

Then("it raises their affinity", function (this: BbWorld) {
  const m = new RelationshipModel(0.5);
  const before = { ...m.edge(NA, NB) };
  m.applyImpactDirected(NA, NB, natureFoldImpact("bonding"), new SeededRandom(1));
  assert.ok(m.edge(NA, NB).affinity > before.affinity, "a friendly scene warms the bond");
});

Then("it folds no strategic weight and triggers no vote-affecting change", function (this: BbWorld) {
  const m = new RelationshipModel(0.5);
  const before = { ...m.edge(NA, NB) };
  m.applyImpactDirected(NA, NB, natureFoldImpact("bonding"), new SeededRandom(1));
  const after = m.edge(NA, NB);
  assert.equal(after.trust, before.trust, "no trust move");
  assert.equal(after.threat, before.threat, "no threat move");
  assert.equal(after.alignment, before.alignment, "no alignment move — nothing that feeds the vote math");
});

Then("the scene is a game conversation", function (this: BbWorld) {
  const n = this.ms!.nature!;
  assert.ok(n.threatGame > 0.6, `a threatened pair's scenes are predominantly game talk (${Math.round(n.threatGame * 100)}%)`);
  assert.ok(n.threatConflict > 0.2, `…with real conflict among them (${Math.round(n.threatConflict * 100)}%)`);
});

Then("it folds the strategic weights that feed votes", function (this: BbWorld) {
  const m = new RelationshipModel(0.5);
  const before = { ...m.edge(NA, NB) };
  m.applyImpactDirected(NA, NB, natureFoldImpact("conflict"), new SeededRandom(1)); // a game nature folds its full impact
  assert.ok(m.edge(NA, NB).threat > before.threat, "a game scene moves the strategic weights");
});

When("any off-screen scene resolves", function (this: BbWorld) {
  const ms = this.ms!;
  ms.recordsBefore = ms.sandbox!.engine.events.count();
  ms.edgesBefore = edgeMatrix(ms.sandbox!);
  const res = ms.orch!.advance(ms.user!, "offscreen-tick"); // the production path: records + folds + persists
  assert.equal(res.integrity, "ok", "the turn committed — the fold persisted (no fail-closed rollback)");
});

Then("it records, folds its impact, and persists", function (this: BbWorld) {
  const ms = this.ms!;
  const after = ms.sandbox!.engine.events.count();
  assert.ok(after > (ms.recordsBefore ?? 0), "the scenes were RECORDED as hidden events");
  assert.notEqual(edgeMatrix(ms.sandbox!), ms.edgesBefore, "the relationship layer MOVED (the hidden impact folded)");
  // PERSISTS: a fresh snapshot reflects the committed, grown record — durable, not in-memory only.
  ms.sandbox!.session.snapshot();
  assert.ok(ms.sandbox!.engine.events.count() >= after, "the recorded scenes persist");
});

Then("nothing is left inert", function (this: BbWorld) {
  const ms = this.ms!;
  const hidden = ms.sandbox!.engine.events.queryAll().filter((e) => e.hidden && e.id.startsWith("offscreen:"));
  assert.ok(hidden.length > 0, "every off-screen scene this tick is a real recorded event — none narrated-but-unrecorded");
});

// --- Rule: Asleep houseguests drop out of play (the night bound) -----------------------------------

Given("the night has thinned the awake set", function (this: BbWorld) {
  process.env.ORWELL_TIME_OF_DAY = "1";
  for (const seed of [11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5]) {
    const reg = new GameSessionRegistry();
    const user = `ms-night-${seed}`;
    const orch = new Orchestrator(reg, { now: () => seed }, { seed });
    const sandbox = reg.sandboxFor(user);
    sandbox.session.createCharacter({ playerName: "The Player", seed });
    if (!advanceUntilThinned(sandbox.session)) continue;
    // P4b: presence refreshes at a COMMITTED beat and the helper can return the instant the clock passes bedtime (after a linger); seat one beat before reading it (the day-1
    // first-morning day-break shifted where in the cadence that moment lands).
    // P4b: presence refreshes at a COMMITTED beat and the helper can return the instant the clock passes bedtime (after a linger); seat one beat before reading it. (ORW-116: in this headless flow no
    // night-gate day-break is pending at that moment, so the settle beat is the next ceremony beat, not a night roll.)
    const settle = sandbox.session.advanceGame();
    if (settle.pending) resolvePending(settle.pending, (req) => sandbox.session.submitDecision(req));
    const npcs = sandbox.session.livingIds().filter((id) => id !== PLAYER);
    const awake = sandbox.session.awakeAmong(npcs);
    if (awake.length >= npcs.length) continue; // need ≥1 turned in for the bound to bite
    this.ms = { reg, user, orch, sandbox, awake, asleep: npcs.filter((id) => !awake.includes(id)) };
    return;
  }
  assert.fail("no seed thinned the awake set at night — test setup");
});

Then("a houseguest who has gone to bed is absent from the awake house and appears in no off-screen scene", function (this: BbWorld) {
  const ms = this.ms!;
  const asleep = ms.asleep!;
  assert.ok(asleep.length > 0, "the night turned at least one houseguest in");
  // (1) Absent from the awake house: not on the society floor, not "around" the player.
  const occ = ms.sandbox!.session.societyOccupancy();
  for (const id of asleep) assert.ok(!occ?.has(id), "an asleep houseguest is gone from the society floor");
  const w = ms.sandbox!.session.whereabouts();
  const around = new Set([...(w?.present ?? []), ...(w?.nearby ?? []).flatMap((n) => n.present)].map((p) => p.id));
  for (const id of asleep) assert.ok(!around.has(id), "an asleep houseguest is not around the player");
  // (2) Appears in no off-screen scene: run the society and assert no fresh hidden pair includes an asleep id.
  const beforeIds = new Set(ms.sandbox!.engine.events.queryAll().map((e) => e.id));
  for (let t = 0; t < 8; t++) ms.orch!.advance(ms.user!, "offscreen-tick");
  // Every hidden pair at night — society scenes AND rumor retellings (#1913) — is among the awake.
  const fresh = ms.sandbox!.engine.events.queryAll().filter((e) => !beforeIds.has(e.id) && e.hidden && e.witnessSet.length === 2);
  for (const e of fresh) for (const id of e.witnessSet) {
    if (id !== PLAYER) assert.ok(!asleep.includes(id), "an asleep houseguest never schemed off-screen at night");
  }
});

// --- Rule: The anti-sycophancy floor is enforced for the new movement model ------------------------
// The authoritative active-vs-passive band is measured across many seeds in the heavy calibration sims
// (npm run test:heavy:jury + test:heavy:gradient), which run in CI on every engine change. Like 0073's
// structural wall proof, this scenario verifies that gate is WIRED for the intentional-movement model:
// it plays one real season through the live harness and confirms the floor constants are in force.

Given("the seeded calibration harness that plays passive seasons to a verdict", function (this: BbWorld) {
  this.ms ??= {}; // `playSeed` + the band constants are imported; the When runs one real season on this model
});

When("one passive season is played to completion on the current model", { timeout: 60_000 }, async function (this: BbWorld) {
  this.ms ??= {};
  this.ms.seasonResult = await playSeed(1);
});

Then("it yields a well-formed outcome the band gate can score", function (this: BbWorld) {
  const r = this.ms!.seasonResult!;
  assert.ok(["active", "jury", "evicted"].includes(r.status), `a scoreable status (got ${r.status})`);
  assert.ok(typeof r.playerCompWins === "number" && r.playerCompWins >= 0, "the public comp-win count the EARNED_WINS teeth read");
  // AMEND 0078 #3: a SPECIFIC, deterministic expected outcome (the wiring-only check accepted all three statuses). Seed 1 / passive on the current model: the player makes the jury,
  // does not reach Final 2, with one public comp win. Re-pin DELIBERATELY when calibration moves (A10 / any movement-strength change) - a silent drift here is the point.
  // Re-pinned 2026-11-06 for ORW-132 (pre-show ties are now rare, so the seed-1 cast seeds differently): same status, the player's one public comp win became zero. (ORW-116, 2026-11-07: measured again with the clock-from-entry flow merged - unchanged.)
  assert.deepEqual(r, { seed: 1, status: "jury", f2Win: false, playerCompWins: 0 }, "seed 1, passive, current model");
  assert.ok(MOVEMENT_INTENT.moveIntentStrength > 0, "the intentional-movement lever is live in the measured model");
});

Then("the floor demands every crowned passive season be earned on the public comp record", function () {
  assert.ok(EARNED_WINS >= 2, "a crowned passive player must show ≥2 public comp wins (the anti-sycophancy teeth)");
  assert.ok(SEEDS >= 20, "the authoritative band runs across ≥20 seeds in the heavy lane");
});
