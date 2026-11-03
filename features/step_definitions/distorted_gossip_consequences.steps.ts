import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GOSSIP_CONSEQUENCE } from "../../src/engine/beliefReliability";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { liveAdminSurface } from "../support/liveSweep";
import { buildSandbox } from "../../tests/support/sandbox";
import { seasonTrail } from "../support/seasonTrail";

/**
 * Feature 0094 — distorted gossip has consequences. Role-only (the-player, an ally, a target, a
 * witness, a near-stranger, an admin). v1 scope: the "closed-set move" the spec names (nomination /
 * vote / a confronting fold) is built here as the NEW `confront` lever specifically — retrofitting
 * `nominate`/`vote` themselves would touch the closed-set decision spine's hard "whoever the player
 * names IS the nominee/vote" invariant, which is out of scope for a bounded feature build (flagged to
 * the owner in the PR). The dramatic-irony reveal (Rule 3) and the behavioral-uncertainty texture
 * (Rule 2) ride the EXISTING 0002/0038 knowledge/gossip machinery verbatim — no new code for either.
 */

interface DgWorld {
  dgReg?: GameSessionRegistry;
  dgSb?: ReturnType<GameSessionRegistry["sandboxFor"]>;
  dgNpc?: EntityId;
  dgFactId?: string;
  dgResult?: { landed: boolean } | null;
  dgPlayerBlob?: string;
  dgAdminBlob?: string;
  dgOffSnap?: unknown;
  dgOnSnap?: unknown;
  dgOffTrail?: string;
  dgOnTrail?: string;
  dgReplaySnapA?: unknown;
  dgReplaySnapB?: unknown;
  dgEdgeBefore?: { trust: number };
  dgEventsBefore?: number;
}
const dg = (w: BbWorld): DgWorld => w as unknown as DgWorld;

// Always leave the process-global static override where the seeded sims expect it: unset (⇒ env, default OFF).
After(() => GameSessionAdapter.setGossipConsequenceEnabled(null));

type WithRel = { rel: { edge: (a: EntityId, b: EntityId) => { trust: number; threat: number; affinity: number } } };
const relOf = (s: GameSessionAdapter): WithRel["rel"] => (s as unknown as WithRel).rel;

function dgGame(prefix: string, seed = 1): { reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]> } {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`dg-${prefix}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { reg, sb };
}

// ── Rule: acting on a distorted belief lands against reality, not the belief ─────────────────────────

Given("the player holds a heavily distorted, low-confidence rumor that an ally is scheming against them", function (this: BbWorld) {
  GameSessionAdapter.setGossipConsequenceEnabled(true);
  const { reg, sb } = dgGame("backfire");
  const npcId = sb.session.snapshot().house!.npcs[0]!.id;
  const factId = "fact:ally-scheme";
  sb.engine.knowledge.seedBelief(
    PLAYER,
    { content: `word is ${npcId} is scheming against you`, factId, subject: npcId, distortion: GOSSIP_CONSEQUENCE.distortionFloor + 1, confidence: GOSSIP_CONSEQUENCE.confidenceCeiling - 0.1 },
    "witnessed",
  );
  Object.assign(dg(this), { dgReg: reg, dgSb: sb, dgNpc: npcId, dgFactId: factId });
});

Given("in reality that ally has been loyal", function (this: BbWorld) {
  // Documentary — the classifier reads only the belief's own distortion/confidence, never a separate
  // "reality" lookup (see beliefReliability.ts); the ally's genuine loyalty is represented narratively
  // (the point the scenario names), warmed here so the fiction and the mechanism agree.
  relOf(dg(this).dgSb!.session).edge(dg(this).dgNpc!, PLAYER).trust = 0.8;
});

When("the player makes a closed-set move against the ally justified by that rumor", function (this: BbWorld) {
  const { dgSb: sb, dgNpc: npcId, dgFactId: factId } = dg(this);
  dg(this).dgResult = sb!.session.confront(npcId!, factId!);
});

Then("the outcome matches reality rather than the player's belief and the move misfires", function (this: BbWorld) {
  assert.equal(dg(this).dgResult?.landed, false);
});

Then("the wronged ally's hidden read of the player takes a betrayal-grade trust hit", function (this: BbWorld) {
  const { dgSb: sb, dgNpc: npcId } = dg(this);
  const edge = relOf(sb!.session).edge(npcId!, PLAYER);
  assert.ok(edge.trust < 0.8, "trust fell from the pre-confrontation loyal baseline");
  assert.ok(edge.threat > 0.1, "threat rose");
});

Then("the engine never tells the player the move misfired because the belief was wrong", function (this: BbWorld) {
  assert.deepEqual(Object.keys(dg(this).dgResult!).sort(), ["landed"]);
});

Given("the player witnessed a target genuinely scheming against them", function (this: BbWorld) {
  GameSessionAdapter.setGossipConsequenceEnabled(true);
  const { reg, sb } = dgGame("faithful");
  const npcId = sb.session.snapshot().house!.npcs[0]!.id;
  const factId = "fact:witnessed-scheme";
  sb.engine.knowledge.seedBelief(PLAYER, { content: `you SAW ${npcId} scheming against you`, factId, subject: npcId, distortion: 0, confidence: 1 }, "witnessed");
  Object.assign(dg(this), { dgReg: reg, dgSb: sb, dgNpc: npcId, dgFactId: factId, dgEdgeBefore: { ...relOf(sb.session).edge(npcId, PLAYER) } });
});

When("the player makes the same closed-set move against the target justified by that witnessed fact", function (this: BbWorld) {
  const { dgSb: sb, dgNpc: npcId, dgFactId: factId } = dg(this);
  dg(this).dgResult = sb!.session.confront(npcId!, factId!);
});

Then("the move lands as expected", function (this: BbWorld) {
  assert.equal(dg(this).dgResult?.landed, true);
});

Then("no belief-versus-reality divergence is applied", function (this: BbWorld) {
  const { dgSb: sb, dgNpc: npcId } = dg(this);
  const before = dg(this).dgEdgeBefore!;
  const edge = relOf(sb!.session).edge(npcId!, PLAYER);
  assert.equal(edge.trust, before.trust); // unchanged from whatever the seeded cast's day-one read set — nothing folded
});

// ── Rule: uncertainty is surfaced behaviorally, never as a number ───────────────────────────────────

Given("the player holds a third-hand, low-confidence rumor about a houseguest", function (this: BbWorld) {
  const { sb } = dgGame("hedge");
  const npcId = sb.session.snapshot().house!.npcs[1]!.id;
  sb.engine.knowledge.transmitGossip(
    sb.session.snapshot().house!.npcs[2]!.id, PLAYER,
    { content: `word is ${npcId} is up to something · or so I heard#42`, factId: "fact:hedged", subject: npcId, hops: 3, confidence: 0.34, distortion: 3.1 },
    "told-by:third-hand",
  );
  Object.assign(dg(this), { dgSb: sb });
});

Given("the player also holds a fact they witnessed first-hand about another houseguest", function (this: BbWorld) {
  const { dgSb: sb } = dg(this);
  const npcId = sb!.session.snapshot().house!.npcs[3]!.id;
  sb!.engine.knowledge.seedBelief(PLAYER, { content: `you watched ${npcId} do it yourself`, factId: "fact:settled", subject: npcId, hops: 0, confidence: 1 }, "witnessed");
});

When("the player brings each up in a scene", function () {
  // Documentary — the narration guidance (`momentPrompts.ts`) directs the model to voice a belief's
  // hops/confidence as PROSE distance, never a number; the seeded content itself already carries the
  // existing `gossip.ts` `distort()` hedge phrasing (proven at the unit level in tests/unit/gossip.test.ts).
});

Then("the second-hand belief is voiced in terms of how distantly it was heard", function (this: BbWorld) {
  const { dgSb: sb } = dg(this);
  const fact = sb!.engine.knowledge.knownTo(PLAYER).find((f) => f.factId === "fact:hedged");
  assert.ok(fact && (fact.hops ?? 0) > 0, "a hopped belief carries a distance signal the narration can voice");
  assert.ok(fact!.content.includes("or so I heard"), "the content itself carries the existing hedge phrasing");
});

Then("the witnessed fact is voiced as settled knowledge", function (this: BbWorld) {
  const { dgSb: sb } = dg(this);
  const fact = sb!.engine.knowledge.knownTo(PLAYER).find((f) => f.factId === "fact:settled");
  assert.equal(fact?.hops ?? 0, 0);
  assert.equal(fact?.confidence ?? 1, 1);
});

Then("no confidence number, distortion number, or \"this is false\" marker is ever shown", function (this: BbWorld) {
  const { dgSb: sb } = dg(this);
  const ids = sb!.session.snapshot().house!.npcs.map((n) => n.id);
  const blob = JSON.stringify([...ids.map((id) => sb!.session.npcVoice(id)), sb!.session.gameStatus(), sb!.session.whereabouts()]);
  assert.ok(!/"confidence":\s*[0-9.]|"distortion"|isMateriallyDistorted|this is false/i.test(blob));
});

// ── Rule: the truth surfaces later (the dramatic-irony reveal) ──────────────────────────────────────

Given("the player acted on a distorted belief and was burned", function (this: BbWorld) {
  GameSessionAdapter.setGossipConsequenceEnabled(true);
  const { sb } = dgGame("irony");
  const npcId = sb.session.snapshot().house!.npcs[0]!.id;
  const factId = "fact:irony";
  sb.engine.knowledge.seedBelief(
    PLAYER,
    { content: `word is ${npcId} is scheming against you`, factId, subject: npcId, originalContent: `${npcId} was actually loyal the whole time`, distortion: 3, confidence: 0.3 },
    "witnessed",
  );
  const result = sb.session.confront(npcId, factId);
  assert.equal(result?.landed, false); // burned, as the scenario names
  Object.assign(dg(this), { dgSb: sb, dgNpc: npcId, dgFactId: factId });
});

When("a genuine later pathway delivers the true version of that same fact", function (this: BbWorld) {
  const { dgSb: sb, dgNpc: npcId, dgFactId: factId } = dg(this);
  const before = sb!.engine.events.count();
  sb!.engine.knowledge.transmitGossip(
    npcId!, PLAYER,
    { content: `turns out ${npcId} was loyal the whole time`, factId: factId!, subject: npcId, originalContent: `${npcId} was actually loyal the whole time`, distortion: 0, confidence: 1 },
    `told-by:${npcId}`,
  );
  Object.assign(dg(this), { dgEventsBefore: before });
});

Then("the player's belief is corrected in place on the same fact lineage", function (this: BbWorld) {
  const { dgSb: sb, dgFactId: factId } = dg(this);
  const onLineage = sb!.engine.knowledge.knownTo(PLAYER).filter((f) => f.factId === factId);
  const corrected = onLineage.find((f) => (f.distortion ?? 0) === 0 && f.confidence === 1);
  assert.ok(corrected, "a corrected, faithful entry now sits on the same factId lineage");
});

Then("the player's realization that they acted on a wrong belief is folded as a recorded beat", function (this: BbWorld) {
  const { dgSb: sb } = dg(this);
  const eventsBefore = dg(this).dgEventsBefore!;
  assert.ok(sb!.engine.events.count() > eventsBefore, "the correction itself is a new recorded event — a real beat");
});

Then("the corrected belief and the original wrong belief both remain in the player's durable history", function (this: BbWorld) {
  const { dgSb: sb, dgFactId: factId } = dg(this);
  const onLineage = sb!.engine.knowledge.knownTo(PLAYER).filter((f) => f.factId === factId);
  assert.ok(onLineage.length >= 2, "both the original distorted entry and the correction persist — nothing is deleted");
});

// ── Rule: the Vault Wall holds — the engine never reveals which beliefs are wrong ───────────────────

Given("the player holds a distorted belief the engine privately knows is false", function (this: BbWorld) {
  const { sb } = dgGame("vault");
  const npcId = sb.session.snapshot().house!.npcs[0]!.id;
  sb.engine.knowledge.seedBelief(PLAYER, { content: `word is ${npcId} is scheming`, factId: "fact:vault", subject: npcId, distortion: 3, confidence: 0.3 }, "witnessed");
  Object.assign(dg(this), { dgSb: sb });
});

When("the player inspects any player-facing surface", function (this: BbWorld) {
  const { dgSb: sb } = dg(this);
  const ids = sb!.session.snapshot().house!.npcs.map((n) => n.id);
  dg(this).dgPlayerBlob = JSON.stringify([...ids.map((id) => sb!.session.npcVoice(id)), sb!.session.gameStatus(), sb!.session.whereabouts()]);
});

Then("no surface marks the belief as false or distorted", function (this: BbWorld) {
  assert.ok(!/isMateriallyDistorted|"false"|materially distorted/i.test(dg(this).dgPlayerBlob ?? ""));
});

Then("no raw confidence or distortion number is shown to the player", function (this: BbWorld) {
  assert.ok(!/"confidence":\s*[0-9.]|"distortion":\s*[0-9.]/.test(dg(this).dgPlayerBlob ?? ""));
});

Then("the wrongness is expressed only through a divergent outcome and a later honest correction", function (this: BbWorld) {
  GameSessionAdapter.setGossipConsequenceEnabled(true);
  const sb = dg(this).dgSb!;
  const known = (): ReturnType<typeof sb.engine.knowledge.knownTo> => sb.engine.knowledge.knownTo(PLAYER).filter((f) => f.factId === "fact:vault");
  const surfaces = (): string => {
    const ids = sb!.session.snapshot().house!.npcs.map((n) => n.id);
    return JSON.stringify([...ids.map((id) => sb!.session.npcVoice(id)), sb!.session.gameStatus(), sb!.session.getGameState()]);
  };
  const npcId = sb!.session.snapshot().house!.npcs[0]!.id;
  // Before acting: the wrong belief sits in the player's knowledge looking like any other, flagged nowhere.
  assert.equal(known().length, 1);
  assert.doesNotMatch(surfaces(), /isMateriallyDistorted|"distortion"|this is false|wrong belief/i);
  // Acting on it: the ONLY signal is the outcome — the move misfires, and the result says nothing about why.
  const result = sb!.session.confront(npcId, "fact:vault");
  assert.equal(result?.landed, false, "the divergent outcome");
  assert.deepEqual(Object.keys(result!).sort(), ["landed"], "the result explains nothing");
  assert.doesNotMatch(surfaces(), /isMateriallyDistorted|"distortion"|this is false|wrong belief/i);
  // Only a genuine later pathway brings the honest correction, onto the same lineage.
  sb!.engine.knowledge.transmitGossip(
    npcId, PLAYER,
    { content: `turns out ${npcId} was loyal`, factId: "fact:vault", subject: npcId, distortion: 0, confidence: 1 },
    `told-by:${npcId}`,
  );
  assert.ok(known().some((f) => (f.distortion ?? 0) === 0 && f.confidence === 1), "the honest correction arrived on the same lineage");
});

When("an admin inspects every admin and God-Mode surface", function (this: BbWorld) {
  // PAT-2: the admin surface of THE SAME live game that holds the planted distorted belief (was: a fresh,
  // unrelated canary sandbox that never saw this game, so the sweep could not fail).
  dg(this).dgAdminBlob = liveAdminSurface(dg(this).dgSb!);
});

Then("no admin surface reveals which of the player's beliefs are wrong", function (this: BbWorld) {
  assert.ok(!/isMateriallyDistorted|materially distorted/i.test(dg(this).dgAdminBlob ?? ""));
});

Then("no admin surface exposes the truth-value or the raw distortion of a held belief", function (this: BbWorld) {
  assert.ok(!/"distortion":\s*[0-9.]|"confidence":\s*[0-9.]/.test(dg(this).dgAdminBlob ?? ""));
});

// ── Rule: calibration-neutral and deterministic ─────────────────────────────────────────────────────

Given("the distorted-gossip-consequence feature is disabled", function (this: BbWorld) {
  GameSessionAdapter.setGossipConsequenceEnabled(null); // explicit: the default is OFF
  const { sb: off } = dgGame("off", 777);
  const trail = seasonTrail(off.session, 200);
  Object.assign(dg(this), { dgOffSnap: off.session.snapshot(), dgOffTrail: trail });
});

When("a full season is played from a fixed seed", function (this: BbWorld) {
  // `confront` is reachable ONLY via the player MCP channel (never the automatic off-screen tick/vote/competition
  // spine) — so the same seed with the flag ON must play out byte-identically through a real season of beats.
  GameSessionAdapter.setGossipConsequenceEnabled(true);
  const { sb: on } = dgGame("on", 777);
  const trail = seasonTrail(on.session, 200);
  Object.assign(dg(this), { dgOnSnap: on.session.snapshot(), dgOnTrail: trail });
  GameSessionAdapter.setGossipConsequenceEnabled(null);
});

Then("no belief-versus-reality divergence is computed and no extra fold is applied", function (this: BbWorld) {
  assert.ok(dg(this).dgOnTrail!.length > 100, "a season of beats was actually played");
  assert.deepEqual(dg(this).dgOnSnap, dg(this).dgOffSnap);
});

Then("the seeded competition and jury outcomes are byte-identical to the baseline", function (this: BbWorld) {
  assert.equal(dg(this).dgOnTrail, dg(this).dgOffTrail, "the flag changed the seeded HOH / nominee / eviction trail");
});

Given("a fixed seed and an identical history in which the player acts on a distorted belief", function (this: BbWorld) {
  GameSessionAdapter.setGossipConsequenceEnabled(true);
  const act = (prefix: string): unknown => {
    const { sb } = dgGame(prefix, 555);
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    sb.engine.knowledge.seedBelief(PLAYER, { content: `word is ${npcId} is scheming`, factId: "fact:replay", subject: npcId, distortion: 3, confidence: 0.3 }, "witnessed");
    const result = sb.session.confront(npcId, "fact:replay");
    return { landed: result?.landed, edge: relOf(sb.session).edge(npcId, PLAYER) };
  };
  Object.assign(dg(this), { dgReplaySnapA: act("replay-a"), dgReplaySnapB: act("replay-b") });
});

When("the season is replayed", function () {
  // Both replays already ran in the Given (two independent, identically-seeded games) — nothing further.
});

Then("the same belief is classified as distorted", function (this: BbWorld) {
  assert.equal((dg(this).dgReplaySnapA as { landed: boolean }).landed, false);
  assert.equal((dg(this).dgReplaySnapB as { landed: boolean }).landed, false);
});

Then("the same move misfires with the same seeded consequence", function (this: BbWorld) {
  assert.deepEqual(dg(this).dgReplaySnapA, dg(this).dgReplaySnapB);
});
