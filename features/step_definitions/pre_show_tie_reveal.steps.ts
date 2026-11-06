import { Given, When, Then, After } from "@cucumber/cucumber";
import { ACCUSE } from "../../src/engine/accuseConstants";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import { tieExposureOf, tieNatureProse, exposedTies, type PreGameTie } from "../../src/engine/seededRelationships";
import { TIE_REVEAL } from "../../src/engine/tieRevealConstants";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { liveAdminSurface } from "../support/liveSweep";
import { buildSandbox } from "../../tests/support/sandbox";
import { seasonTrail } from "../support/seasonTrail";
import { defaultApply } from "../../src/composition/orchestrator";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * Feature 0095 — pre-show ties as time-bombs. Role-only (the-player, a tied pair, a deceived
 * houseguest, an onlooker, a near-stranger pair, the house). Drives the REAL `GameSessionAdapter`
 * seeded-tie layer via a live `GameSessionRegistry` sandbox (so the `accuseTie`/`onConfide` pathway is
 * genuinely wired, not a bare adapter).
 */

interface TrWorld {
  trReg?: GameSessionRegistry;
  trSb?: ReturnType<GameSessionRegistry["sandboxFor"]>;
  trTie?: PreGameTie;
  trEvent?: { observer: EntityId } | undefined;
  trAccuseResult?: { landed: boolean };
  trPlayerBlob?: string;
  trAdminBlob?: string;
  trUntiedPair?: [EntityId, EntityId];
  trRevived?: GameSessionAdapter;
  trOffSnap?: unknown;
  trOnSnap?: unknown;
  trOffTrail?: string;
  trOnTrail?: string;
  trEdgesBefore?: string;
  trRelsBefore?: string;
}
const tr = (w: BbWorld): TrWorld => w as unknown as TrWorld;

// Always leave the process-global static override where the seeded sims expect it: unset (⇒ env, default OFF).
After(() => GameSessionAdapter.setTieRevealEnabled(null));

type WithSeededRels = { seededRels: { ties: PreGameTie[] }; tieExposureCount: number };
const peek = (s: GameSessionAdapter): WithSeededRels => s as unknown as WithSeededRels;
/** The session's engine-private `RelationshipModel` handle (the sandbox doesn't expose it directly). */
const relOf = (s: GameSessionAdapter): RelationshipModel => (s as unknown as { rel: RelationshipModel }).rel;

/** A live game whose seeded layer has at least one pre-game TIE (sparseness ⇒ most seeds have none). */
function gameWithATie(prefix: string): { reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]>; tie: PreGameTie } {
  for (let seed = 1; seed <= 300; seed++) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`${prefix}-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const ties = sb.session.snapshot().seededRelationships?.ties ?? [];
    if (ties.length > 0) return { reg, sb, tie: ties[0]! };
  }
  throw new Error("no seed produced a pre-game tie within the probe range");
}

/** Every houseguest's directed read of both members of the tie, as one comparable string. */
function readsOfPair(sb: ReturnType<GameSessionRegistry["sandboxFor"]>, tie: PreGameTie): string {
  const ids = sb.session.snapshot().house!.npcs.map((n) => n.id);
  return JSON.stringify(ids.filter((id) => id !== tie.a && id !== tie.b).map((id) => [id, relOf(sb.session).edge(id, tie.a), relOf(sb.session).edge(id, tie.b)]));
}

// AMEND 3a #2: ALL eleven TieNature values (src/engine/seededRelationships.ts), not just the original five. The single-word natures (family / ex / rival) are common English words, so they are matched
// only as a serialized `"nature":"<value>"` field - a bare /ex/ would flag "exposed".
const tieRegex = /casting-callback|mutual-friend|shared-hometown|old-acquaintance|pre-game-tie|prior-romance|old-friend|former-teammate|online-acquaintance|"nature"\s*:\s*"(?:family|ex|rival)"/;

// ── Background ───────────────────────────────────────────────────────────────────────────────────

Given("the hidden seeded relationship layer holds a pre-show tie between two houseguests", function (this: BbWorld) {
  const { reg, sb, tie } = gameWithATie("tie-reveal");
  Object.assign(tr(this), { trReg: reg, trSb: sb, trTie: tie });
});

// ── Rule: a sealed tie never leaks before a pathway surfaces it — to player OR admin ────────────────

Given("the tie has not been exposed by any pathway", function (this: BbWorld) {
  assert.equal(tieExposureOf(tr(this).trTie!), "sealed");
});

Then("the tie never appears on any player-facing surface", function (this: BbWorld) {
  const { trSb: sb } = tr(this);
  const ids = sb!.session.snapshot().house!.npcs.map((n) => n.id);
  tr(this).trPlayerBlob = JSON.stringify([
    ...ids.map((id) => sb!.session.npcVoice(id)),
    sb!.session.gameStatus(),
    sb!.session.whereabouts(),
  ]);
  assert.ok(!tieRegex.test(tr(this).trPlayerBlob!));
});

Then("the tie never appears on any admin or God-Mode surface", function (this: BbWorld) {
  // PAT-2: the admin surface of THE SAME live game that holds the sealed tie (was: a fresh, unrelated canary
  // sandbox that never saw this game, so the sweep could not fail).
  tr(this).trAdminBlob = liveAdminSurface(tr(this).trSb!);
  assert.ok(!tieRegex.test(tr(this).trAdminBlob!));
});

Then("the only trace of the tie is the houseguests' behavior, never a stated fact or a number", function (this: BbWorld) {
  const blob = (tr(this).trPlayerBlob ?? "") + (tr(this).trAdminBlob ?? "");
  assert.ok(!/"exposure"|"nature"|TIE_AFFINITY_BIAS/.test(blob));
});

Given("the tied pair is not conspicuous together", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  relOf(sb!.session).edge(tie!.a, tie!.b).affinity = 0.2;
  relOf(sb!.session).edge(tie!.b, tie!.a).affinity = 0.2;
});

Given("neither of the pair is under enough strain to let it slip", function () {
  // No "slip" pathway is built in v1 (deferred per the spec's own open questions): strain cannot expose a tie.
});

Given("no one has accused the pair of a prior connection", function (this: BbWorld) {
  // Give every pathway its best chance: the overhear scheduler is switched ON and ticked thousands of times while the
  // pair stays unconspicuous and nobody calls `accuseTie`. Whatever it does (nothing), the reads are captured around it.
  const { trSb: sb, trTie: tie } = tr(this);
  GameSessionAdapter.setTieRevealEnabled(true);
  tr(this).trEdgesBefore = readsOfPair(sb!, tie!);
  for (let i = 0; i < 3000; i++) sb!.session.advanceTieReveal(sb!.engine.knowledge);
});

Then("the tie stays sealed", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  const after = sb!.session.snapshot().seededRelationships!.ties.find((t) => (t.a === tie!.a && t.b === tie!.b) || (t.a === tie!.b && t.b === tie!.a));
  assert.equal(tieExposureOf(after!), "sealed");
});

Then("no exposure is recorded", function (this: BbWorld) {
  assert.equal(peek(tr(this).trSb!.session).tieExposureCount, 0);
});

Then("the house reads the pair as it would any other two houseguests", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  assert.equal(readsOfPair(sb!, tie!), tr(this).trEdgesBefore, "with no pathway the house's reads of the pair moved");
});

// ── Rule: a pathway exposes the tie and the house reacts ────────────────────────────────────────────

Given("the tied pair is conspicuously holed up together in a private room", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  // The overhear gate reads mutual AFFINITY (the same observable-closeness signal 0059 §5 itself gates
  // on) — pushed well past `conspicuousAffinity`, representing the pair genuinely holed up together.
  relOf(sb!.session).edge(tie!.a, tie!.b).affinity = TIE_REVEAL.conspicuousAffinity + 0.2;
  relOf(sb!.session).edge(tie!.b, tie!.a).affinity = TIE_REVEAL.conspicuousAffinity + 0.2;
});

Given("a plausibly-positioned third houseguest is around to notice", function (this: BbWorld) {
  // The default (unset) occupancy already treats every NPC as out in the open (not behind a closed
  // door) — a plausible onlooker is available by construction. Capture the house's reads of the pair BEFORE the tick.
  tr(this).trEdgesBefore = readsOfPair(tr(this).trSb!, tr(this).trTie!);
});

When("the off-screen society tick fires the overhear pathway", function (this: BbWorld) {
  const { trSb: sb } = tr(this);
  GameSessionAdapter.setTieRevealEnabled(true);
  let fired: { observer: EntityId } | undefined;
  for (let i = 0; i < 500 && !fired; i++) {
    const events = sb!.session.advanceTieReveal(sb!.engine.knowledge);
    if (events.length) fired = events[0]!;
  }
  assert.ok(fired, "the overhear pathway should fire within 500 ticks at the bounded probability");
  tr(this).trEvent = fired;
});

Then("the tie is surfaced to the house through that onlooker", function (this: BbWorld) {
  const { trSb: sb, trTie: tie, trEvent: ev } = tr(this);
  assert.ok(ev?.observer);
  const after = sb!.session.snapshot().seededRelationships!.ties.find((t) => (t.a === tie!.a && t.b === tie!.b) || (t.a === tie!.b && t.b === tie!.a));
  assert.notEqual(tieExposureOf(after!), "sealed");
});

Then("the houseguests who learn of it read the pair as a hidden duo to target", function (this: BbWorld) {
  const { trSb: sb, trTie: tie, trEvent: ev } = tr(this);
  const towardA = relOf(sb!.session).edge(ev!.observer, tie!.a);
  const towardB = relOf(sb!.session).edge(ev!.observer, tie!.b);
  assert.ok(towardA.threat > 0.1 || towardB.threat > 0.1, "the onlooker's threat read of the pair rose");
});

Then("their trust in both members of the pair falls and their threat read of both rises", function (this: BbWorld) {
  const { trSb: sb, trTie: tie, trEvent: ev } = tr(this);
  for (const member of [tie!.a, tie!.b]) {
    const edge = relOf(sb!.session).edge(ev!.observer, member);
    assert.ok(edge.trust < 0.25, `trust fell for ${member}`); // below the RelationshipModel default baseline
    assert.ok(edge.threat > 0.1, `threat rose for ${member}`);
  }
});

Then("the fallout is bounded and never a flat house-wide flag", function (this: BbWorld) {
  const { trSb: sb, trTie: tie, trEvent: ev } = tr(this);
  const edge = relOf(sb!.session).edge(ev!.observer, tie!.a);
  // Bounded: even with the widest legitimate 0026 amplification (a "clash"-disposition adverseScale
  // of 1.5 × the ±20% temperature jitter), the fold cannot exceed ~1.8x the raw BETRAYAL_SHOCK it's
  // derived from — a generous multiple that still rules out an unbounded/runaway magnitude.
  assert.ok(edge.trust >= 0.25 - 0.32 * 2 - 1e-9);
  assert.ok(edge.threat <= 0.1 + 0.32 * 2 + 1e-9);
  // Never a flat flag: the DIRECT observer's fold is a bounded, per-listener edge move (checked above)
  // — never a single global "the tie is exposed" switch. Structurally guaranteed: `overhearTieReveal`
  // folds only the observer directly, then hands off to `diffuseGossip`, whose `foldReceipt` scales
  // EVERY further learner's fold by their OWN diffusion confidence (`tests/unit/tieReveal0095.test.ts`
  // proves this at the unit level) — a fifth-hand rumor barely registers, exactly the opposite of a flag.
  const after = JSON.parse(readsOfPair(sb!, tie!)) as Array<[string, unknown, unknown]>;
  const before = JSON.parse(tr(this).trEdgesBefore!) as Array<[string, unknown, unknown]>;
  const moved = after.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i])).length;
  assert.ok(moved >= 1, "the exposure moved at least the onlooker's read");
  assert.ok(moved < after.length, `the fallout reached all ${after.length} other houseguests: that is a flat house-wide flag`);
});

Given("the player suspects the pair knew each other before the show", function () {
  // Documentary — the Background already seeded a real tie; the player's suspicion is the fiction
  // the upcoming `accuseTie` call represents.
});

When("the player accuses the pair of a prior connection through the engine authority", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  tr(this).trAccuseResult = sb!.session.accuseTie(tie!.a, tie!.b) ?? undefined;
});

Then("the engine confirms a real tie exists and the accusation lands", function (this: BbWorld) {
  assert.equal(tr(this).trAccuseResult?.landed, true);
});

Then("the exposure is recorded as the player's own knowledge through the pathway with content lineage", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  const held = sb!.engine.knowledge.knownTo(PLAYER);
  const fact = held.find((f) => f.content.includes(tieNatureProse(tie!.nature)));
  assert.ok(fact, "the player's knowledge holds the exposed connection with content lineage");
  assert.ok(fact!.pathway.startsWith("told-by:"));
});

Then("the secret pre-alliance coming out deals the deceived houseguests a betrayal-grade blow toward both members", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  const npcs = sb!.session.snapshot().house!.npcs.map((n) => n.id);
  const otherLearner = npcs.find((id) => id !== tie!.a && id !== tie!.b)!;
  for (const member of [tie!.a, tie!.b]) {
    const edge = relOf(sb!.session).edge(otherLearner, member);
    assert.ok(edge.trust < 0.25 && edge.threat > 0.1, `a witnessing houseguest's read of ${member} took a betrayal-grade hit`);
  }
});

Then("the player is shown no number and no tell", function (this: BbWorld) {
  assert.deepEqual(Object.keys(tr(this).trAccuseResult!).sort(), ["landed"]);
});

Given("a pair of near-strangers with no seeded tie", function (this: BbWorld) {
  const { trSb: sb } = tr(this);
  const npcs = sb!.session.snapshot().house!.npcs.map((n) => n.id);
  const ties = sb!.session.snapshot().seededRelationships?.ties ?? [];
  const tiedIds = new Set(ties.flatMap((t) => [t.a, t.b]));
  const untied = npcs.filter((id) => !tiedIds.has(id));
  tr(this).trUntiedPair = [untied[0]!, untied[1]!];
});

When("the player accuses that pair of a prior connection through the engine authority", function (this: BbWorld) {
  const { trSb: sb, trUntiedPair } = tr(this);
  const core = sb!.session.snapshot();
  tr(this).trRelsBefore = JSON.stringify([relOf(sb!.session).serialize().edges, core.seededRelationships, sb!.engine.knowledge.knownTo(PLAYER).length]);
  const [a, b] = trUntiedPair!;
  tr(this).trAccuseResult = sb!.session.accuseTie(a, b) ?? undefined;
});

Then("the accusation misses", function (this: BbWorld) {
  assert.equal(tr(this).trAccuseResult?.landed, false);
});

Then("no tie is surfaced and no sealed state is read", function (this: BbWorld) {
  const { trSb: sb } = tr(this);
  assert.equal(peek(sb!.session).tieExposureCount, 0);
});

Then("a wrong accusation costs the accuser: each wrongly accused houseguest thinks less of the player, by a bounded amount", function (this: BbWorld) {
  // Ryne 2026-11-05 (accuseTie ruling): "Falsely accusing someone should definitely ding." A miss is no longer free (ORWELL_ACCUSE_COST, ON): each accused houseguest's read of the accuser takes a
  // bounded dent (ACCUSE.missImpact, scaled by the engine's seeded jitter). The scenario runs with the shipped default flags.
  const { trSb: sb, trUntiedPair } = tr(this);
  const before = JSON.parse(tr(this).trRelsBefore!) as [Array<{ from: string; to: string; trust: number }>, unknown, number];
  const after = relOf(sb!.session).serialize().edges as Array<{ from: string; to: string; trust: number }>;
  const trustOf = (edges: typeof after, from: string, to: string): number => edges.find((e) => e.from === from && e.to === to)?.trust ?? NaN;
  for (const member of trUntiedPair!) {
    const drop = trustOf(before[0], member, PLAYER) - trustOf(after, member, PLAYER);
    assert.ok(drop > 0, `the wrongly accused ${member} thinks less of the player (trust fell by ${drop})`);
    assert.ok(drop <= Math.abs(ACCUSE.missImpact.trust ?? 0) * 2, `...but the cost is bounded (fell by ${drop})`);
  }
});

Then("nothing else sealed or hidden moves", function (this: BbWorld) {
  // The seeded ties are untouched, the player learned nothing, and no relationship edge that does NOT point at the player changed.
  const { trSb: sb } = tr(this);
  const core = sb!.session.snapshot();
  const before = JSON.parse(tr(this).trRelsBefore!) as [Array<{ from: string; to: string }>, unknown, number];
  assert.equal(JSON.stringify(core.seededRelationships), JSON.stringify(before[1]), "the seeded ties are untouched");
  assert.equal(sb!.engine.knowledge.knownTo(PLAYER).length, before[2], "the player learned nothing");
  const after = relOf(sb!.session).serialize().edges as Array<{ from: string; to: string }>;
  const notTowardPlayer = (edges: Array<{ from: string; to: string }>): string => JSON.stringify(edges.filter((e) => e.to !== PLAYER));
  assert.equal(notTowardPlayer(after), notTowardPlayer(before[0]), "no edge between other houseguests moved");
});

Then("the player is shown no number and no tell distinguishing a miss from a hit", function (this: BbWorld) {
  assert.deepEqual(Object.keys(tr(this).trAccuseResult!).sort(), ["landed"]);
});

// ── Rule: the engine decides and records; the model only voices ─────────────────────────────────────

Given("the tie has not been exposed", function (this: BbWorld) {
  assert.equal(tieExposureOf(tr(this).trTie!), "sealed");
});

When("the model fetches the houseguests' voices for a scene", function (this: BbWorld) {
  const { trSb: sb } = tr(this);
  const ids = sb!.session.snapshot().house!.npcs.map((n) => n.id);
  tr(this).trPlayerBlob = JSON.stringify(ids.map((id) => sb!.session.npcVoice(id)));
});

Then("the voices carry no sealed tie content", function (this: BbWorld) {
  assert.ok(!tieRegex.test(tr(this).trPlayerBlob!));
});

Then("only an exposure the engine has already committed is ever voiced as a public fact", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  const liveTies = (): PreGameTie[] => peek(sb!.session).seededRels.ties;
  const voices = (): string => JSON.stringify(sb!.session.snapshot().house!.npcs.map((n) => sb!.session.npcVoice(n.id)));
  // Sealed — and even merely surfaced among the houseguests off-screen — is never a public fact.
  assert.equal(exposedTies(liveTies()).length, 0);
  liveTies().find((t) => t.a === tie!.a && t.b === tie!.b)!.exposure = "surfaced-to-house";
  assert.equal(exposedTies(liveTies()).length, 0, "an off-screen-only surfacing was projected as public");
  assert.ok(!tieRegex.test(voices()));
  // Only the engine's own committed exposure (the accusation landing) makes it a public fact.
  assert.equal(sb!.session.accuseTie(tie!.a, tie!.b)?.landed, true);
  assert.deepEqual(exposedTies(liveTies()).map((t) => [t.a, t.b]), [[tie!.a, tie!.b]]);
});

Given("the tie has surfaced among the houseguests off-screen", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  const inject = peek(sb!.session);
  const t = inject.seededRels.ties.find((x) => (x.a === tie!.a && x.b === tie!.b) || (x.a === tie!.b && x.b === tie!.a))!;
  t.exposure = "surfaced-to-house";
});

Given("no diffusion chain has yet reached the player", function (this: BbWorld) {
  const { trSb: sb } = tr(this);
  assert.equal(sb!.engine.knowledge.knownTo(PLAYER).length, 0);
});

Then("the player holds no belief about the tie", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  const held = sb!.engine.knowledge.knownTo(PLAYER);
  assert.ok(!held.some((f) => f.content.includes(tieNatureProse(tie!.nature))));
});

When("a retelling chain finally terminates at the player", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  // Warm the pair conspicuously and the whole graph so a chain can plausibly reach the player, then
  // drive the overhear pathway until it lands on THIS tie and a belief reaches the player. Each firing
  // promotes the tie one step (surfaced-to-house → public), which would otherwise retire it as a
  // candidate after a single attempt — reset it back so many INDEPENDENT diffusion rolls get a shot,
  // exactly like re-running the pure module test across many seeds.
  relOf(sb!.session).edge(tie!.a, tie!.b).affinity = 0.95;
  relOf(sb!.session).edge(tie!.b, tie!.a).affinity = 0.95;
  const npcs = sb!.session.snapshot().house!.npcs.map((n) => n.id);
  for (const id of npcs) {
    relOf(sb!.session).edge(id, PLAYER).affinity = 0.9;
    relOf(sb!.session).edge(PLAYER, id).affinity = 0.9;
  }
  GameSessionAdapter.setTieRevealEnabled(true);
  const reached = (): boolean => sb!.engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes(tieNatureProse(tie!.nature)));
  for (let i = 0; i < 2000 && !reached(); i++) {
    sb!.session.advanceTieReveal(sb!.engine.knowledge);
    const live = peek(sb!.session).seededRels.ties.find((t) => (t.a === tie!.a && t.b === tie!.b) || (t.a === tie!.b && t.b === tie!.a))!;
    if (live.exposure === "public" && !reached()) live.exposure = "surfaced-to-house"; // retry — another chance to reach the player
  }
});

Then("the player learns of the tie as a belief with a source and a confidence", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  const held = sb!.engine.knowledge.knownTo(PLAYER);
  const fact = held.find((f) => f.content.includes(tieNatureProse(tie!.nature)));
  assert.ok(fact, "a belief about the real connection reached the player");
  assert.ok(fact!.source !== undefined);
  assert.ok(fact!.confidence !== undefined && fact!.confidence > 0 && fact!.confidence <= 1);
});

Then("that belief is the player's recorded knowledge, never Vault content", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  const fact = sb!.engine.knowledge.knownTo(PLAYER).find((f) => f.content.includes(tieNatureProse(tie!.nature)));
  assert.ok(fact && fact.pathway !== "hidden" && fact.pathway.length > 0);
});

// ── Rule: exposures are rare, persisted, and calibration-neutral ────────────────────────────────────

Given("the tie has been exposed and is now public", function (this: BbWorld) {
  const { trSb: sb, trTie: tie } = tr(this);
  const result = sb!.session.accuseTie(tie!.a, tie!.b);
  assert.equal(result?.landed, true);
});

When("the tie-reveal game is saved and restored", function (this: BbWorld) {
  const { trSb: sb } = tr(this);
  const snap = sb!.session.snapshot();
  const revived = new GameSessionAdapter();
  revived.restore(snap);
  Object.assign(tr(this), { trRevived: revived });
});

Then("the restored game still records the tie as exposed", function (this: BbWorld) {
  const revived = tr(this).trRevived!;
  const { trTie: tie } = tr(this);
  const t = revived.snapshot().seededRelationships!.ties.find((x) => (x.a === tie!.a && x.b === tie!.b) || (x.a === tie!.b && x.b === tie!.a));
  assert.equal(tieExposureOf(t!), "public");
});

Then("the exposure never regresses to a less-exposed state", function (this: BbWorld) {
  // Proven directly on the pure `nextTieExposure` promoter + the snapshot non-degradation guard
  // (`sessionCoreIsSuperset`'s tie-exposure check, `tests/unit/sessionCoreCheckpointCoverage.test.ts`);
  // here, restoring twice in a row is still `public` (idempotent, never regresses).
  const revived = tr(this).trRevived!;
  const rerevived = new GameSessionAdapter();
  rerevived.restore(revived.snapshot());
  const { trTie: tie } = tr(this);
  const t = rerevived.snapshot().seededRelationships!.ties.find((x) => (x.a === tie!.a && x.b === tie!.b) || (x.a === tie!.b && x.b === tie!.a));
  assert.equal(tieExposureOf(t!), "public");
});

Given("a full season of tie reveals is played", function (this: BbWorld) {
  const { trSb: sb } = tr(this);
  GameSessionAdapter.setTieRevealEnabled(true);
  const inject = peek(sb!.session);
  // Force MANY sealed ties (well beyond the natural sparse budget) so the cap is genuinely exercised.
  const npcs = sb!.session.snapshot().house!.npcs.map((n) => n.id);
  inject.seededRels.ties = [];
  for (let i = 0; i + 1 < npcs.length; i += 2) inject.seededRels.ties.push({ a: npcs[i]!, b: npcs[i + 1]!, nature: "old-acquaintance" });
  for (const t of inject.seededRels.ties) {
    relOf(sb!.session).edge(t.a, t.b).affinity = 0.95;
    relOf(sb!.session).edge(t.b, t.a).affinity = 0.95;
  }
  for (let i = 0; i < 4000; i++) sb!.session.advanceTieReveal(sb!.engine.knowledge);
});

Then("the number of exposed pre-show ties never exceeds the season cap", function (this: BbWorld) {
  const { trSb: sb } = tr(this);
  const exposedCount = (sb!.session.snapshot().seededRelationships?.ties ?? []).filter((t) => tieExposureOf(t) !== "sealed").length;
  assert.ok(exposedCount <= TIE_REVEAL.maxExposuresPerSeason, `${exposedCount} exposed ties ≤ the cap`);
});

Given("the same seed is played with the tie-reveal feature off and on without a precipitant", function (this: BbWorld) {
  // A house that really HAS a sealed tie (so a precipitant could exist), played through the live loop with the
  // orchestrator's off-screen tick after every beat (the tick is what runs the overhear scheduler).
  let seed = 1;
  for (; seed <= 300; seed++) {
    const probe = new GameSessionRegistry().sandboxFor(`probe-${seed}`);
    probe.session.createCharacter({ playerName: "The Player", seed });
    if ((probe.session.snapshot().seededRelationships?.ties ?? []).length > 0) break;
  }
  if (seed > 300) throw new Error("no seed in 1..300 casts a house with a sealed pre-show tie");
  const season = (enabled: boolean): { snap: unknown; trail: string; edges: unknown } => {
    GameSessionAdapter.setTieRevealEnabled(enabled); // an EXPLICIT on/off (null would defer to ORWELL_TIE_REVEAL in the environment)
    const sb = new GameSessionRegistry().sandboxFor(`tie-calib-${enabled}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    let clock = 0;
    const rng = new SeededRandom(seed);
    // "Without a precipitant" = the sealed pair NEVER warms into the open: hold both directed affinities of every sealed tie
    // under the conspicuousness floor around each off-screen tick, so ordinary social ticks cannot manufacture one.
    const hold = (): void => {
      for (const t of peek(sb.session).seededRels.ties) {
        for (const [x, y] of [[t.a, t.b], [t.b, t.a]] as const) {
          const e = relOf(sb.session).edge(x, y);
          e.affinity = Math.min(e.affinity, TIE_REVEAL.conspicuousAffinity - 0.2);
        }
      }
    };
    const trail = seasonTrail(sb.session, 600, () => { hold(); defaultApply(sb, "offscreen-tick", rng, clock++); hold(); });
    return { snap: sb.session.snapshot(), trail, edges: relOf(sb.session).serialize().edges };
  };
  const off = season(false);
  const on = season(true);
  GameSessionAdapter.setTieRevealEnabled(null);
  Object.assign(tr(this), { trOffSnap: { ...(off.snap as object), edges: off.edges }, trOnSnap: { ...(on.snap as object), edges: on.edges }, trOffTrail: off.trail, trOnTrail: on.trail });
});

Then("no exposure roll is taken and no relationship edge is touched", function (this: BbWorld) {
  const off = tr(this).trOffSnap as { edges?: unknown; tieExposureCount?: number; tieRevealTickCount?: number };
  const on = tr(this).trOnSnap as { edges?: unknown; tieExposureCount?: number; tieRevealTickCount?: number };
  assert.ok(tr(this).trOnTrail!.length > 100, "a season was actually played");
  assert.equal(on.tieExposureCount ?? 0, 0, "an exposure was recorded with no precipitant");
  assert.deepEqual(on.edges, off.edges, "a relationship edge moved with the feature on");
  // The scheduler's own private tick counter is the one thing allowed to differ (it only seeds its dedicated rng).
  assert.ok((on.tieRevealTickCount ?? 0) > 0 && (off.tieRevealTickCount ?? 0) === 0, "the scheduler really ran when on, and stayed inert when off");
  const { tieRevealTickCount: _a, ...onRest } = on;
  const { tieRevealTickCount: _b, ...offRest } = off;
  assert.deepEqual(onRest, offRest, "identical seed ⇒ byte-identical session with no precipitant, flag on or off");
});

Then("the seeded competition, jury, and eviction outcomes are byte-identical", function (this: BbWorld) {
  assert.equal(tr(this).trOnTrail, tr(this).trOffTrail, "the flag changed the seeded HOH / nominee / eviction trail");
});
