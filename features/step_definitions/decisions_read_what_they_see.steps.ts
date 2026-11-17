import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER, type EntityId } from "../../src/domain/ids";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { duoRead, floaterRead } from "../../src/engine/season";
import type { RelationshipModel } from "../../src/engine/relationships";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { DECISION } from "../../src/engine/decisionConstants";

const BASE = RELATIONSHIP_CONSTANTS.baseline;
/** A close pair: 90% of the way across the floater span above the baseline (the truth reads them as a tight pair, short of the cap). */
const CLOSE = (BASE.trust + BASE.affinity) / 2 + 0.9 * DECISION.nomination.floaterBondSpan;

/**
 * Feature 0163 - decisions read what the decider can see (ORW-539). Drives the REAL adapter through a registry sandbox: the bond the HOH sees
 * is the adapter's own read (the one the live nomination plan is handed as `bondOf`), over the sandbox's real event store and relationship
 * model, fed to the real floater / duo reads. TEST-ONLY seams: the live season (beliefs, the week), the relationship model, the adapter's
 * private perceived-bond read and its flag. Roles only: the HOH, a pair, a floater.
 */
type Seam = {
  live: { playedGame?: boolean; beliefs?: BeliefStore; week: number };
  rel: RelationshipModel;
  perceivedBond(holder: EntityId, from: EntityId, to: EntityId): number;
  perceivedBondsEnabled: boolean;
};
type Bag = { sb?: UserSandbox; hoh?: string; a?: string; b?: string; others?: string[] };
const bag = (w: unknown): Bag => ((w as { see0163?: Bag }).see0163 ??= {});
const seam = (w: unknown) => bag(w).sb!.session as unknown as Seam;
let n = 0;

function played(w: unknown): void {
  const sb = new GameSessionRegistry().sandboxFor(`see0163-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 21 });
  (sb.session as unknown as Seam).live.playedGame = true;
  const b = bag(w);
  b.sb = sb;
  const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  [b.hoh, b.a, b.b] = npcs;
  b.others = npcs.filter((id) => ![b.hoh, b.a, b.b].includes(id));
  // a quiet house: everyone at the edge baseline toward everyone, so only the pair under test stands out
  for (const x of npcs) for (const y of npcs) if (x !== y) Object.assign(seam(w).rel.edge(x, y), { trust: BASE.trust, affinity: BASE.affinity, reliability: BASE.reliability });
}

function setPair(w: unknown, level: number): void {
  const b = bag(w);
  for (const [x, y] of [[b.a!, b.b!], [b.b!, b.a!]]) { const e = seam(w).rel.edge(x, y); e.trust = level; e.affinity = level; }
}

let seq = 0;
function bondingScene(w: unknown, witnessSet: string[], seenBy: string[]): void {
  bag(w).sb!.engine.events.record({
    id: `see0163-scene-${seq++}`, ts: 1000 + seq, type: "bonding", initiator: witnessSet[0]!, witnessSet, hidden: true, content: "they talk for an hour",
    houseLife: { action: "bond", place: "kitchen", manner: "warm", truthful: true, stretch: 0, ...(seenBy.length ? { seenBy } : {}) },
  });
}

const active = (w: unknown): string[] => bag(w).sb!.session.livingIds();
/** The duo read of `a` (their strongest mutual bond, not counting the HOH) as the HOH perceives it, and as it truly is. */
function duo(w: unknown, perceived: boolean): number {
  const b = bag(w);
  const s = seam(w);
  return duoRead(b.a!, b.hoh!, active(w), s.rel, perceived ? (f, t) => s.perceivedBond(b.hoh!, f, t) : undefined);
}

Given("a played season where two houseguests are close, but only ever bond where the HOH cannot see", function () {
  played(this); setPair(this, CLOSE);
  const b = bag(this);
  for (let i = 0; i < 4; i++) bondingScene(this, [b.a!, b.b!], [b.others![0]!]); // a bystander sees them, never the HOH
});
Given("a played season where two houseguests barely know each other", function () { played(this); setPair(this, (BASE.trust + BASE.affinity) / 2); });
Given("a played season where one houseguest is secretly close to another", function () { played(this); setPair(this, CLOSE); });

When("the HOH reads who is a duo", function () { /* the read is taken in the Then steps */ });
When("the HOH reads who is a floater", function () { /* the read is taken in the Then step */ });
When("the HOH watches them bond from the same room, without taking part", function () {
  const b = bag(this);
  for (let i = 0; i < 4; i++) bondingScene(this, [b.a!, b.b!], [b.hoh!]);
});
When("the HOH comes to believe they have a final two", function () {
  const b = bag(this); const live = seam(this).live;
  recordClaim((live.beliefs ??= {}), { holder: b.hoh!, kind: "allied-with", subject: b.a!, object: b.b!, value: true, origin: "told", source: b.others![0]!, confidence: 0.9, week: live.week });
});

Then("the HOH reads them as less of a pair than they are", function () {
  const seen = duo(this, true), truth = duo(this, false);
  assert.ok(seen < truth, `the HOH read the pair at ${seen}, the truth is ${truth}`);
});
Then("with perceived bonds off, the HOH reads the hidden truth", function () {
  const s = seam(this);
  s.perceivedBondsEnabled = false;
  // off: the live season is handed no perceived read, so the nomination plan's floater and duo reads are the hidden truth
  const ctx = (bag(this).sb!.session as unknown as { ctx(): { perceivedBondFor?: unknown } }).ctx();
  assert.equal(ctx.perceivedBondFor, undefined, "perceived bonds off, but the season was still handed the perceived read");
  s.perceivedBondsEnabled = true;
  assert.equal(typeof (bag(this).sb!.session as unknown as { ctx(): { perceivedBondFor?: unknown } }).ctx().perceivedBondFor, "function", "perceived bonds on, but the season was not handed the read");
});
Then("the HOH reads them as more of a pair than they are", function () {
  const seen = duo(this, true), truth = duo(this, false);
  assert.ok(seen > truth, `the HOH read the pair at ${seen}, the truth is ${truth}`);
});
Then("the HOH sees that houseguest as more of a floater than they are", function () {
  const b = bag(this); const s = seam(this);
  const seen = floaterRead(b.a!, active(this), s.rel, (f, t) => s.perceivedBond(b.hoh!, f, t));
  const truth = floaterRead(b.a!, active(this), s.rel);
  assert.ok(seen > truth, `the HOH read them as a floater at ${seen}, the truth is ${truth}`);
});
