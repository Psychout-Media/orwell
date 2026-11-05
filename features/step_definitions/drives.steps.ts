import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import {
  deriveDrive, ownBallotLean, formCampaigns, campaignTilt, DRIVE, ARCHETYPE_AGGRESSION, CAMPAIGN,
  type Drive, type Campaign, type CampaignActor,
} from "../../src/engine/campaigns";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0086 — houseguest drives. Role-only (the-house, a-nominee, a-safe-floater, an-aggressor,
 * the-target). Drives the REAL GameSessionAdapter drive layer (enabled per-session) for the live
 * scenarios, and the PURE `deriveDrive`/`ownBallotLean` for the vote-tier scenarios (as 0085 does for
 * its persuasiveness math). Reuses 0085's shared "…jury calibration is unchanged" step.
 */

interface DWorld {
  dwSession?: GameSessionAdapter;
  dwRel?: RelationshipModel;
  dwIds?: EntityId[];
  dwSubject?: EntityId;
  dwTarget?: EntityId;
  dwLowDrive?: Drive;
  dwLean?: number;
  dwCampaign?: Campaign;
  dwAggressor?: Drive;
  dwFloater?: Drive;
}
const dw = (w: BbWorld): DWorld => w as unknown as DWorld;
const drivesOf = (s: GameSessionAdapter): Map<EntityId, Drive> => (s as unknown as { drives: Map<EntityId, Drive> }).drives;
const campsOf = (s: GameSessionAdapter): Campaign[] => (s as unknown as { campaigns: Campaign[] }).campaigns;
const ceremonyOf = (s: GameSessionAdapter): { nominees: EntityId[]; vetoHolder?: EntityId } =>
  (s as unknown as { ceremony: { nominees: EntityId[]; vetoHolder?: EntityId } }).ceremony;
const liveOf = (s: GameSessionAdapter): { evictionOrder: EntityId[] } | null =>
  (s as unknown as { live: { evictionOrder: EntityId[] } | null }).live;

function liveDriveHouse(seed: number): { session: GameSessionAdapter; rel: RelationshipModel; ids: EntityId[] } {
  const rel = new RelationshipModel(0.5);
  const session = new GameSessionAdapter(rel);
  session.createCharacter({ playerName: "The Player", seed });
  session.setCampaignsEnabled(true);
  const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
  return { session, rel, ids };
}

/** Force every read FROM `owner` to a flat, sub-threshold baseline so their derived drive is deterministic. */
function calmReads(rel: RelationshipModel, owner: EntityId, others: EntityId[]): void {
  for (const o of others) { rel.edge(owner, o).threat = 0.1; rel.edge(owner, o).affinity = 0.2; }
}

Given("a started season with the live drive layer enabled", function (this: BbWorld) {
  const { session, rel, ids } = liveDriveHouse(2026);
  dw(this).dwSession = session; dw(this).dwRel = rel; dw(this).dwIds = ids;
});

// --- Rule: everyone always plays ---

When("the society runs a tick", function (this: BbWorld) {
  dw(this).dwSession!.campaignTick();
});

Then("every living houseguest has a drive with a motivation and an intensity", function (this: BbWorld) {
  const { dwSession: s, dwIds: ids } = dw(this);
  const drives = drivesOf(s!);
  for (const id of ids!) {
    const d = drives.get(id);
    assert.ok(d, "every NPC carries a drive");
    assert.ok(["self-preserve", "target", "build", "lay-low", "win-power"].includes(d!.motivation));
    assert.ok(d!.intensity >= 0 && d!.intensity <= 1, "intensity is a bounded value");
  }
});

Then("the drive set covers the whole house, not a capped subset", function (this: BbWorld) {
  const { dwSession: s, dwIds: ids } = dw(this);
  assert.equal(drivesOf(s!).size, ids!.length, "every living NPC has a drive");
  assert.ok(ids!.length > CAMPAIGN.maxConcurrent, "the house is bigger than the loud-campaign cap");
});

Given("more houseguests have a drive than the loud-campaign cap allows", function (this: BbWorld) {
  const { dwRel: rel, dwIds: ids } = dw(this);
  // Six distinct schemers each read a high threat ⇒ six target drives, but the cap promotes only four.
  for (let i = 0; i < 6; i++) rel!.edge(ids![i]!, ids![10 + (i % 4)]!).threat = 0.85;
});

Then("only up to the cap are promoted to active campaigns", function (this: BbWorld) {
  const active = campsOf(dw(this).dwSession!).filter((c) => c.status === "active");
  assert.ok(active.length <= CAMPAIGN.maxConcurrent, `loud campaigns capped (${active.length} ≤ ${CAMPAIGN.maxConcurrent})`);
});

Then("the rest still carry a quieter lean", function (this: BbWorld) {
  const { dwSession: s } = dw(this);
  const active = campsOf(s!).filter((c) => c.status === "active").length;
  assert.ok(drivesOf(s!).size > active, "more houseguests carry a drive than reach a campaign");
});

// --- Rule: intensity tracks the board ---

Given("a houseguest is on the block", function (this: BbWorld) {
  const { dwSession: s, dwIds: ids } = dw(this);
  ceremonyOf(s!).nominees = [ids![0]!];
  dw(this).dwSubject = ids![0]!;
  s!.campaignTick();
});

Then("their motivation is self-preservation", function (this: BbWorld) {
  assert.equal(drivesOf(dw(this).dwSession!).get(dw(this).dwSubject!)?.motivation, "self-preserve");
});

Then("their intensity is high", function (this: BbWorld) {
  const d = drivesOf(dw(this).dwSession!).get(dw(this).dwSubject!)!;
  assert.ok(d.intensity >= DRIVE.nominatedIntensity, `nominee drives hard (${d.intensity})`);
});

Given("a houseguest is safe and reads little threat", function (this: BbWorld) {
  const { dwSession: s, dwRel: rel, dwIds: ids } = dw(this);
  calmReads(rel!, ids![0]!, ids!.filter((x) => x !== ids![0]));
  dw(this).dwSubject = ids![0]!;
  s!.campaignTick();
});

Then("their motivation is to lay low", function (this: BbWorld) {
  assert.equal(drivesOf(dw(this).dwSession!).get(dw(this).dwSubject!)?.motivation, "lay-low");
});

Then("their intensity is low", function (this: BbWorld) {
  const d = drivesOf(dw(this).dwSession!).get(dw(this).dwSubject!)!;
  assert.ok(d.intensity < 0.5, `a simmering lay-low is low (${d.intensity})`);
});

Given("an aggressive archetype and a floater hold the same threat read", function (this: BbWorld) {
  // Pure: identical board read, only the archetype-aggression factor differs.
  const board: Partial<CampaignActor> = { threats: [{ toward: npc(9), threat: 0.8 }] };
  const actor = (id: EntityId): CampaignActor => ({ id, persuasiveness: 0.5, threats: [], allies: [], ...board });
  dw(this).dwAggressor = deriveDrive(actor(npc(1)), { nominated: false, aggression: ARCHETYPE_AGGRESSION["villain"]!, emotional: 0.5 }, undefined);
  dw(this).dwFloater = deriveDrive(actor(npc(2)), { nominated: false, aggression: ARCHETYPE_AGGRESSION["floater"]!, emotional: 0.5 }, undefined);
});

Then("the aggressor's intensity is higher than the floater's", function (this: BbWorld) {
  assert.ok(dw(this).dwAggressor!.intensity > dw(this).dwFloater!.intensity);
});

// --- Rule: a drive promotes through the gears ---

Given("a houseguest holds a low-intensity target lean", function (this: BbWorld) {
  dw(this).dwLowDrive = { owner: npc(1), motivation: "target", target: npc(2), intensity: 0.3 };
  dw(this).dwLean = ownBallotLean(dw(this).dwLowDrive!, npc(2));
});

When("that drive's intensity rises past the campaign threshold", function (this: BbWorld) {
  // A92: the LIVE tick. The owner's read of the target climbs past the campaign threshold and the real campaign tick promotes it (the same path the live society runs).
  const { session, rel, ids } = liveDriveHouse(2026);
  const [owner, target] = [ids[0]!, ids[1]!];
  for (const o of ids) if (o !== owner) { rel.edge(owner, o).threat = 0.1; rel.edge(owner, o).affinity = 0.2; }
  rel.edge(owner, target).threat = 0.95;
  session.campaignTick();
  dw(this).dwSession = session; dw(this).dwSubject = owner; dw(this).dwTarget = target;
  dw(this).dwCampaign = campsOf(session).find((c) => c.owners[0] === owner && c.target === target);
});

Then("it becomes an active campaign with lobbying", function (this: BbWorld) {
  const c = dw(this).dwCampaign!;
  assert.ok(c && c.status === "active" && c.goal === "evict" && c.target === npc(2));
  assert.ok(c.plan.length > 0, "a campaign carries a lobbying plan");
});

Then("below the threshold it stays a lean that nudges the vote far less than a campaign", function (this: BbWorld) {
  const campaignTiltAtPeak = campaignTilt(1, 0.8, 0.7, 0.5);
  assert.ok(dw(this).dwLean! > 0, "the low lean does nudge");
  assert.ok(dw(this).dwLean! < campaignTiltAtPeak, `the lean is far less than a campaign (${dw(this).dwLean} < ${campaignTiltAtPeak})`);
});

// --- Rule: a low lean moves only the owner's own ballot ---

Given("a houseguest holds a low-intensity grudge against the target", function (this: BbWorld) {
  dw(this).dwLowDrive = { owner: npc(1), motivation: "target", target: npc(2), intensity: 0.5 };
  dw(this).dwTarget = npc(2);
});

Then("that houseguest's own vote leans toward evicting the target", function (this: BbWorld) {
  assert.ok(ownBallotLean(dw(this).dwLowDrive!, dw(this).dwTarget!) > 0, "the owner's own ballot leans");
});

Then("a third houseguest's vote is unmoved by it", function (this: BbWorld) {
  // A92: the LIVE path. The adapter's own vote tilt (the same term the eviction vote reads) carries the owner's quiet grudge for the OWNER alone; a third voter reads nothing from it.
  const { session, ids } = liveDriveHouse(2027);
  const [owner, target, bystander] = [ids[0]!, ids[1]!, ids[2]!];
  drivesOf(session).set(owner, { owner, motivation: "target", target, intensity: 0.5 });
  const tilt = (session as unknown as { campaignTiltFor(t: EntityId, v: EntityId): number }).campaignTiltFor.bind(session);
  assert.ok(tilt(target, owner) > 0, "the owner's own ballot leans toward the target");
  assert.equal(tilt(target, bystander), 0, "a third houseguest's ballot is unmoved by a quiet grudge");
});

Then("only a full campaign sways other voters", function () {
  // Contrast: a campaign's tilt is a positive term that DOES reach a non-owner voter (the lobbying tier).
  assert.ok(campaignTilt(1, 0.8, 0.7, 0.5) > 0);
});

Given("a houseguest is laying low or building an alliance", function (this: BbWorld) {
  dw(this).dwTarget = npc(2);
});

Then("their drive adds no term to the eviction vote", function (this: BbWorld) {
  const layLow: Drive = { owner: npc(1), motivation: "lay-low", intensity: 0.9 };
  const build: Drive = { owner: npc(1), motivation: "build", target: npc(4), intensity: 0.9 };
  assert.equal(ownBallotLean(layLow, dw(this).dwTarget!), 0);
  assert.equal(ownBallotLean(build, dw(this).dwTarget!), 0);
});

// --- Rule: drives are sticky ---

Given("a houseguest commits to a target", function (this: BbWorld) {
  const { dwSession: s, dwRel: rel, dwIds: ids } = dw(this);
  rel!.edge(ids![0]!, ids![3]!).threat = 0.85;
  s!.campaignTick();
  dw(this).dwSubject = ids![0]!;
  dw(this).dwTarget = drivesOf(s!).get(ids![0]!)!.target;
});

When("the society runs several ticks with no board change", function (this: BbWorld) {
  for (let k = 0; k < 3; k++) dw(this).dwSession!.campaignTick();
});

Then("they hold the same target rather than re-rolling each tick", function (this: BbWorld) {
  assert.equal(drivesOf(dw(this).dwSession!).get(dw(this).dwSubject!)?.target, dw(this).dwTarget);
});

Given("a houseguest committed to a target", function (this: BbWorld) {
  const { dwSession: s, dwRel: rel, dwIds: ids } = dw(this);
  rel!.edge(ids![0]!, ids![3]!).threat = 0.85;
  s!.campaignTick();
  dw(this).dwSubject = ids![0]!;
  dw(this).dwTarget = drivesOf(s!).get(ids![0]!)!.target; // == ids[3]
});

When("the target is evicted or wins the veto", function (this: BbWorld) {
  const { dwSession: s, dwRel: rel, dwIds: ids } = dw(this);
  liveOf(s!)!.evictionOrder.push(dw(this).dwTarget!); // gone from the living board
  rel!.edge(ids![0]!, ids![5]!).threat = 0.85; // a fresh live threat to re-aim at
  s!.campaignTick();
});

Then("the drive re-aims rather than persisting on a dead target", function (this: BbWorld) {
  const d = drivesOf(dw(this).dwSession!).get(dw(this).dwSubject!)!;
  assert.notEqual(d.target, dw(this).dwTarget, "no longer fixed on the gone target");
});

// --- Rule: perspective is symmetric ---

Given("a houseguest has no pathway to another's plan", function (this: BbWorld) {
  const { dwSession: s, dwRel: rel, dwIds: ids } = dw(this);
  rel!.edge(ids![0]!, ids![3]!).threat = 0.85; // ids[0]'s OWN read targets ids[3]
  calmReads(rel!, ids![8]!, ids!.filter((x) => x !== ids![8])); // ids[8] reads nothing — a stranger to the plot
  dw(this).dwSubject = ids![8]!;
  dw(this).dwTarget = ids![3]!;
  s!.campaignTick();
});

Then("their drive reflects only what they themselves read, not the full house", function (this: BbWorld) {
  const d = drivesOf(dw(this).dwSession!).get(dw(this).dwSubject!)!;
  assert.equal(d.motivation, "lay-low", "the stranger simmers — they don't inherit another's target");
  assert.notEqual(d.target, dw(this).dwTarget, "no omniscient target leaks in");
});

// --- Rule: calibration safe / Vault ---

Given("the drive layer is disabled", function (this: BbWorld) {
  const s = new GameSessionAdapter();
  s.setCampaignsEnabled(false);
  s.createCharacter({ playerName: "The Player", seed: 9 });
  dw(this).dwSession = s;
});

Then("no drive is computed and no lean is applied", function (this: BbWorld) {
  const before = JSON.stringify(dw(this).dwSession!.snapshot());
  for (let i = 0; i < 5; i++) dw(this).dwSession!.campaignTick();
  assert.equal(drivesOf(dw(this).dwSession!).size, 0, "the off layer derives no drives");
  // A92: and the whole persisted state is byte-identical across the ticks (a real trail comparison, not just an empty map)
  assert.equal(JSON.stringify(dw(this).dwSession!.snapshot()), before, "ticking with the layer off changes nothing");
});

// "the seeded competition and jury calibration is unchanged" — REUSED from 0085 (campaigns.steps.ts).

When("every player-facing surface is read", function (this: BbWorld) {
  const { dwSession: s, dwRel: rel, dwIds: ids } = dw(this);
  rel!.edge(ids![0]!, ids![1]!).threat = 0.85;
  s!.campaignTick(); s!.campaignTick();
});

Then("none of them returns a drive, an intensity, or a motivation value", function (this: BbWorld) {
  const s = dw(this).dwSession!;
  const blob = JSON.stringify([...dw(this).dwIds!.map((id) => s.npcVoice(id)), s.gameStatus(), s.whereabouts()]);
  assert.ok(!/"motivation"|"intensity"|self-preserve|lay-low|win-power/.test(blob), "no drive content on any surface");
});
