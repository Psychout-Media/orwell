import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import { NEMESIS, type Campaign, type NemesisTrack } from "../../src/engine/campaigns";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { adminSurfaceOfSession } from "../support/liveSweep";
import { buildSandbox } from "../../tests/support/sandbox";
import { seasonTrail } from "../support/seasonTrail";

/**
 * Feature 0096 — emergent nemesis (a personal villain to outlast). Role-only (a houseguest, the
 * nemesis, a rival, a bystander, the admin). Drives the REAL `GameSessionAdapter` campaign/drive/
 * nemesis layer, exactly as 0085/0086's step files do — no scripted narration, only the engine's
 * selection + escalation + Vault-safe surfacing.
 */

interface NmWorld {
  nmSession?: GameSessionAdapter;
  nmRel?: RelationshipModel;
  nmIds?: EntityId[];
  nmRival?: EntityId;
  nmChallenger?: EntityId;
  nmPlayerBlob?: string;
  nmAdminBlob?: string;
  nmVoice?: ReturnType<GameSessionAdapter["npcVoice"]>;
  nmRevived?: GameSessionAdapter;
  nmSeeds?: number[];
  nmWithNemesisTilts?: number[];
  nmBaselineTilts?: number[];
  nmTiltSession?: GameSessionAdapter;
  nmTiltVoter?: EntityId;
}
const nm = (w: BbWorld): NmWorld => w as unknown as NmWorld;

type Peek = {
  nemesisTrack: NemesisTrack;
  campaigns: Campaign[];
  drives: Map<EntityId, { motivation: string; target?: EntityId; intensity: number }>;
  presence?: Map<EntityId, string>;
  campaignTick: () => void;
  campaignTiltFor: (target: EntityId, voter: EntityId) => number;
};
const peek = (s: GameSessionAdapter): Peek => s as unknown as Peek;

function nmHouse(seed: number, enableCampaigns: boolean): { session: GameSessionAdapter; rel: RelationshipModel; ids: EntityId[] } {
  const rel = new RelationshipModel(0.5);
  const session = new GameSessionAdapter(rel);
  session.setCampaignsEnabled(enableCampaigns);
  session.createCharacter({ playerName: "The Player", seed });
  const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
  return { session, rel, ids };
}

/** Make `rival`'s clear top threat read the PLAYER (well above the nemesis bar), everyone else calm. */
function aimAtPlayer(rel: RelationshipModel, rival: EntityId, others: EntityId[], threat = NEMESIS.threatThreshold + 0.15): void {
  rel.edge(rival, PLAYER).threat = threat;
  for (const o of others) rel.edge(rival, o).threat = 0.1;
}

/** The nemesis escalation, observed: a campaign flagged as the nemesis arc, or a drive held at the escalation intensity on the player. */
function escalationAimedAtPlayer(session: GameSessionAdapter): string[] {
  const out: string[] = [];
  for (const c of peek(session).campaigns) if (c.id.endsWith(":nemesis") && c.target === PLAYER) out.push(`campaign ${c.id}`);
  for (const [id, d] of peek(session).drives) if (d.target === PLAYER && d.intensity >= NEMESIS.escalationIntensity) out.push(`drive ${id}`);
  return out;
}

// ── Background (the season-start step is SHARED — defined by 0075's confidence.steps.ts) ──────────

Given("the campaign layer is enabled", function (this: BbWorld) {
  // Documentary — each Rule's own Given constructs the concrete session it needs (the 0086 pattern:
  // see drives.steps.ts, where a later "the drive layer is disabled" Given freely supersedes this).
});

// ── Rule: a nemesis emerges only from SUSTAINED threat ──────────────────────────────────────────────

Given("a houseguest whose threat toward the player stays high across several ticks", function (this: BbWorld) {
  const { session, rel, ids } = nmHouse(2026, true);
  const [rival, ...rest] = ids;
  aimAtPlayer(rel, rival!, rest);
  Object.assign(nm(this), { nmSession: session, nmRel: rel, nmIds: ids, nmRival: rival });
  for (let i = 0; i < NEMESIS.sustainTicks - 1; i++) peek(session).campaignTick();
});

Given("whose sticky drive is aimed at targeting the player", function (this: BbWorld) {
  const d = peek(nm(this).nmSession!).drives.get(nm(this).nmRival!);
  assert.equal(d?.motivation, "target");
  assert.equal(d?.target, PLAYER);
});

When("the engine advances the campaign tick", function (this: BbWorld) {
  peek(nm(this).nmSession!).campaignTick();
});

Then("that houseguest is held as the player's nemesis", function (this: BbWorld) {
  assert.equal(peek(nm(this).nmSession!).nemesisTrack.current, nm(this).nmRival);
});

Then("their existing campaign is biased toward evicting the player", function (this: BbWorld) {
  const camp = peek(nm(this).nmSession!).campaigns.find((c) => c.owners[0] === nm(this).nmRival && c.status === "active");
  assert.equal(camp?.goal, "evict");
  assert.equal(camp?.target, PLAYER);
});

Then("their target drive is held on the player at the upper of its intensity band", function (this: BbWorld) {
  const d = peek(nm(this).nmSession!).drives.get(nm(this).nmRival!);
  assert.equal(d?.target, PLAYER);
  assert.ok(d!.intensity >= NEMESIS.escalationIntensity);
});

Given("a houseguest whose threat toward the player spikes for a single tick", function (this: BbWorld) {
  const { session, rel, ids } = nmHouse(31, true);
  const [rival, ...rest] = ids;
  aimAtPlayer(rel, rival!, rest);
  Object.assign(nm(this), { nmSession: session, nmRel: rel, nmIds: ids, nmRival: rival });
  // No prior ticks — the upcoming "When" step IS the single spike.
});

Then("no houseguest is the player's nemesis", function (this: BbWorld) {
  assert.equal(peek(nm(this).nmSession!).nemesisTrack.current, undefined);
});

Then("no escalation bias is applied to anyone toward the player", function (this: BbWorld) {
  assert.equal(peek(nm(this).nmSession!).nemesisTrack.current, undefined);
  assert.deepEqual(escalationAimedAtPlayer(nm(this).nmSession!), [], "a one-tick spike was escalated");
});

Given("no houseguest sustains a high threat toward the player", function (this: BbWorld) {
  const { session, rel, ids } = nmHouse(66, true);
  Object.assign(nm(this), { nmSession: session, nmRel: rel, nmIds: ids });
  // Default RelationshipModel(0.5) baseline everywhere — nobody clears NEMESIS.threatThreshold.
});

When("the season plays on", function (this: BbWorld) {
  for (let i = 0; i < 8; i++) peek(nm(this).nmSession!).campaignTick();
});

Then("there is no nemesis at any point", function (this: BbWorld) {
  assert.equal(peek(nm(this).nmSession!).nemesisTrack.current, undefined);
});

Then("the player faces no escalating personal antagonist", function (this: BbWorld) {
  assert.ok(!peek(nm(this).nmSession!).campaigns.some((c) => c.id.endsWith(":nemesis")));
});

// ── Rule: the nemesis is organic — it can shift and hand off ────────────────────────────────────────

Given("a houseguest held as the player's nemesis", function (this: BbWorld) {
  const { session, rel, ids } = nmHouse(77, true);
  const [rival, ...rest] = ids;
  aimAtPlayer(rel, rival!, rest);
  Object.assign(nm(this), { nmSession: session, nmRel: rel, nmIds: ids, nmRival: rival });
  for (let i = 0; i < NEMESIS.sustainTicks; i++) peek(session).campaignTick();
  assert.equal(peek(session).nemesisTrack.current, rival, "setup sanity: the nemesis is held");
});

When("their threat toward the player decays and their drive re-aims off the player", function (this: BbWorld) {
  nm(this).nmRel!.edge(nm(this).nmRival!, PLAYER).threat = 0.05;
});

Then("that houseguest is no longer the player's nemesis", function (this: BbWorld) {
  assert.notEqual(peek(nm(this).nmSession!).nemesisTrack.current, nm(this).nmRival);
});

Then("no escalation bias is applied toward the player", function (this: BbWorld) {
  assert.equal(peek(nm(this).nmSession!).nemesisTrack.current, undefined);
  assert.deepEqual(escalationAimedAtPlayer(nm(this).nmSession!), [], "a lapsed nemesis is still escalated against the player");
});

Given("a different rival whose sustained threat toward the player clearly overtakes them", function (this: BbWorld) {
  const { nmSession: session, nmRel: rel, nmIds: ids, nmRival: rival } = nm(this);
  const challenger = ids!.find((id) => id !== rival)!;
  nm(this).nmChallenger = challenger;
  rel!.edge(challenger, PLAYER).threat = NEMESIS.threatThreshold + 0.4;
  for (const o of ids!) if (o !== challenger) rel!.edge(challenger, o).threat = 0.1;
  for (let i = 0; i < NEMESIS.sustainTicks - 1; i++) peek(session!).campaignTick(); // the final tick is the "When"
});

Then("the rival becomes the player's nemesis", function (this: BbWorld) {
  assert.equal(peek(nm(this).nmSession!).nemesisTrack.current, nm(this).nmChallenger);
});

Then("at most one houseguest is the player's nemesis at a time", function (this: BbWorld) {
  const session = nm(this).nmSession!;
  assert.equal(peek(session).nemesisTrack.current, nm(this).nmChallenger);
  const escalated = peek(session).campaigns.filter((c) => c.id.endsWith(":nemesis") && c.status === "active" && c.target === PLAYER);
  assert.ok(escalated.length <= 1, `${escalated.length} nemesis campaigns are active at once`);
  assert.ok(escalated.every((c) => c.owners[0] === nm(this).nmChallenger), "the escalated campaign belongs to the new nemesis only");
  const heldOnPlayer = [...peek(session).drives].filter(([id, d]) => d.target === PLAYER && d.intensity >= NEMESIS.escalationIntensity && id === nm(this).nmRival);
  assert.equal(heldOnPlayer.length, 0, "the old rival is still held at escalation intensity");
});

// ── Rule: the rivalry is behavior-only — Vault-Wall holds for player AND admin ──────────────────────

When("the player checks every player-facing surface for the rivalry", function (this: BbWorld) {
  const { nmSession: session, nmIds: ids } = nm(this);
  nm(this).nmPlayerBlob = JSON.stringify([
    ...ids!.map((id) => session!.npcVoice(id)),
    session!.gameStatus(),
    session!.whereabouts(),
  ]);
});

When("the admin views any God-Mode surface", function (this: BbWorld) {
  // The real admin/God-Mode composition never even holds a handle to `campaigns.ts` (dependency-cruiser
  // walls it — the same wall as the Vault, `test:arch`); this generic admin surface proves the runtime
  // output carries no nemesis language either, belt-and-braces.
  // PAT-2: the admin view of THE SAME game the nemesis was built in (was: a fresh, unrelated canary sandbox).
  nm(this).nmAdminBlob = adminSurfaceOfSession(nm(this).nmSession!);
});

Then("neither surface returns the nemesis identity", function (this: BbWorld) {
  const blob = (nm(this).nmPlayerBlob ?? "") + (nm(this).nmAdminBlob ?? "");
  assert.ok(!/nemesis/i.test(blob), "no surface ever labels anyone as 'the nemesis'");
});

Then("neither surface returns a threat number, a hostility score, or an escalation tier", function (this: BbWorld) {
  const blob = (nm(this).nmPlayerBlob ?? "") + (nm(this).nmAdminBlob ?? "");
  assert.ok(!/hostility|escalationIntensity|threatThreshold|"threat":\s*[0-9.]/i.test(blob));
});

Then("the player learns of the rivalry only through what the nemesis does", function (this: BbWorld) {
  const { nmSession: session, nmRival: rival } = nm(this);
  // Out of a scene, nothing on any player surface hints at it at all...
  assert.ok(!/rivalry|simmering|"open"/i.test(nm(this).nmPlayerBlob ?? ""), "the rivalry hint rode a player surface outside a scene");
  // ...and the one place it can show is the nemesis's own manner toward the player, inside a live scene with them.
  const presence = peek(session!).presence ?? new Map<EntityId, string>();
  presence.set(PLAYER, "kitchen"); presence.set(rival!, "kitchen");
  (session as unknown as { presence: Map<EntityId, string> }).presence = presence;
  const voice = session!.npcVoice(rival!);
  assert.ok(voice?.rivalry, "in a live scene the nemesis carries an adversarial tone");
  assert.deepEqual(Object.keys(voice!.rivalry!), ["tone"], "the hint is a tone word and nothing else");
});

When("the player is in a scene with that houseguest", function (this: BbWorld) {
  const { nmSession: session, nmRival: rival } = nm(this);
  const presence = peek(session!).presence ?? new Map<EntityId, string>();
  presence.set(PLAYER, "kitchen");
  presence.set(rival!, "kitchen");
  (session as unknown as { presence: Map<EntityId, string> }).presence = presence;
  nm(this).nmVoice = session!.npcVoice(rival!);
});

Then("the houseguest's voice carries a Vault-safe adversarial tone hint", function (this: BbWorld) {
  const voice = nm(this).nmVoice;
  assert.ok(voice?.rivalry, "the rivalry hint is present inside the live scene");
  assert.ok(["simmering", "open"].includes(voice!.rivalry!.tone));
});

Then("the voice carries no threat number and no statement that they are the nemesis", function (this: BbWorld) {
  const blob = JSON.stringify(nm(this).nmVoice);
  assert.ok(!/nemesis|hostility|"threat":\s*[0-9.]/i.test(blob));
});

Then("no nemesis hint is offered outside a live scene with that houseguest", function (this: BbWorld) {
  const { nmSession: session, nmRival: rival } = nm(this);
  const presence = peek(session!).presence!;
  presence.set(PLAYER, "backyard"); // the player steps out — no longer co-present
  const voiceOut = session!.npcVoice(rival!);
  assert.equal(voiceOut?.rivalry, undefined);
});

// ── Rule: no new magnitude beyond the existing tilt; deterministic ──────────────────────────────────

Given("a houseguest held as the player's nemesis with a sustained campaign against the player", function (this: BbWorld) {
  const seeds = [201, 202, 203, 204, 205];
  const withNemesisTilts: number[] = [];
  const baselineTilts: number[] = [];
  const runTicks = NEMESIS.sustainTicks + 4; // sustain the nemesis, then let progress/diffusion accrue
  for (const seed of seeds) {
    // WITH a sustained nemesis: the rival's threat toward the player is high and held. Their forced
    // evict-the-player campaign starts at progress 0 (formed mid-tick) and accrues + diffuses knownTo
    // over the FOLLOWING ticks via the unchanged `advanceCampaign` — the same 0085 mechanics, just
    // reliably aimed at the player instead of scattering.
    const { session, rel, ids } = nmHouse(seed, true);
    const [rival, ...rest] = ids;
    aimAtPlayer(rel, rival!, rest);
    for (let i = 0; i < runTicks; i++) peek(session).campaignTick();
    const camp = peek(session).campaigns.find((c) => c.owners[0] === rival && c.status === "active");
    const voter = camp?.knownTo.find((id) => id !== rival) ?? rival!; // a diffused-to ally, else the owner
    withNemesisTilts.push(peek(session).campaignTiltFor(PLAYER, voter));
    Object.assign(nm(this), { nmTiltSession: session, nmTiltVoter: voter });

    // Baseline, SAME seed: nobody's threat toward the player ever rises ⇒ no nemesis, no campaign vs
    // player ever forms ⇒ campaignTiltFor(PLAYER, ·) is structurally 0 for any voter.
    const { session: baseSession, ids: baseIds } = nmHouse(seed, true);
    for (let i = 0; i < runTicks; i++) peek(baseSession).campaignTick();
    baselineTilts.push(peek(baseSession).campaignTiltFor(PLAYER, baseIds[1]!));
  }
  Object.assign(nm(this), { nmSeeds: seeds, nmWithNemesisTilts: withNemesisTilts, nmBaselineTilts: baselineTilts });
});

When("the season's evictions are tallied across seeds", function () {
  // The comparison itself is assembled in the Given (per-seed campaignTiltFor readings) — this step
  // is the Gherkin beat marking the tally; nothing further to compute.
});

Then("the player's eviction danger is higher than a no-nemesis baseline", function (this: BbWorld) {
  const { nmSeeds: seeds, nmWithNemesisTilts: withT, nmBaselineTilts: baseT } = nm(this);
  for (let i = 0; i < seeds!.length; i++) {
    assert.ok(withT![i]! > baseT![i]!, `seed ${seeds![i]}: nemesis-biased tilt (${withT![i]}) > baseline (${baseT![i]})`);
  }
});

Then("the vote effect is carried by the existing campaign and drive tilt with no new term", function (this: BbWorld) {
  // The nemesis adds danger ONLY by re-aiming the ordinary campaign: keep the nemesis held but take the campaign away,
  // and the player's vote tilt from that voter drops to exactly zero — nothing else carries it.
  const { nmTiltSession: session, nmTiltVoter: voter } = nm(this);
  assert.ok(peek(session!).nemesisTrack.current !== undefined, "the nemesis is still held");
  const withCampaign = peek(session!).campaignTiltFor(PLAYER, voter!);
  assert.ok(withCampaign > 0, "the campaign tilts the vote");
  const kept = peek(session!).campaigns.slice();
  peek(session!).campaigns.length = 0;
  try {
    assert.equal(peek(session!).campaignTiltFor(PLAYER, voter!), 0, "a held nemesis with no campaign still tilts the vote: that is a new term");
  } finally {
    peek(session!).campaigns.push(...kept);
  }
});

Given("the campaign layer is disabled", function (this: BbWorld) {
  const { session, rel, ids } = nmHouse(2026, false);
  const [rival, ...rest] = ids;
  aimAtPlayer(rel, rival!, rest); // even a would-be-nemesis-shaped board — the layer being OFF must win
  Object.assign(nm(this), { nmSession: session, nmRel: rel, nmIds: ids, nmRival: rival });
});

When("the same seeded season is played", function (this: BbWorld) {
  for (let i = 0; i < 6; i++) peek(nm(this).nmSession!).campaignTick();
});

Then("no nemesis is computed and no escalation bias is applied", function (this: BbWorld) {
  assert.equal(peek(nm(this).nmSession!).nemesisTrack.current, undefined);
  assert.equal(peek(nm(this).nmSession!).campaigns.length, 0);
});

Then("the seeded competition and eviction outcomes are byte-identical to the no-campaign baseline", function (this: BbWorld) {
  // The baseline: the very same would-be-nemesis board with the layer off, where campaignTick was NEVER called.
  // Ticking the layer while it is off must not move a single seeded HOH, nominee, or eviction.
  const { session: baseline, rel, ids } = nmHouse(2026, false);
  const [rival, ...rest] = ids;
  aimAtPlayer(rel, rival!, rest);
  // The ticked run ticks the disabled layer after EVERY beat, as the orchestrator does between beats in production.
  const live = nm(this).nmSession!;
  const ticked = seasonTrail(live, 600, () => peek(live).campaignTick());
  assert.equal(peek(live).nemesisTrack.current, undefined, "a nemesis was computed while the layer was off");
  assert.ok(ticked.length > 100, "a season was actually played");
  assert.equal(ticked, seasonTrail(baseline), "campaignTick moved the seeded outcomes with the layer off");
});

When("the game is saved and restored into a fresh context", function (this: BbWorld) {
  const snap = nm(this).nmSession!.snapshot();
  const revived = new GameSessionAdapter();
  revived.restore(snap);
  nm(this).nmRevived = revived;
});

Then("the same houseguest is still the player's nemesis", function (this: BbWorld) {
  assert.equal(peek(nm(this).nmRevived!).nemesisTrack.current, nm(this).nmRival);
});

Then("the rivalry's accumulated history is recalled in full", function (this: BbWorld) {
  const streak = peek(nm(this).nmRevived!).nemesisTrack.streak;
  assert.ok((streak[nm(this).nmRival!] ?? 0) >= NEMESIS.sustainTicks);
});


// A93: the nomination side of the nemesis (#1966: the evict campaign's push reaches a decider who is AWARE of it, symmetric perspective).
When("a houseguest who knows of that campaign weighs the player for nomination", function (this: BbWorld) {
  const sess = nm(this).nmSession!;
  const camp = peek(sess).campaigns.find((c) => c.owners[0] === nm(this).nmRival && c.status === "active")!;
  const [aware, unaware] = nm(this).nmIds!.filter((i) => i !== nm(this).nmRival).slice(0, 2) as [EntityId, EntityId];
  if (!camp.knownTo.includes(aware)) camp.knownTo.push(aware);
  camp.knownTo = camp.knownTo.filter((k) => k !== unaware);
  Object.assign(nm(this), { nmAware: aware, nmUnaware: unaware });
});

Then("the player's nomination push from that houseguest is positive", function (this: BbWorld) {
  const push = (peek(nm(this).nmSession!) as unknown as { ctx(): { campaignPushFor?: (t: EntityId, d: EntityId) => number } }).ctx().campaignPushFor!;
  assert.ok(push(PLAYER, (nm(this) as unknown as { nmAware: EntityId }).nmAware) > 0, "an aware decider is pushed toward naming the player");
});

Then("a houseguest who does not know of the campaign feels no push", function (this: BbWorld) {
  const push = (peek(nm(this).nmSession!) as unknown as { ctx(): { campaignPushFor?: (t: EntityId, d: EntityId) => number } }).ctx().campaignPushFor!;
  assert.equal(push(PLAYER, (nm(this) as unknown as { nmUnaware: EntityId }).nmUnaware), 0);
});
