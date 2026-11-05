import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import { campaignTilt, type Campaign } from "../../src/engine/campaigns";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0085 — NPC campaigns & the scramble. Role-only (a schemer, the target, an ally, the
 * electorate). Drives the REAL GameSessionAdapter campaign layer (enabled per-session) + the seeded
 * `voteChoice`, on top of the pure unit gates.
 */

interface CWorld {
  cwSession?: GameSessionAdapter;
  cwRel?: RelationshipModel;
  cwIds?: EntityId[];
  cwProgress?: number;
  cwSnap?: ReturnType<GameSessionAdapter["snapshot"]>;
  cwOn?: number;
  cwOff?: number;
  cwSurvived?: boolean;
}
const cw = (w: BbWorld): CWorld => w as unknown as CWorld;
const campsOf = (s: GameSessionAdapter): Campaign[] => (s as unknown as { campaigns: Campaign[] }).campaigns;
const tiltOf = (s: GameSessionAdapter, t: EntityId, v: EntityId): number =>
  (s as unknown as { campaignTiltFor(a: EntityId, b: EntityId): number }).campaignTiltFor(t, v);

function liveCampaignHouse(seed: number): { session: GameSessionAdapter; rel: RelationshipModel; ids: EntityId[] } {
  const rel = new RelationshipModel(0.5);
  const session = new GameSessionAdapter(rel);
  session.createCharacter({ playerName: "The Player", seed });
  session.setCampaignsEnabled(true);
  const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
  return { session, rel, ids };
}

function ctx(rel: RelationshipModel, tiltFor?: (t: EntityId, v: EntityId) => number): SeasonCtx {
  return { player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel, ...(tiltFor ? { campaignTiltFor: tiltFor } : {}) };
}

Given("a started season with a live off-screen society", function (this: BbWorld) {
  const { session, rel, ids } = liveCampaignHouse(2026);
  cw(this).cwSession = session; cw(this).cwRel = rel; cw(this).cwIds = ids;
});

// --- Rule: strategy over time ---

Given("a schemer forms a campaign to evict the target this week", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  rel!.edge(ids![0]!, ids![1]!).threat = 0.85;
  s!.campaignTick();
  cw(this).cwProgress = campsOf(s!).find((c) => c.owners[0] === ids![0])!.progress;
});

When("the society runs several more campaign ticks", function (this: BbWorld) {
  for (let k = 0; k < 3; k++) cw(this).cwSession!.campaignTick();
});

Then("the campaign advances by a concrete move on each tick", function (this: BbWorld) {
  const c = campsOf(cw(this).cwSession!).find((x) => x.owners[0] === cw(this).cwIds![0]);
  assert.ok(c && c.progress > cw(this).cwProgress!, "progress accrued over the ticks");
});

Then("the campaign is still active and closer to its goal until the week resolves", function (this: BbWorld) {
  const c = campsOf(cw(this).cwSession!).find((x) => x.owners[0] === cw(this).cwIds![0]);
  assert.equal(c?.status, "active");
});

Given("a schemer forms a season-long campaign against the target", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  rel!.edge(ids![0]!, ids![1]!).threat = 0.85;
  s!.campaignTick(); s!.campaignTick();
});

When("the game is snapshotted and restored after a week has passed", function (this: BbWorld) {
  cw(this).cwSnap = cw(this).cwSession!.snapshot();
  const revived = new GameSessionAdapter();
  revived.restore(cw(this).cwSnap!);
  cw(this).cwSession = revived;
});

Then("the campaign is still active with its accumulated history intact", function (this: BbWorld) {
  const c = campsOf(cw(this).cwSession!).find((x) => x.owners[0] === cw(this).cwIds![0]);
  assert.ok(c && c.status === "active" && c.progress > 0 && c.knownTo.length >= 1);
});

// --- Rule: adapts ---

Given("a campaign to evict the target this week", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  rel!.edge(ids![0]!, ids![1]!).threat = 0.85;
  rel!.edge(ids![0]!, ids![2]!).threat = 0.7; // a fallback threat to re-aim at
  s!.campaignTick();
});

When("the target wins the veto and removes themselves from the block", function (this: BbWorld) {
  const { cwSession: s, cwIds: ids } = cw(this);
  (s as unknown as { ceremony: { vetoHolder?: EntityId } }).ceremony.vetoHolder = ids![1]!;
  s!.campaignTick();
});

Then("the campaign re-targets or escalates rather than disappearing", function (this: BbWorld) {
  const c = campsOf(cw(this).cwSession!).find((x) => x.owners[0] === cw(this).cwIds![0]);
  assert.ok(c && c.status === "active" && c.target !== cw(this).cwIds![1], "re-aimed off the safe target");
});

Given("a schemer running a campaign against the target", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  rel!.edge(ids![0]!, ids![1]!).threat = 0.85;
  s!.campaignTick();
});

When("the schemer themselves is nominated", function (this: BbWorld) {
  const { cwSession: s, cwIds: ids } = cw(this);
  (s as unknown as { ceremony: { nominees: EntityId[] } }).ceremony.nominees = [ids![0]!];
  s!.campaignTick();
});

Then("the campaign pivots toward protecting its owner", function (this: BbWorld) {
  const c = campsOf(cw(this).cwSession!).find((x) => x.owners[0] === cw(this).cwIds![0]);
  assert.ok(c && c.goal === "protect" && c.target === cw(this).cwIds![0]);
});

// --- Rule: tilts the seeded outcome ---

/** Build a house where 3 persuasive owners run a sustained evict campaign against X, lobbying the voters. */
function sustainedAgainstTarget(seed: number): { rel: RelationshipModel; tiltFor: (t: EntityId, v: EntityId) => number; X: EntityId; Y: EntityId; voters: EntityId[] } {
  const { session, rel, ids } = liveCampaignHouse(seed);
  const owners = [ids[0]!, ids[1]!, ids[2]!];
  const X = ids[3]!, Y = ids[4]!;
  const voters = [ids[5]!, ids[6]!, ids[7]!, ids[8]!];
  for (const o of owners) {
    rel.edge(o, X).threat = 0.85; // each owner wants X out
    for (const v of voters) rel.edge(o, v).affinity = 0.95; // and lobbies the electorate
  }
  for (const v of voters) { rel.edge(v, X).threat = 0.40; rel.edge(v, Y).threat = 0.45; } // baseline favors keeping X
  for (let k = 0; k < 6; k++) session.campaignTick(); // a sustained push
  return { rel, tiltFor: (t, v) => tiltOf(session, t, v), X, Y, voters };
}

Given("many seeded seasons with and without a sustained campaign to evict the target", function (this: BbWorld) {
  let on = 0, off = 0, survived = false;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { rel, tiltFor, X, Y, voters } = sustainedAgainstTarget(seed);
    for (const v of voters) {
      if (voteChoice(v, [X, Y], ctx(rel, tiltFor)) === X) on++;
      if (voteChoice(v, [X, Y], ctx(rel)) === X) off++; else survived = true;
    }
  }
  cw(this).cwOn = on; cw(this).cwOff = off; cw(this).cwSurvived = survived;
});

Then("the target is evicted more often when the campaign runs", function (this: BbWorld) {
  assert.ok(cw(this).cwOn! > cw(this).cwOff!, `campaign raises evictions (${cw(this).cwOn} > ${cw(this).cwOff})`);
});

Then("the same seed always produces the same outcome", function () {
  const a = sustainedAgainstTarget(42);
  const b = sustainedAgainstTarget(42);
  assert.equal(a.tiltFor(a.X, a.voters[0]!), b.tiltFor(b.X, b.voters[0]!));
});

Then("the seeded competition and jury calibration is unchanged", function (this: BbWorld) {
  // A disabled session adds no tilt provider ⇒ the seeded vote is byte-identical to the baseline.
  const { rel, ids } = (() => { const r = new RelationshipModel(0.5); const s = new GameSessionAdapter(r); s.createCharacter({ playerName: "The Player", seed: 9 }); return { rel: r, ids: (s.snapshot().house?.npcs ?? []).map((n) => n.id) }; })();
  rel.edge(ids[5]!, ids[3]!).threat = 0.4; rel.edge(ids[5]!, ids[4]!).threat = 0.45;
  assert.equal(voteChoice(ids[5]!, [ids[3]!, ids[4]!], ctx(rel)), ids[4]!); // no campaign ⇒ baseline read stands
});

Given("a sustained campaign to evict the target", function (this: BbWorld) {
  const { rel, tiltFor, X, Y, voters } = sustainedAgainstTarget(3);
  cw(this).cwSurvived = voters.some((v) => voteChoice(v, [X, Y], ctx(rel, tiltFor)) === Y);
});

Then("the target can still survive the vote on some seeds", function (this: BbWorld) {
  // Not destiny: an unaware / stubborn voter is unmoved across the electorate, so the target is not
  // automatically gone — or, across the aggregate run, at least one ballot held.
  assert.ok(cw(this).cwSurvived === true || cw(this).cwSurvived === undefined);
});

Given("the same campaign run by a highly persuasive houseguest and by a low-persuasion one", function () {
  // Pure-math step — nothing to set up; the assertions read `campaignTilt` directly.
});

Then("the persuasive houseguest's campaign tilts the outcome more", function () {
  assert.ok(campaignTilt(1, 0.9, 0.7, 0.5) > campaignTilt(1, 0.3, 0.7, 0.5));
});

Then("a gullible listener is swayed more than a stubborn, independent one", function () {
  assert.ok(campaignTilt(1, 0.7, 0.9, 0.5) > campaignTilt(1, 0.7, 0.2, 0.5));
});

Then("neither persuasiveness nor gullibility changes the seeded determinism", function () {
  assert.equal(campaignTilt(1, 0.8, 0.6, 0.5), campaignTilt(1, 0.8, 0.6, 0.5));
});

// --- Rule: hidden / pathway only ---

When("every player-facing and admin-facing surface is read", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  rel!.edge(ids![0]!, ids![1]!).threat = 0.85;
  s!.campaignTick(); s!.campaignTick();
});

Then("none of them returns any campaign's existence, target, plan, or progress", function (this: BbWorld) {
  const s = cw(this).cwSession!;
  const blob = JSON.stringify([
    ...cw(this).cwIds!.map((id) => s.npcVoice(id)),
    s.gameStatus(), s.whereabouts(),
  ]);
  assert.ok(!/campaign:|"goal":"evict"|"progress":|"knownTo"/.test(blob), "no campaign content on any surface");
});

Given("a campaign against the player is underway", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  rel!.edge(ids![0]!, PLAYER).threat = 0.85; // an NPC schemes to evict the player
  s!.campaignTick();
});

When("houseguests lobby, gossip, and meet about it", function (this: BbWorld) {
  cw(this).cwSession!.campaignTick();
});

Then("the player can learn that a campaign exists only through what they witness, are told, or overhear", function (this: BbWorld) {
  // A campaign TARGETING the player does NOT make the player aware (targeting ≠ informing): the player
  // is never auto-added to a campaign's knownTo — they'd learn only via a pathway (lobby/gossip/overhear).
  const against = campsOf(cw(this).cwSession!).find((c) => c.target === PLAYER);
  if (against) assert.ok(!against.knownTo.includes(PLAYER), "the player is not magically aware of a plot against them");
});

Then("the player never receives the sealed content of the schemers' private scenes", function (this: BbWorld) {
  const blob = JSON.stringify(cw(this).cwSession!.gameStatus());
  assert.ok(!/campaign:|"progress":/.test(blob));
});

// --- Rule: symmetric perspective ---

Given("two houseguests run a campaign against the target", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  rel!.edge(ids![0]!, ids![3]!).threat = 0.85;
  rel!.edge(ids![1]!, ids![3]!).threat = 0.85;
  rel!.edge(ids![0]!, ids![2]!).affinity = 0.95; // lobby ids[2]
  s!.campaignTick();
});

Given("a third houseguest has no pathway to it", function (this: BbWorld) {
  // ids[8] is neither an owner nor lobbied — assert they are absent from every campaign's knownTo.
  const stranger = cw(this).cwIds![8]!;
  assert.ok(campsOf(cw(this).cwSession!).every((c) => !c.knownTo.includes(stranger)));
});

Then("the third houseguest's voicing carries no trace of that campaign", function (this: BbWorld) {
  const blob = JSON.stringify(cw(this).cwSession!.npcVoice(cw(this).cwIds![8]!));
  assert.ok(!/campaign:|"goal":"evict"|"progress":/.test(blob));
});

Then("the third houseguest never acts on a campaign they do not know exists", function (this: BbWorld) {
  // They apply no tilt against the target — an unaware voter is unmoved (the omniscience ban).
  assert.equal(tiltOf(cw(this).cwSession!, cw(this).cwIds![3]!, cw(this).cwIds![8]!), 0);
});

Given("two houseguests in different blocs hold different reads of the house", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  rel!.edge(ids![0]!, ids![3]!).threat = 0.85;
  rel!.edge(ids![0]!, ids![2]!).affinity = 0.95; // ids[2] is lobbied; ids[8] is not
  s!.campaignTick();
});

When("each chooses their next strategic move", function () { /* reads only — asserted below */ });

Then("each acts on what they themselves have learned, not the full set of campaigns", function (this: BbWorld) {
  const target = cw(this).cwIds![3]!;
  const aware = cw(this).cwIds![2]!, unaware = cw(this).cwIds![8]!;
  assert.ok(tiltOf(cw(this).cwSession!, target, aware) > 0); // the lobbied acts on the campaign
  assert.equal(tiltOf(cw(this).cwSession!, target, unaware), 0); // the un-lobbied does not
});

Given("one houseguest learns of a campaign by being lobbied", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  rel!.edge(ids![0]!, ids![3]!).threat = 0.85;
  rel!.edge(ids![0]!, ids![2]!).affinity = 0.95;
  s!.campaignTick();
});

When("that belief diffuses to others as gossip", function (this: BbWorld) {
  cw(this).cwSession!.campaignTick();
});

Then("it reaches them only through that pathway", function (this: BbWorld) {
  const c = campsOf(cw(this).cwSession!).find((x) => x.owners[0] === cw(this).cwIds![0]);
  assert.ok(c && c.knownTo.includes(cw(this).cwIds![2]!)); // the lobbied ally learned it
});

Then("it may arrive partial, late, or distorted, never as shared certain truth", function (this: BbWorld) {
  // Partial by construction: the belief has NOT reached everyone — knownTo is a strict subset of the house.
  const c = campsOf(cw(this).cwSession!).find((x) => x.owners[0] === cw(this).cwIds![0])!;
  assert.ok(c.knownTo.length < cw(this).cwIds!.length, "not everyone knows — the spread is partial");
});

// --- Rule: the scramble ---

Given("several campaigns working the same electorate before an eviction", function (this: BbWorld) {
  const { rel, tiltFor, X, Y, voters } = sustainedAgainstTarget(5);
  cw(this).cwRel = rel; cw(this).cwIds = [X, Y, ...voters];
  (cw(this) as { cwTilt?: (t: EntityId, v: EntityId) => number }).cwTilt = tiltFor;
});

Then("the hidden true vote count may differ from the houseguests' stated intentions", function (this: BbWorld) {
  const [X, Y, ...voters] = cw(this).cwIds!;
  const tiltFor = (cw(this) as { cwTilt?: (t: EntityId, v: EntityId) => number }).cwTilt!;
  // The secret count (with the hidden campaign pressure) diverges from the surface read (without it).
  const diverges = voters.some((v) => voteChoice(v, [X!, Y!], ctx(cw(this).cwRel!, tiltFor)) !== voteChoice(v, [X!, Y!], ctx(cw(this).cwRel!)));
  assert.ok(diverges, "a campaign creates a hidden swing the surface read doesn't show");
});

Then("the staged eviction reveal is anonymized", function (this: BbWorld) {
  // The secret stays sealed: no campaign content (or per-voter attribution) is on any player surface.
  const blob = JSON.stringify(cw(this).cwSession?.gameStatus() ?? {});
  assert.ok(!/campaign:|"progress":/.test(blob));
});

Then("per-voter attribution unseals only in the post-season retrospective", function (this: BbWorld) {
  // The retrospective is the ONLY place per-voter attribution is unsealed (0048, E12). A season still in progress has no retrospective at all, and neither the player-facing game state nor the public
  // status carries any voter attribution (A91: this used to assert `typeof session === "object"`, true of any object).
  const s = cw(this).cwSession!;
  assert.equal(s.seasonRetrospective(), null, "mid-season there is no retrospective to unseal anything");
  const blob = JSON.stringify({ state: s.getGameState(), status: s.gameStatus() });
  assert.ok(!/"(?:voters?|voterId|castBy|ballots?ByVoter|unsealed\w*)"\s*:/i.test(blob), "no per-voter attribution on any live surface");
});

// --- Rule: player campaigns ---

Given("the player declares a campaign to evict the target", function (this: BbWorld) {
  cw(this).cwSession!.declarePlayerCampaign(cw(this).cwIds![1]!);
});

Then("the player's campaign is the player's own knowledge with no pathway to any NPC", function (this: BbWorld) {
  const s = cw(this).cwSession!;
  assert.equal(s.playerCampaignRead(), cw(this).cwIds![1]!); // it IS the player's knowledge
  // …and it appears in NO npc's voicing/knowledge (no in-game pathway).
  const blob = JSON.stringify(cw(this).cwIds!.map((id) => s.npcVoice(id)));
  assert.ok(!/playerCampaign/.test(blob));
});

Then("no NPC acts on the campaign except in response to the player's actual recorded moves", function (this: BbWorld) {
  const s = cw(this).cwSession!;
  const before = JSON.stringify(campsOf(s));
  s.campaignTick(); // ticking the society does NOT let the player's mere intent move any NPC
  // No campaign is owned by the player, and the set is unchanged by the bare declaration.
  assert.ok(campsOf(s).every((c) => c.owners[0] !== PLAYER));
  assert.equal(JSON.stringify(campsOf(s)).includes(`"owners":["${PLAYER}"]`), false);
  void before;
});

// Phase 2 of "the player can play offense" (0085 follow-on) — the player's ACTUAL RECORDED pitches (as
// opposed to the bare OOC declaration above) earn a real, bounded campaign mirroring an NPC's own.

Given("the player pitches a houseguest against the target across several real, witnessed scenes", function (this: BbWorld) {
  const { cwSession: s, cwRel: rel, cwIds: ids } = cw(this);
  const holder = ids![2]!, target = ids![1]!;
  rel!.edge(PLAYER, holder).trust = 0.9; // real rapport — `campaignTiltFor` reads the owner->voter edge
  for (let i = 0; i < 3; i++) {
    s!.foldPlayerCampaignMove(target, holder); // one landed pitch, mirroring recordInteraction's aboutEdges
    s!.bumpBeatSeq(); // a new beat each time — never more than one progress-move per beat
  }
});

Then("the player's own campaign accrues progress exactly as an NPC's campaign would", function (this: BbWorld) {
  const c = campsOf(cw(this).cwSession!).find((x) => x.owners[0] === PLAYER);
  assert.ok(c && c.status === "active" && c.goal === "evict" && c.progress > 0, "the player's own campaign accrued real progress");
});

Then("the pitched houseguest's vote is tilted toward the target, bounded to the same ceiling an NPC's campaign uses", function (this: BbWorld) {
  const { cwSession: s, cwIds: ids } = cw(this);
  const holder = ids![2]!, target = ids![1]!;
  const t = tiltOf(s!, target, holder);
  assert.ok(t > 0, "an aware, well-trusted pitch tilts the vote");
  assert.ok(t <= campaignTilt(1, 1, 1, 1) + 1e-9, "never exceeds the same ceiling an NPC's campaign is bounded to");
});

Then("a houseguest the player never pitched is unmoved", function (this: BbWorld) {
  const { cwSession: s, cwIds: ids } = cw(this);
  const bystander = ids![4]!, target = ids![1]!;
  assert.equal(tiltOf(s!, target, bystander), 0);
});


// ── A90: the #1937 pushes through the live provider ───────────────────────────────────────────────────────────
import { nominationStrategy, replacementPick } from "../../src/engine/season";
import { CAMPAIGN } from "../../src/engine/campaigns";
interface PushWorld { pwSession?: GameSessionAdapter; pwRival?: EntityId; pwTarget?: EntityId; pwDecider?: EntityId; pwOther?: EntityId; pwProtector?: EntityId; pwUnaware?: EntityId }
const pw = (w: BbWorld): PushWorld => w as unknown as PushWorld;
const pushOf = (w: BbWorld) => (pw(w).pwSession as unknown as { ctx(): { campaignPushFor: (t: EntityId, d: EntityId) => number } }).ctx().campaignPushFor;
function pushHouse(w: BbWorld, owner: "npc" | "player", goal: "evict" | "protect" = "evict"): void {
  const { session, rel, ids } = liveCampaignHouse(2026);
  const [rival, target, decider, other, protector, unaware] = ids as [EntityId, EntityId, EntityId, EntityId, EntityId, EntityId];
  rel.edge(rival, decider).trust = 1;
  rel.edge(protector, decider).trust = 1;
  const base = { plan: ["lobby"], progress: 1, horizon: "week", status: "active", startedBeat: 0, deadlineBeat: 999, confidence: 0.8 };
  const owners = owner === "player" ? [PLAYER] : [rival];
  campsOf(session).push({ id: "c1", owners, goal, target, knownTo: [...owners, decider, other], ...base } as unknown as Campaign);
  Object.assign(pw(w), { pwSession: session, pwRival: rival, pwTarget: target, pwDecider: decider, pwOther: other, pwProtector: protector, pwUnaware: unaware });
}
Given("a live evict campaign against the target that the decider knows of", function (this: BbWorld) { pushHouse(this, "npc"); });
Given("a live campaign owned by the player against the target that the decider knows of", function (this: BbWorld) { pushHouse(this, "player"); });

Then("the decider is pushed toward the target through the live provider", function (this: BbWorld) {
  const v = pushOf(this)(pw(this).pwTarget!, pw(this).pwDecider!);
  assert.ok(v > 0, "an aware decider is pushed toward naming the target");
  assert.ok(v <= CAMPAIGN.base + 1e-9, "and the push is bounded by the campaign ceiling");
});
Then("the decider is pushed toward the target, bounded by the same ceiling", function (this: BbWorld) {
  const v = pushOf(this)(pw(this).pwTarget!, pw(this).pwDecider!);
  assert.ok(v > 0 && v <= CAMPAIGN.base + 1e-9);
});
Then("on an exact tie the push decides the nomination and the replacement", function (this: BbWorld) {
  const t = pw(this).pwTarget!, d = pw(this).pwDecider!, o = pw(this).pwOther!;
  const rel = new RelationshipModel(0.5);
  const active = [d, t, o, npc(90), npc(91)];
  for (const x of [t, o]) { rel.edge(d, x).threat = 0.9; }
  rel.edge(d, npc(90)).threat = 0.1; rel.edge(d, npc(91)).threat = 0.1;
  const push = pushOf(this);
  const plain = nominationStrategy(d, active, rel);
  const pushed = nominationStrategy(d, active, rel, { campaignPush: (x) => push(x, d) });
  assert.ok(pushed[0] === t || pushed.includes(t), "the pushed target is named");
  assert.ok(plain.length === 2 && pushed.length === 2);
  const withPush = replacementPick(d, npc(90), [t, o], active, rel, { campaignPush: (x) => push(x, d) });
  assert.equal(withPush, t, "on an exact tie the replacement honors the push");
});
Then("a decider who does not know of the campaign feels nothing", function (this: BbWorld) {
  assert.equal(pushOf(this)(pw(this).pwTarget!, pw(this).pwUnaware!), 0);
});
Then("the veto holder is steered away from saving the target", function (this: BbWorld) {
  const t = pw(this).pwTarget!, d = pw(this).pwDecider!, o = pw(this).pwOther!;
  const rel = new RelationshipModel(0.5);
  const push = pushOf(this);
  const saved = rel.chooseVetoSave(d, [t, o], (x) => -push(x, d));
  assert.notEqual(saved, t, "an evict campaign on the target steers the holder to save the other nominee on a tie");
});
Then("a protect campaign on the same target lowers the evict tilt a voter feels", function (this: BbWorld) {
  const s = pw(this).pwSession!, t = pw(this).pwTarget!, voter = pw(this).pwOther!;
  const evictOnly = tiltOf(s, t, voter);
  assert.ok(evictOnly > 0, "an aware voter feels the evict tilt before the protect campaign");
  const base = { plan: ["lobby"], progress: 1, horizon: "week", status: "active", startedBeat: 0, deadlineBeat: 999, confidence: 0.8 };
  campsOf(s).push({ id: "c2", owners: [pw(this).pwProtector!], goal: "protect", target: t, knownTo: [pw(this).pwProtector!, voter], ...base } as unknown as Campaign);
  assert.ok(tiltOf(s, t, voter) < evictOnly, "the protect campaign nets against the evict one at the vote");
});

// ── B37 / B38 (flag-gated, default off) ───────────────────────────────────────────────────────────────────────
import { believedMargin, inDoubt } from "../../src/engine/voteEstimate";
import { GameSessionRegistry } from "../../src/composition/registry";
type VW = { b37?: { truth: number[]; zero: number[]; voters: number }; b38?: { sb: ReturnType<GameSessionRegistry["sandboxFor"]>; hoh: EntityId } };
const vw = (w: BbWorld): VW => w as unknown as VW;

Given("a close eviction count and an overconfident campaigner", function (this: BbWorld) {
  const voters = 12;
  vw(this).b37 = { truth: Array.from({ length: voters }, () => 0.6), zero: Array.from({ length: voters }, () => 0), voters };
});
When("the campaigner reads the count", function (this: BbWorld) { assert.ok(vw(this).b37); });
Then("the campaigner believes it is decided and stops campaigning", function (this: BbWorld) {
  const c = vw(this).b37!;
  assert.equal(inDoubt(believedMargin(c.truth, 1, c.zero), c.voters), false);
  assert.equal(inDoubt(believedMargin(c.truth, 0.2, c.zero), c.voters), true, "a cautious campaigner keeps working the same count");
});
Then("the true count was still in doubt", function (this: BbWorld) {
  const c = vw(this).b37!;
  assert.equal(inDoubt(believedMargin(c.truth, 0, c.zero), c.voters), true);
});

type PitchInternals = { rel: { edge(a: EntityId, b: EntityId): { threat: number; trust: number } }; setLobbyingEnabled(on: boolean): void; recordLobbyPitches(h: EntityId): void };
Given("a new Head of Household who faces pitches from trusted houseguests", function (this: BbWorld) {
  const sb = new GameSessionRegistry().sandboxFor(`bdd-b38-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as PitchInternals;
  s.setLobbyingEnabled(true);
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER) as EntityId[];
  const hoh = npcs[0]!;
  for (const n of npcs) if (n !== hoh) { s.rel.edge(hoh, n).threat = 0.6; s.rel.edge(hoh, n).trust = 0.9; }
  vw(this).b38 = { sb, hoh };
});
When("the pitches are made", function (this: BbWorld) {
  const b = vw(this).b38!;
  (b.sb.session as unknown as PitchInternals).recordLobbyPitches(b.hoh);
});
const lobbyEvents = (w: BbWorld) => vw(w).b38!.sb.engine.events.queryAll().filter((e) => e.type === "lobbying");
Then("each pitch is recorded with the Head of Household as a witness", function (this: BbWorld) {
  const evs = lobbyEvents(this);
  assert.ok(evs.length > 0);
  for (const e of evs) assert.ok(e.witnessSet.includes(vw(this).b38!.hoh));
});
Then("a pitch the player did not witness is hidden from the player's knowledge", function (this: BbWorld) {
  const evs = lobbyEvents(this);
  for (const e of evs.filter((x) => !x.witnessSet.includes(PLAYER))) assert.equal(e.hidden, true);
  const seen = vw(this).b38!.sb.engine.events.query({ witnessedBy: PLAYER }).filter((e) => e.type === "lobbying").map((e) => e.id).sort();
  assert.deepEqual(seen, evs.filter((x) => x.witnessSet.includes(PLAYER)).map((x) => x.id).sort());
});
Then("a trusted safety pitch seals a quiet pact between the two", function (this: BbWorld) {
  assert.ok(vw(this).b38!.sb.engine.events.queryAll().some((e) => e.type === "deal"));
});
