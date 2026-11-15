import { Given, When, Then } from "@cucumber/cucumber";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { buildSandbox } from "../../tests/support/sandbox";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import { richOffscreenStretch } from "../../src/engine/offscreen";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";
import {
  deriveTrajectory, STEADY, type FoldSignal, type Trajectory,
} from "../../src/engine/trajectory";
import { TRAJECTORY_CONSTANTS as TC } from "../../src/engine/trajectoryConstants";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import type { InteractionType } from "../../src/engine/relationships";
import { npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0087 — relationship trajectories. Role-only (an NPC, another NPC, a third NPC, the player).
 * Drives the REAL GameSessionAdapter trajectory layer (enabled per-session) for the live wiring, the
 * PURE `deriveTrajectory`/`tiltNatureWeights` for the derivation scenarios, and a RECORDING rng for the
 * calibration-neutrality draw-stream scenarios. Mirrors the 0085/0086 step style.
 */

interface TWorld {
  twSession?: GameSessionAdapter;
  twRel?: RelationshipModel;
  twIds?: EntityId[];
  twA?: EntityId;
  twB?: EntityId;
  twTraj?: Trajectory;
  twTrajMixed?: Trajectory;
  twNatures?: { off: string[]; on: string[] };
  twDraws?: { off: number[]; on: number[] };
  twProjOn?: string;
  twProjOff?: string;
  twSnap?: ReturnType<GameSessionAdapter["snapshot"]>;
  twBetrayals?: number;
  twOffArc?: number;
  twOnArc?: number;
}
const tw = (w: BbWorld): TWorld => w as unknown as TWorld;
const trajWired = (s: GameSessionAdapter): {
  trajectories: Map<string, Trajectory>;
  recordTrajectoryFold: (a: EntityId, b: EntityId, type: string) => void;
} => s as unknown as { trajectories: Map<string, Trajectory>; recordTrajectoryFold: (a: EntityId, b: EntityId, type: string) => void };

const NPCS: EntityId[] = [npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)];

/** The Vault-free fold signal a scene's nature maps to (the SAME bond/threat magnitudes the fold applies). */
function signal(type: InteractionType): FoldSignal {
  const imp = RELATIONSHIP_CONSTANTS.IMPACT[type];
  return { bondDelta: ((imp.affinity ?? 0) + (imp.trust ?? 0)) / 2, threatDelta: imp.threat ?? 0, betrayal: type === "betrayal" };
}

/** A recording rng — captures every `next()` so the shared draw stream can be compared. */
class RecordingRandom implements RandomnessSource {
  readonly draws: number[] = [];
  constructor(private readonly inner: RandomnessSource) {}
  next(): number { const v = this.inner.next(); this.draws.push(v); return v; }
  int(m: number): number { if (m <= 0) return 0; return Math.floor(this.next() * m); }
  pick<T>(items: readonly T[]): T { if (!items.length) throw new Error("empty"); return items[this.int(items.length)]!; }
  fork(label: string): RandomnessSource { return this.inner.fork(label); }
}

function liveTrajectoryHouse(seed: number): { session: GameSessionAdapter; rel: RelationshipModel; ids: EntityId[] } {
  const rel = new RelationshipModel(0.5);
  const session = new GameSessionAdapter(rel);
  session.createCharacter({ playerName: "The Player", seed });
  session.setTrajectoriesEnabled(true);
  const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
  return { session, rel, ids };
}

/** A motivated, co-present house with spread edges, plus a fixed `trajectoryOf` provider on a recording rng. */
function stretchNatures(seed: number, trajectoryOf?: (a: EntityId, b: EntityId) => Trajectory): { draws: number[]; natures: string[] } {
  const r = new SeededRandom(7);
  const rel = new RelationshipModel(0.5);
  for (const a of NPCS) for (const b of NPCS) {
    if (a === b) continue;
    const e = rel.edge(a, b); e.affinity = r.next(); e.trust = r.next(); e.threat = r.next(); e.alignment = r.next();
  }
  const rng = new RecordingRandom(new SeededRandom(seed));
  const scenes = richOffscreenStretch({
    events: new InMemoryEventStore(), rng, npcs: NPCS, interactions: 8,
    edgeOf: (a, b) => rel.edge(a, b),
    ...(trajectoryOf ? { trajectoryOf } : {}),
  });
  return { draws: rng.draws, natures: scenes.map((s) => `${s.initiator}|${s.partner}|${s.type}`) };
}

// === Background =========================================================================================

Given("a started season with the live off-screen society enabled", function (this: BbWorld) {
  const { session, rel, ids } = liveTrajectoryHouse(2026);
  tw(this).twSession = session; tw(this).twRel = rel; tw(this).twIds = ids;
});

// === Rule: a relationship has momentum, and momentum biases the arc ======================================

Given("an NPC and another NPC with a string of recent bonding scenes between them", function (this: BbWorld) {
  tw(this).twTraj = deriveTrajectory(Array.from({ length: TC.recencyWindow }, () => signal("bonding")), undefined);
  tw(this).twTrajMixed = deriveTrajectory([signal("bonding"), signal("conflict"), signal("bonding"), signal("conflict")], undefined);
});

When("their relationship trajectory is derived", function () { /* derived in the Given above */ });

Then("the trajectory phase is warming", function (this: BbWorld) {
  assert.equal(tw(this).twTraj!.phase, "warming");
});

Then("the momentum is greater than for a pair with mixed, contradictory scenes", function (this: BbWorld) {
  assert.ok(tw(this).twTraj!.momentum > tw(this).twTrajMixed!.momentum,
    `consistent (${tw(this).twTraj!.momentum}) > mixed (${tw(this).twTrajMixed!.momentum})`);
});

Given("an NPC and another NPC who were close and then fell into souring scenes", function (this: BbWorld) {
  const { twSession: s, twRel: rel, twIds: ids } = tw(this);
  tw(this).twA = ids![0]; tw(this).twB = ids![1];
  // They were close, then a run of clashes folds in — the arc curdles.
  rel!.edge(ids![0]!, ids![1]!).affinity = 0.7; rel!.edge(ids![0]!, ids![1]!).trust = 0.7;
  rel!.edge(ids![0]!, ids![1]!).threat = 0.7;
  for (let k = 0; k < TC.recencyWindow; k++) trajWired(s!).recordTrajectoryFold(ids![0]!, ids![1]!, "conflict");
  assert.equal(s!.trajectoryOf(ids![0]!, ids![1]!).phase, "souring");
});

When("the off-screen society runs over several in-game days", function (this: BbWorld) {
  // Measure the nature distribution between the curdling pair WITH their souring momentum vs the baseline
  // (no momentum), over a seeded batch — the live society's tilt makes conflict more likely as it cools.
  const { twSession: s, twA: a, twB: b } = tw(this);
  const souring = s!.trajectoryOf(a!, b!);
  let onConflict = 0, offConflict = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const base = richOffscreenStretch({
      events: new InMemoryEventStore(), rng: new SeededRandom(seed), npcs: [a!, b!], interactions: 4,
      edgeOf: () => ({ affinity: 0.3, trust: 0.3, threat: 0.5, alignment: 0.2, confidence: 0.5, reliability: 0.3 }),
    });
    const tilted = richOffscreenStretch({
      events: new InMemoryEventStore(), rng: new SeededRandom(seed), npcs: [a!, b!], interactions: 4,
      edgeOf: () => ({ affinity: 0.3, trust: 0.3, threat: 0.5, alignment: 0.2, confidence: 0.5, reliability: 0.3 }),
      trajectoryOf: () => souring,
    });
    offConflict += base.filter((x) => x.type === "conflict").length;
    onConflict += tilted.filter((x) => x.type === "conflict").length;
  }
  tw(this).twOnArc = onConflict; tw(this).twOffArc = offConflict;
});

Then("the distribution of scene natures between them tilts toward conflict as the arc continues", function (this: BbWorld) {
  assert.ok(tw(this).twOnArc! > tw(this).twOffArc!,
    `souring momentum raises conflict (${tw(this).twOnArc} > ${tw(this).twOffArc})`);
});

Then("the pair does not whiplash back to bonding the next tick", function (this: BbWorld) {
  // The arc is sticky: the souring phase holds (momentum is high), so a single bonding scene does not flip it.
  const { twSession: s, twA: a, twB: b } = tw(this);
  trajWired(s!).recordTrajectoryFold(a!, b!, "bonding"); // one contradicting scene…
  assert.notEqual(s!.trajectoryOf(a!, b!).phase, "warming", "one off-arc scene doesn't flip a committed curdle");
});

Then("the player only learns of the cooling through overheard or relayed clash scenes", function (this: BbWorld) {
  // Structural: the momentum itself is hidden; nothing the player can read carries it (the dedicated
  // Vault-wall scenario proves the byte-identity). Here we assert the arc is hidden engine state only.
  const { twSession: s, twA: a, twB: b } = tw(this);
  assert.ok(s!.trajectoryOf(a!, b!).momentum > 0, "the momentum is real, hidden engine state");
  const blob = JSON.stringify([s!.gameStatus(), s!.whereabouts(), s!.getGameState()]);
  assert.ok(!/"momentum"\s*:/.test(blob), "no momentum value on any player-readable surface");
});

Given("an NPC who has just been betrayed off-screen by another NPC", function (this: BbWorld) {
  tw(this).twTraj = deriveTrajectory([signal("betrayal")], undefined);
});

When("the trajectory is derived from the recent fold", function () { /* derived above */ });

Then("the phase is souring", function (this: BbWorld) {
  assert.equal(tw(this).twTraj!.phase, "souring");
});

Then("the momentum is high", function (this: BbWorld) {
  assert.ok(tw(this).twTraj!.momentum >= TC.betrayalSpike, `betrayal spikes momentum (${tw(this).twTraj!.momentum})`);
});

// === Rule: the engine owns momentum; the model only proposes shape ======================================

Given("a cooler-shaped fold lands between two houseguests", function (this: BbWorld) {
  // ORW-335: reworded from "the player records a scene ... proposes a cooler consequence shape": the trajectory layer reads only
  // off-screen NPC-to-NPC folds (orchestrator -> recordTrajectoryFold); a player scene's consequence descriptor does NOT feed it (not built).
  // The model proposes the DIRECTION (cooler) — a souring/cooling-shaped fold. It proposes NO magnitude;
  // the engine owns it. A "cooler" shape lands a negative bond delta with a little threat (the engine's own
  // bounded amount), exactly like the `cooler` consequence direction (`CONSEQUENCE_DIRECTION_IMPACTS`).
  tw(this).twTraj = deriveTrajectory([{ bondDelta: -0.105, threatDelta: 0.03, betrayal: false },
    { bondDelta: -0.105, threatDelta: 0.03, betrayal: false }], undefined);
});

When("the engine folds the scene and updates the trajectory", function () { /* folded above (deriveTrajectory over the fold signals) */ });

Then("the trajectory direction reflects the proposed shape", function (this: BbWorld) {
  // A cooler shape ⇒ the arc is falling (cooling or souring), never warming.
  assert.ok(["cooling", "souring"].includes(tw(this).twTraj!.phase), `cooler shape ⇒ falling arc (${tw(this).twTraj!.phase})`);
});

Then("the momentum magnitude is the engine's own bounded, seeded amount", function (this: BbWorld) {
  // The magnitude comes from the engine's constants (buildRate × consistency), NOT from any model number.
  assert.ok(tw(this).twTraj!.momentum > 0 && tw(this).twTraj!.momentum <= 1, "bounded, engine-derived");
});

Then("no number proposed by the model sets how far the momentum moved", function (this: BbWorld) {
  // Proof: two cooler proposals — BOTH a real (above-floor) cooling, but with WILDLY different magnitudes the
  // model might attach — derive the SAME momentum, because `deriveTrajectory` reads only the DIRECTION (sign
  // + above the noise floor), never a proposed magnitude. The engine's `buildRate × consistency` sets the
  // amount, identically for both.
  const slight = deriveTrajectory([{ bondDelta: -0.15, threatDelta: 0.01, betrayal: false }], undefined);
  const huge = deriveTrajectory([{ bondDelta: -0.95, threatDelta: 0.01, betrayal: false }], undefined);
  assert.equal(slight.momentum, huge.momentum, "momentum magnitude is engine-owned, not proposal-scaled");
});

// === Rule: momentum is hidden state — surfaced only through behavior (player AND admin) ==================

Given("an NPC and another NPC with strong souring momentum between them", function (this: BbWorld) {
  const { twSession: s, twRel: rel, twIds: ids } = tw(this);
  rel!.edge(ids![0]!, ids![1]!).threat = 0.7;
  for (let k = 0; k < TC.recencyWindow; k++) trajWired(s!).recordTrajectoryFold(ids![0]!, ids![1]!, "conflict");
  assert.equal(s!.trajectoryOf(ids![0]!, ids![1]!).phase, "souring");
});

When("the player views the house, an NPC's voice, and every status surface", function (this: BbWorld) {
  const { twSession: s, twIds: ids } = tw(this);
  // Build the SAME house WITHOUT the trajectory layer, drive the same folds — its projections are the
  // baseline. If momentum surfaced anywhere, the ON projection would differ.
  const off = liveTrajectoryHouse(2026); off.session.setTrajectoriesEnabled(false);
  off.session.snapshot(); // ensure built
  const offIds = (off.session.snapshot().house?.npcs ?? []).map((n) => n.id);
  off.rel.edge(offIds[0]!, offIds[1]!).threat = 0.7;
  const proj = (sess: GameSessionAdapter): string => JSON.stringify([
    sess.getMomentPrompt({}), ...(sess.snapshot().house?.npcs ?? []).map((n) => sess.npcVoice(n.id)),
    sess.gameStatus(), sess.whereabouts(), sess.getGameState(),
  ]);
  tw(this).twProjOn = proj(s!);
  tw(this).twProjOff = proj(off.session);
});

Then("no trajectory phase or momentum value appears on any of them", function (this: BbWorld) {
  assert.ok(!/"momentum"\s*:/.test(tw(this).twProjOn!), "no momentum value on a player surface");
  assert.ok(!/"phase"\s*:\s*"(warming|cooling|souring|steady)"/.test(tw(this).twProjOn!), "no trajectory phase on a player surface");
});

Then("the souring is observable only as the kinds of scenes that reach the player", function (this: BbWorld) {
  // The ON and OFF projections are byte-identical — momentum changes nothing the player can read; the only
  // channel is the KINDS of scenes (which reach the player via the existing overhear/gossip pathways).
  assert.equal(tw(this).twProjOn, tw(this).twProjOff, "hidden momentum changes no player-observable projection");
});

Given("a relationship trajectory exists in the hidden engine layer", function (this: BbWorld) {
  const { twSession: s, twRel: rel, twIds: ids } = tw(this);
  rel!.edge(ids![0]!, ids![1]!).threat = 0.7;
  for (let k = 0; k < TC.recencyWindow; k++) trajWired(s!).recordTrajectoryFold(ids![0]!, ids![1]!, "conflict");
  assert.ok(trajWired(s!).trajectories.size > 0, "the hidden arc exists");
});

When("an administrator inspects every God-Mode and admin projection", async function (this: BbWorld) {
  // ORW-335: through the REAL admin channel (was player-side projections only): every read-only admin tool on this session.
  const sb = buildSandbox(1);
  const session = tw(this).twSession!;
  const admin = new McpServer("admin/God Mode", { player: sb.player, admin: sb.admin, summary: sb.summary, commands: new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge), session });
  const reads: unknown[] = [];
  for (const name of ["inspectNonVaultState", "sandboxHealth", "getBehavioralFlags"]) reads.push(await admin.callTool(name, {}));
  tw(this).twProjOn = JSON.stringify(reads);
  assert.ok((tw(this).twProjOn ?? "").length > 50, "the admin channel answered");
});

Then("no trajectory phase or momentum value is returned on any of them", function (this: BbWorld) {
  assert.ok(!/"momentum"\s*:/.test(tw(this).twProjOn!), "no momentum value on an admin surface");
  assert.ok(!/"phase"\s*:\s*"(warming|cooling|souring|steady)"/.test(tw(this).twProjOn!), "no trajectory phase on an admin surface");
});

// === Rule: the arc bends probabilities, it never railroads ==============================================

Given("an NPC and another NPC with a strong bond but high souring momentum", function (this: BbWorld) {
  // A strong underlying tie (high bond + a real threat — the betrayal gate IS met) AND maxed souring momentum.
  tw(this).twA = npc(1); tw(this).twB = npc(2);
  tw(this).twTraj = { phase: "souring", momentum: 1 };
});

When("many off-screen scenes are drawn between them over a seeded batch", function (this: BbWorld) {
  const rel = new RelationshipModel(0.5);
  const e = rel.edge(tw(this).twA!, tw(this).twB!); e.affinity = 0.8; e.trust = 0.8; e.threat = 0.6; e.alignment = 0.3;
  let conflict = 0, offArc = 0, betrayals = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const scenes = richOffscreenStretch({
      events: new InMemoryEventStore(), rng: new SeededRandom(seed), npcs: [tw(this).twA!, tw(this).twB!], interactions: 3,
      edgeOf: (a, b) => rel.edge(a, b),
      trajectoryOf: () => tw(this).twTraj!,
    });
    for (const sc of scenes) {
      if (sc.type === "conflict" || sc.type === "betrayal") conflict++;
      else if (sc.type === "bonding" || sc.type === "showmance") offArc++;
      if (sc.type === "betrayal") betrayals++;
    }
  }
  tw(this).twOnArc = conflict; tw(this).twOffArc = offArc; tw(this).twBetrayals = betrayals;
});

Then("most scenes continue the souring arc", function (this: BbWorld) {
  assert.ok(tw(this).twOnArc! > tw(this).twOffArc!, `arc-continuing scenes dominate (${tw(this).twOnArc} > ${tw(this).twOffArc})`);
});

Then("off-arc reconciliation scenes still occur at a nonzero rate", function (this: BbWorld) {
  assert.ok(tw(this).twOffArc! > 0, "a strong tie still produces off-arc warm scenes — no railroad");
});

Then("no betrayal is ever produced unless the prior-bond and incentive gate is already met", function (this: BbWorld) {
  // ORW-335: was `betrayals >= 0` (always true). Now the same seeded batch at FULL souring momentum with the gate UNMET (no prior bond)
  // must produce ZERO betrayals: momentum alone never licenses one.
  const rel = new RelationshipModel(0.5);
  const e = rel.edge(tw(this).twA!, tw(this).twB!); e.affinity = 0.15; e.trust = 0.15; e.threat = 0.8; e.alignment = -0.3;
  let unmet = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const scenes = richOffscreenStretch({
      events: new InMemoryEventStore(), rng: new SeededRandom(seed), npcs: [tw(this).twA!, tw(this).twB!], interactions: 3,
      edgeOf: (a, b) => rel.edge(a, b), trajectoryOf: () => ({ phase: "souring", momentum: 1 }),
    });
    unmet += scenes.filter((sc) => sc.type === "betrayal").length;
  }
  assert.equal(unmet, 0, "no prior bond: zero betrayals even at full souring momentum");
});

// === Rule: deterministic and calibration-neutral ========================================================

Given("a fixed seed and the trajectory layer enabled", function (this: BbWorld) {
  const off = stretchNatures(42);
  const on = stretchNatures(42, () => ({ phase: "souring", momentum: 1 })); // maximal tilt
  tw(this).twNatures = { off: off.natures, on: on.natures };
  tw(this).twDraws = { off: off.draws, on: on.draws };
});

When("the off-screen society is run", function () { /* run in the Given */ });

Then("the number and order of random draws in the off-screen stream are unchanged", function (this: BbWorld) {
  assert.deepEqual(tw(this).twDraws!.on, tw(this).twDraws!.off, "the tilt re-weights the SAME draw — no new rng");
});

Then("only which nature each draw lands on shifts", function (this: BbWorld) {
  assert.notDeepEqual(tw(this).twNatures!.on, tw(this).twNatures!.off, "a strong tilt does shift some natures");
});

Then("the seeded competitions and votes that read the same stream stay in phase", function (this: BbWorld) {
  // The draw stream is byte-identical (asserted above), so anything reading the SAME stream after the
  // off-screen scenes consumes the SAME values — the spine stays in phase.
  assert.deepEqual(tw(this).twDraws!.on, tw(this).twDraws!.off, "same stream ⇒ the downstream spine stays in phase");
});

Given("the same seed and the same folded relationship history", function (this: BbWorld) {
  tw(this).twTraj = deriveTrajectory([signal("bonding"), signal("conflict"), signal("bonding")], { phase: "warming", momentum: 0.3 });
  tw(this).twTrajMixed = deriveTrajectory([signal("bonding"), signal("conflict"), signal("bonding")], { phase: "warming", momentum: 0.3 });
});

When("the trajectory is derived twice", function () { /* derived twice above */ });

Then("the phase and momentum are identical both times", function (this: BbWorld) {
  assert.deepEqual(tw(this).twTraj, tw(this).twTrajMixed, "same seed + history ⇒ identical trajectory");
});

// === Rule: momentum persists and never degrades =========================================================

Given("an NPC and another NPC mid-curdle with souring momentum", function (this: BbWorld) {
  const { twSession: s, twRel: rel, twIds: ids } = tw(this);
  tw(this).twA = ids![0]; tw(this).twB = ids![1];
  rel!.edge(ids![0]!, ids![1]!).threat = 0.7;
  for (let k = 0; k < TC.recencyWindow; k++) trajWired(s!).recordTrajectoryFold(ids![0]!, ids![1]!, "conflict");
  assert.equal(s!.trajectoryOf(ids![0]!, ids![1]!).phase, "souring");
});

When("the game is saved and restored", function (this: BbWorld) {
  tw(this).twSnap = tw(this).twSession!.snapshot();
});

Then("the trajectory resumes at the same phase and momentum", function (this: BbWorld) {
  const before = tw(this).twSession!.trajectoryOf(tw(this).twA!, tw(this).twB!);
  const revived = new GameSessionAdapter(new RelationshipModel(0.5));
  revived.setTrajectoriesEnabled(true);
  revived.restore(tw(this).twSnap!);
  assert.deepEqual(revived.trajectoryOf(tw(this).twA!, tw(this).twB!), before, "resumes mid-curdle");
});

Then("a save written before this feature loads at a steady phase with no error", function (this: BbWorld) {
  const snap = tw(this).twSnap!;
  delete (snap as { trajectories?: unknown }).trajectories;
  delete (snap as { trajectoryFolds?: unknown }).trajectoryFolds;
  const revived = new GameSessionAdapter(new RelationshipModel(0.5));
  revived.setTrajectoriesEnabled(true);
  assert.doesNotThrow(() => revived.restore(snap));
  assert.deepEqual(revived.trajectoryOf(tw(this).twA!, tw(this).twB!), STEADY, "a pre-0087 save resumes at steady");
});
