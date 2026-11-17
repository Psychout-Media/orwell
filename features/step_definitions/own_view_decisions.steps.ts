import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER, type EntityId } from "../../src/domain/ids";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { ARCHETYPE_AGGRESSION } from "../../src/engine/campaigns";
import { nominationPlan, politicalTemperature } from "../../src/engine/season";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { Pitch } from "../../src/engine/lobbying";
import type { DecisionWhy } from "../../src/engine/decisionWhy";

/**
 * Feature 0190 - NPC decisions read the decider's own view (ORW-574). Drives the REAL adapter through a registry sandbox. TEST-ONLY seams: the live season,
 * the relationship model and the adapter's private decision reads named in `Seam`. Roles only.
 */
type Seam = {
  live: { playedGame?: boolean; beliefs?: BeliefStore; week: number; nominees?: EntityId[]; hoh?: EntityId; resume?: Record<EntityId, number> };
  rel: RelationshipModel;
  house: { npcs: Array<{ id: EntityId; character: { archetype: string; stats: { physical: number; mental: number } } }> };
  ctx(): SeasonCtx;
  setOwnViewEnabled(on: boolean): void;
  deriveCompIntent(id: EntityId, field: readonly EntityId[]): string;
  hcStrategyFor(candidate: EntityId, holder: EntityId): number;
  derivePitches(holder: EntityId): Pitch[];
  voteStillInDoubt(actor: EntityId, target: EntityId): boolean;
  finalHohMindChoice(hoh: EntityId, rivals: readonly EntityId[], jury: readonly EntityId[], why?: (w: Omit<DecisionWhy, "by" | "week">) => void): EntityId | undefined;
  perceivedBond(holder: EntityId, from: EntityId, to: EntityId): number;
};
type Bag = { sb?: UserSandbox; npcs?: EntityId[]; seen?: unknown; seen2?: unknown; sbs?: UserSandbox[] };
const B = RELATIONSHIP_CONSTANTS.baseline;
const bag = (w: unknown): Bag => ((w as { ov0190?: Bag }).ov0190 ??= {});
const seam = (w: unknown): Seam => bag(w).sb!.session as unknown as Seam;
let n = 0, seq = 0;

function season(playedGame = true, seed = 21): { sb: UserSandbox; npcs: EntityId[] } {
  const sb = new GameSessionRegistry().sandboxFor(`ov0190-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as Seam;
  s.live.playedGame = playedGame; s.live.beliefs = {}; s.live.resume = {};
  const all = sb.session.livingIds();
  for (const x of all) for (const y of all) if (x !== y) Object.assign(s.rel.edge(x, y), { trust: B.trust, affinity: B.affinity, threat: B.threat, reliability: B.reliability });
  return { sb, npcs: all.filter((id) => id !== PLAYER) };
}
function scene(w: unknown, type: string, pair: [EntityId, EntityId], seenBy: EntityId[]): void {
  bag(w).sb!.engine.events.record({
    id: `ov0190-scene-${seq++}`, ts: 1000 + seq, type, initiator: pair[0], witnessSet: [...pair], hidden: !pair.includes(PLAYER), content: "they talk",
    houseLife: { action: "talk", place: "kitchen", manner: "warm", truthful: true, stretch: 0, seenBy },
  });
}
function believe(w: unknown, holder: EntityId, kind: "targets-me" | "assured-me", subject: EntityId): void {
  const s = seam(w);
  recordClaim((s.live.beliefs ??= {}), { holder, kind, subject, ...(kind === "targets-me" ? { object: holder } : {}), value: true, origin: "told", confidence: 0.95, week: s.live.week });
}
const npcs = (w: unknown): EntityId[] => bag(w).npcs!;
const cautious = (w: unknown): EntityId => npcs(w).find((id) => (ARCHETYPE_AGGRESSION[seam(w).house.npcs.find((h) => h.id === id)!.character.archetype] ?? 0.5) < 0.55)!;
const field = (w: unknown, me: EntityId): EntityId[] => [me, ...npcs(w).filter((id) => id !== me).slice(0, 3), PLAYER];
const termOf = (why: Omit<DecisionWhy, "by" | "week"> | undefined, option: string, name: string): number => why!.options.find((o) => o.option === option)!.terms.find(([nm]) => nm === name)?.[1] ?? 0;

Given("own view: a played season with a quiet house", function () { const g = season(); Object.assign(bag(this), g); });

// 1. comp intent
When("own view: every rival secretly reads a cautious houseguest as a huge threat", function () {
  const me = cautious(this), f = field(this, me), s = seam(this);
  bag(this).seen = [me, s.deriveCompIntent(me, f)];
  for (const o of f) if (o !== me) s.rel.edge(o, me).threat = 0.98;
});
Then("own view: their comp intent has not changed", function () {
  const [me, before] = bag(this).seen as [EntityId, string];
  assert.equal(seam(this).deriveCompIntent(me, field(this, me)), before);
});
Then("own view: it changes once the house watches them win and they believe someone targets them", function () {
  const [me, before] = bag(this).seen as [EntityId, string];
  const s = seam(this), f = field(this, me);
  s.live.resume![me] = 3; believe(this, me, "targets-me", f[1]!);
  assert.notEqual(s.deriveCompIntent(me, f), before);
});

// 2. Houseguest's Choice
When("own view: a candidate secretly trusts the nominee and is secretly a comp monster", function () {
  const [holder, other, candidate, hoh] = npcs(this), s = seam(this);
  s.live.nominees = [holder!, other!]; s.live.hoh = hoh!;
  bag(this).seen = [holder, candidate, s.hcStrategyFor(candidate!, holder!)];
  s.rel.edge(candidate!, holder!).trust = 0.99;
  Object.assign(s.house.npcs.find((h) => h.id === candidate)!.character.stats, { physical: 0.99, mental: 0.99 });
});
Then("own view: the nominee's pick strategy has not changed", function () {
  const [holder, candidate, before] = bag(this).seen as [EntityId, EntityId, number];
  assert.equal(seam(this).hcStrategyFor(candidate, holder), before);
});
Then("own view: it changes once the nominee trusts the candidate themselves", function () {
  const [holder, candidate, before] = bag(this).seen as [EntityId, EntityId, number];
  const s = seam(this); s.rel.edge(holder, candidate).trust = 0.95;
  assert.ok(s.hcStrategyFor(candidate, holder) > before);
});

// 3. nomination tactic + pitch strength
When("own view: the whole house secretly fears one houseguest", function () {
  const [hoh] = npcs(this), s = seam(this), active = [PLAYER, ...npcs(this)];
  const pitcher = s.derivePitches(hoh!)[0]!.from;
  const subject = npcs(this).find((x) => x !== hoh && x !== pitcher)!;
  bag(this).seen = [hoh, pitcher, s.derivePitches(hoh!).find((p) => p.from === pitcher)!.strength];
  for (const r of active) if (r !== subject && r !== hoh) s.rel.edge(r, subject).threat = 1;
});
Then("own view: the week is not a runaway week for the HOH", function () {
  const [hoh] = bag(this).seen as [EntityId], s = seam(this), active = [PLAYER, ...npcs(this)];
  const threatOf = (f: EntityId, t: EntityId) => s.ctx().perceivedThreatFor!(hoh, f, t);
  assert.equal(politicalTemperature(active, s.rel).runaway, true, "the hidden read would call a runaway");
  assert.equal(politicalTemperature(active, s.rel, threatOf).runaway, false);
  assert.ok(nominationPlan(hoh, active, s.rel, { disposition: "bond", threatOf }));
});
Then("own view: a pitch's strength has not moved with the HOH's hidden read of the pitcher", function () {
  const [hoh, pitcher, before] = bag(this).seen as [EntityId, EntityId, number];
  seam(this).rel.edge(hoh, pitcher).threat = 0.95; // the HOH's hidden read of the pitcher
  assert.equal(seam(this).derivePitches(hoh).find((p) => p.from === pitcher)!.strength, before);
});

// 4. vote
function voteTerms(w: unknown): { jury: number; target: EntityId | undefined } {
  const [voter, a, b, hoh] = npcs(w); let why: Omit<DecisionWhy, "by" | "week"> | undefined;
  voteChoice(voter!, [a!, b!], seam(w).ctx(), [], hoh, (x) => { why = x; });
  const target = why!.options.find((o) => (o.terms.find(([nm]) => nm === "hoh-referendum")?.[1] ?? 0) !== 0)?.option;
  return { jury: termOf(why, a!, "jury-management"), target };
}
When("own view: a nominee secretly trusts the voter and the HOH secretly fears the other nominee", function () {
  const [voter, a, b, hoh] = npcs(this), s = seam(this);
  Object.assign(s.rel.edge(voter!, hoh!), { trust: 0.9, affinity: 0.9 });
  bag(this).seen = voteTerms(this);
  s.rel.edge(a!, voter!).trust = 0.99; s.rel.edge(hoh!, b!).threat = 1; s.rel.edge(hoh!, a!).threat = 0;
});
Then("own view: the voter's jury term and read of the HOH's target have not changed", function () {
  assert.deepEqual(voteTerms(this), bag(this).seen);
});
Then("own view: they change once the voter holds an assurance from the nominee", function () {
  const [voter, a] = npcs(this); believe(this, voter!, "assured-me", a!);
  assert.ok(voteTerms(this).jury < (bag(this).seen as { jury: number }).jury);
});

// 5. vote counting + final HOH
function odds(w: unknown): number[] {
  const [hoh, r1, r2, ...rest] = npcs(w); let why: Omit<DecisionWhy, "by" | "week"> | undefined;
  seam(w).finalHohMindChoice(hoh!, [r1!, r2!], rest.slice(0, 5), (x) => { why = x; });
  return [...why!.options].sort((x, y) => x.option.localeCompare(y.option)).map((o) => o.terms.find(([nm]) => nm === "jury-odds")?.[1] ?? 0);
}
const watchBonds = (w: unknown): void => {
  const [hoh, r1, , ...rest] = npcs(w); const actor = npcs(w)[0]!, target = npcs(w)[1]!;
  void hoh;
  for (const j of rest.slice(0, 5)) for (let i = 0; i < 4; i++) scene(w, "bonding", [r1!, j], [hoh!]);
  for (const v of [PLAYER, ...npcs(w)].filter((x) => x !== actor && x !== target)) for (let i = 0; i < 4; i++) scene(w, "bonding", [v, target], [actor]);
};
When("own view: the voters and a rival secretly grow close to the target", function () {
  const [actor, target, , ...rest] = npcs(this), s = seam(this), r1 = npcs(this)[1]!;
  void target;
  const voters = [PLAYER, ...npcs(this)].filter((v) => v !== actor && v !== npcs(this)[1]);
  for (const v of voters) Object.assign(s.rel.edge(v, npcs(this)[1]!), { threat: 1, trust: 0 });
  bag(this).seen = [s.voteStillInDoubt(actor!, npcs(this)[1]!), odds(this)];
  for (const v of voters) Object.assign(s.rel.edge(v, npcs(this)[1]!), { threat: 0.0625, trust: 0.25 });
  for (const j of rest.slice(0, 5)) Object.assign(s.rel.edge(r1, j), { trust: 0.99, affinity: 0.99 });
});
Then("own view: the actor's count and the final HOH's estimate have not changed", function () {
  const [count, o] = bag(this).seen as [boolean, number[]];
  assert.equal(seam(this).voteStillInDoubt(npcs(this)[0]!, npcs(this)[1]!), count);
  assert.deepEqual(odds(this), o);
});
Then("own view: they change once the actor watches those bonds", function () {
  const [, o] = bag(this).seen as [boolean, number[]];
  watchBonds(this);
  assert.notDeepEqual(odds(this), o);
});

// 6. floater/duo
When("own view: a pair becomes secretly close out of the decider's sight", function () {
  const [holder, a, b] = npcs(this), s = seam(this);
  bag(this).seen = s.perceivedBond(holder!, a!, b!);
  for (const [x, y] of [[a!, b!], [b!, a!]]) Object.assign(s.rel.edge(x, y), { trust: 0.95, affinity: 0.95 });
});
Then("own view: the decider still reads them as strangers", function () {
  const [holder, a, b] = npcs(this);
  assert.equal(seam(this).perceivedBond(holder!, a!, b!), bag(this).seen);
});
Then("own view: a scene the decider watches changes the read", function () {
  const [holder, a, b] = npcs(this);
  scene(this, "bonding", [a!, b!], [holder!]);
  assert.ok(seam(this).perceivedBond(holder!, a!, b!) > (bag(this).seen as number));
});

// 7. flag off / headless / no leak
Then("own view: with the flag off the comp intent follows the hidden read", function () {
  const s = seam(this), me = cautious(this), f = field(this, me);
  s.setOwnViewEnabled(false);
  assert.equal(s.ctx().perceivedThreatFor, undefined);
  s.rel.edge(f[1]!, me).threat = 0.98;
  assert.equal(s.deriveCompIntent(me, f), "play-safe");
  s.setOwnViewEnabled(true);
});
Then("own view: a headless game carries no perceived reads", function () {
  const g = season(false); Object.assign(bag(this), g);
  const s = seam(this);
  assert.equal(s.ctx().perceivedTrustFor, undefined);
  assert.equal(s.ctx().perceivedThreatFor, undefined);
});
Then("own view: no player view carries the perceived-state internals", function () {
  const { sb } = season();
  const views = [JSON.stringify(sb.session.whereabouts()), JSON.stringify(sb.session.dailyRecap()), JSON.stringify(sb.session.advanceGame()), JSON.stringify(sb.session.advanceGame())];
  for (const v of views) assert.doesNotMatch(v, /perceived(Trust|Threat|Bond)|publicMenace|publicStrength|seenBy|ownView/);
});

// 8. determinism
function trace(sb: UserSandbox): string {
  return JSON.stringify([sb.session.advanceGame(), sb.session.advanceGame(), sb.session.advanceGame()]);
}
Given("own view: two played seasons from one seed", function () {
  const a = season(true, 33), b = season(true, 33);
  bag(this).sbs = [a.sb, b.sb];
});
Then("own view: the same turns give the same result", function () {
  const [a, b] = bag(this).sbs!;
  assert.equal(trace(a!), trace(b!));
});
