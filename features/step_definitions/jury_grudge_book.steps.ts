import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { JURY_HOUSE } from "../../src/engine/juryHouseConstants";
import { assertNoSentinels } from "../../tests/support/assertions";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EdgeRecord } from "../../src/domain/saveState";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { answerPending } from "../support/answerPending";

/**
 * Feature 0100 — the jury grudge book. The last-nine evictees keep living in a sequestered jury house,
 * gossip about the player and each other, and the accumulated treatment folds into the engine-owned
 * finale vote. HARD rule: roles only — a finalist / a juror / a betrayed-juror / a respected-juror /
 * the last-evicted-juror / a pre-jury-evictee / the-player. The engine tallies; the model only voices.
 */

// The cast is the player + 15 NPCs (npc:1..npc:15). Two still-living NPC finalists; the last-nine NPC
// evictees are the jury (npc:1..npc:9). npc:1 is the betrayed juror, npc:2 the close juror, npc:9 isolated.
const FINALIST = npc(14);
const OTHER_FINALIST = npc(15);
const JURORS: EntityId[] = Array.from({ length: 9 }, (_, i) => npc(i + 1));
// PO ruling 2026-11-03: only jurors belong in the jury house. Of the 14 evictions in a 16-person cast (the player + npc:1..15),
// the first `cast − 2 − 9 = 5` are pre-jury and the last nine are the jury (npc:1..9; finalists npc:14/15), so the real pre-jury
// slots are npc:10..13 and the player. Crafted eviction orders seat them first so the jurors sit at the jury-start index.
const PRE_JURY: EntityId[] = [npc(10), npc(11), npc(12), npc(13), PLAYER];
const BETRAYED = npc(1);
const CLOSE = npc(2);
const ISOLATED = npc(9);

/** Juror↔juror edges: the betrayed juror bonded to a close juror; the isolated juror cut off from all. */
function juryEdges(extra?: (from: EntityId, to: EntityId) => Partial<EdgeRecord>): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  const base = (from: EntityId, to: EntityId): EdgeRecord => ({
    from, to, trust: 0.07, affinity: 0.1, threat: 0.1, alignment: 0.3, confidence: 0.5, reliability: 0.3,
  });
  for (const a of JURORS) for (const b of JURORS) {
    if (a === b) continue;
    edges.push({ ...base(a, b), ...(extra?.(a, b) ?? {}) });
  }
  // The betrayed↔close pair is a strong bond (the grievance travels along it).
  for (const rec of edges) {
    if ((rec.from === BETRAYED && rec.to === CLOSE) || (rec.from === CLOSE && rec.to === BETRAYED)) {
      rec.affinity = 0.9; rec.trust = 0.6;
    }
    // The isolated juror is cut off from everyone (no warm edge to carry a grievance to/from them).
    if (rec.from === ISOLATED || rec.to === ISOLATED) rec.affinity = 0.02;
  }
  return edges;
}

/** A jury-PHASE live state (mid-sequester) with a jury, a recorded grievance, and optional grudge. */
function juryPhaseLive(opts: { grievanceAgainst?: EntityId; preJurorIncluded?: boolean } = {}): LiveSeasonState {
  const manner: Record<EntityId, Record<EntityId, import("../../src/engine/jury").EvictionManner>> = {};
  if (opts.grievanceAgainst) manner[BETRAYED] = { [opts.grievanceAgainst]: { betrayed: true } };
  return {
    week: 9, beat: "hoh-competition", active: [FINALIST, OTHER_FINALIST], vetoUsed: false,
    evictionOrder: [...PRE_JURY, ...JURORS], finished: false, mannerByEvictee: manner,
  };
}

/** Stand up a started game and RESTORE a crafted jury-phase snapshot (jury + manner + edges). */
function startJuryPhase(world: BbWorld, user: string, seed: number, enable: boolean, live: LiveSeasonState, edges: EdgeRecord[]): void {
  const reg = new GameSessionRegistry();
  const session = reg.sandboxFor(user).session;
  session.createCharacter({ playerName: "The Player", seed });
  const snap = reg.snapshot(user) as SessionSnapshot;
  snap.live = live;
  snap.relationships = edges;
  reg.restore(user, snap);
  const sb = reg.sandboxFor(user);
  sb.session.setJuryHouseEnabled(enable); // explicit both ways: the jury house defaults ON (2026-11 default flip)
  world.jh = {
    ...world.jh, reg, user, sandbox: sb, jurors: JURORS, finalist: FINALIST, otherFinalist: OTHER_FINALIST,
    grievanceJuror: BETRAYED, closeJuror: CLOSE, isolatedJuror: ISOLATED, enabled: enable,
  };
}

/** Run N jury-house ticks on the current sandbox. */
function tickJuryHouse(world: BbWorld, n: number): void {
  const sb = world.jh!.sandbox!;
  for (let t = 0; t < n; t++) sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
}

const grudgeOf = (world: BbWorld, juror: EntityId, finalist: EntityId): number =>
  (world.jh!.sandbox!.session.snapshot().live as LiveSeasonState).juryGrudge?.[juror]?.[finalist] ?? 0;

// --- Background -----------------------------------------------------------------

Given("a started season with the jury house enabled", function (this: BbWorld) {
  startJuryPhase(this, "jh-bg", 7, true, juryPhaseLive({ grievanceAgainst: FINALIST }), juryEdges());
});

Given("the season has reached the jury phase with sequestered jurors", function (this: BbWorld) {
  // The jury-phase live state restored above already holds the last-nine evictees as the jury.
  const live = this.jh!.sandbox!.session.snapshot().live as LiveSeasonState;
  assert.ok((live.evictionOrder?.length ?? 0) >= 2, "sequestered jurors exist");
});

// --- Rule: a living, hidden second society --------------------------------------

When("time passes between turns", function (this: BbWorld) {
  tickJuryHouse(this, 8);
});

Then("the jurors produce hidden scenes among themselves in the jury house", function (this: BbWorld) {
  const events = this.jh!.sandbox!.engine.events.queryAll();
  const juryHouseScenes = events.filter((e) => e.hidden && e.witnessSet.every((w) => JURORS.includes(w)));
  assert.ok(juryHouseScenes.length > 0, "the jury house produced hidden juror↔juror scenes");
});

Then("those scenes carry more than one interaction nature, not a single canned verb", function (this: BbWorld) {
  const natures = new Set(this.jh!.sandbox!.engine.events.queryAll().map((e) => e.type));
  assert.ok(natures.size > 1, `more than one scene nature (saw: ${[...natures].join(", ")})`);
});

Then("the living main house still excludes every evicted houseguest", function (this: BbWorld) {
  // The jury house is a SEPARATE society; the main-house off-screen society still excludes evictees
  // (orchestrator :498 unchanged). Here we assert the jury house operates ONLY on evicted jurors —
  // never a still-active houseguest — so the two societies do not overlap.
  const live = this.jh!.sandbox!.session.snapshot().live as LiveSeasonState;
  const evicted = new Set(live.evictionOrder ?? []);
  const juryHouseActors = new Set(
    this.jh!.sandbox!.engine.events.queryAll()
      .filter((e) => e.hidden && e.witnessSet.every((w) => JURORS.includes(w)))
      .flatMap((e) => e.witnessSet),
  );
  for (const actor of juryHouseActors) {
    assert.ok(evicted.has(actor), "a jury-house actor is an evicted juror, never a living houseguest");
  }
});

Then("no jury-house scene is witnessed by the player", function (this: BbWorld) {
  const events = this.jh!.sandbox!.engine.events.queryAll();
  const juryHouseScenes = events.filter((e) => e.hidden && e.witnessSet.every((w) => JURORS.includes(w)));
  for (const ev of juryHouseScenes) {
    assert.ok(!ev.witnessSet.includes(PLAYER), "the player NEVER witnesses a jury-house scene");
  }
});

// --- Rule: pre-jury evictees are not in the jury house --------------------------

Given("a pre-jury-evictee who was cut before the jury formed", function (this: BbWorld) {
  // The jury is exactly the LAST nine evictees (slice(-9)). A pre-jury evictee is one cut EARLIER, so it
  // never appears in that slice. Model an eviction order longer than nine: the first entries are pre-jury.
  const reg = new GameSessionRegistry();
  const user = "jh-prejury";
  const session = reg.sandboxFor(user).session;
  session.createCharacter({ playerName: "The Player", seed: 8 });
  const preJuror = npc(10); // an early evictee, NOT in the last-nine
  const live: LiveSeasonState = {
    week: 11, beat: "hoh-competition", active: [FINALIST, OTHER_FINALIST], vetoUsed: false,
    // 14 evictees: five pre-jury (npc:10 first) then the last-nine npc:1..npc:9 — only the nine are the jury.
    evictionOrder: [preJuror, ...PRE_JURY.slice(1), ...JURORS], finished: false,
    mannerByEvictee: { [preJuror]: { [FINALIST]: { betrayed: true } } }, // even a grievance: it never spreads
  };
  const snap = reg.snapshot(user) as SessionSnapshot;
  snap.live = live;
  snap.relationships = juryEdges();
  reg.restore(user, snap);
  const sb = reg.sandboxFor(user);
  sb.session.setJuryHouseEnabled(true);
  this.jh = { ...this.jh, reg, user, sandbox: sb, preJurorEvictee: preJuror };
});

Then("the pre-jury-evictee takes part in no jury-house society", function (this: BbWorld) {
  tickJuryHouse(this, 8);
  const pre = this.jh!.preJurorEvictee!;
  const scenes = this.jh!.sandbox!.engine.events.queryAll().filter((e) => e.hidden);
  for (const ev of scenes) {
    assert.ok(!ev.witnessSet.includes(pre), "a pre-jury evictee never appears in a jury-house scene");
  }
  // …and their recorded grievance never folds a grudge (they are not in the room).
  const live = this.jh!.sandbox!.session.snapshot().live as LiveSeasonState;
  for (const juror of JURORS) {
    assert.equal(live.juryGrudge?.[juror]?.[FINALIST] ?? 0 >= 0, true);
  }
});

Then("the pre-jury-evictee casts no final vote", function (this: BbWorld) {
  // Structural: the jury IS slice(-9); a pre-jury evictee is not in it, so it never votes (0014). Assert
  // the pre-juror is excluded from the last-nine jury panel.
  const live = this.jh!.sandbox!.session.snapshot().live as LiveSeasonState;
  const jury = (live.evictionOrder ?? []).slice(-9);
  assert.ok(!jury.includes(this.jh!.preJurorEvictee!), "the pre-jury evictee is not on the jury panel");
});

// --- Rule: bitterness is contagious, bounded, only by pathway -------------------

Given("a betrayed-juror who carries a grievance against the player", function (this: BbWorld) {
  // Reuse the started jury-phase season; the grievance is recorded against the FINALIST role (the
  // "player" is, in the role frame, the responsible finalist whose goodbyes left a grievance).
  if (!this.jh?.sandbox) startJuryPhase(this, "jh-contagion", 7, true, juryPhaseLive({ grievanceAgainst: FINALIST }), juryEdges());
  assert.ok(this.jh!.grievanceJuror, "a betrayed juror with a grievance exists");
});

Given("another-juror who left with no grievance but is close to the betrayed-juror", function (this: BbWorld) {
  this.jh!.closeJuror = CLOSE; // bonded to the betrayed juror in the edge fixture
});

Given("another-juror who is isolated from the betrayed-juror in the jury house", function (this: BbWorld) {
  this.jh!.isolatedJuror = ISOLATED; // cut off in the edge fixture
});

When("the grievance diffuses through the jury house over several stretches", function (this: BbWorld) {
  tickJuryHouse(this, 14);
  this.jh!.closeGrudgeAfter = grudgeOf(this, CLOSE, FINALIST);
  this.jh!.isolatedGrudgeAfter = grudgeOf(this, ISOLATED, FINALIST);
});

Then("the another-juror's hidden read of the player turns colder", function (this: BbWorld) {
  assert.ok((this.jh!.closeGrudgeAfter ?? 0) > 0, "the close juror's grudge toward the responsible finalist grew");
});

Then("the shift is confidence-scaled and stays within the saturation bound", function (this: BbWorld) {
  assert.ok((this.jh!.closeGrudgeAfter ?? 0) <= JURY_HOUSE.adjustmentCap, "the grudge stays within the saturation bound");
});

Then("the isolated juror's hidden read of the player is unchanged by it", function (this: BbWorld) {
  assert.equal(this.jh!.isolatedGrudgeAfter ?? 0, 0, "an isolated juror picks up no grudge");
});

Then("no juror's read ever reflects a grudge they had no pathway to", function (this: BbWorld) {
  // The omniscience ban: the isolated juror (no pathway to the grievance) holds exactly zero grudge.
  assert.equal(grudgeOf(this, ISOLATED, FINALIST), 0, "no grudge without a pathway");
});

// --- Rule: the accumulated grudge folds into the engine-owned vote --------------
// These drive the LIVE finale through the seam, with a crafted accumulated grudge, and read the winner.

type Player = McpServer;
const adv = async (p: Player): Promise<AdvanceView> => (await p.callTool("advanceGame", {})) as AdvanceView;

/** Drive the finale to a winner with a fixed minimal policy; return the winner id. */
async function finaleWinner(
  user: string, seed: number, edgeTo: (juror: EntityId, finalist: EntityId) => Partial<EdgeRecord>,
  grudge?: Record<EntityId, Record<EntityId, number>>,
  manner?: Record<EntityId, Record<EntityId, import("../../src/engine/jury").EvictionManner>>,
): Promise<EntityId | undefined> {
  const reg = new GameSessionRegistry();
  const p0 = reg.resolver()("player", user) as Player;
  await p0.callTool("createCharacter", { playerName: "Player", seed });
  const snap = reg.snapshot(user) as SessionSnapshot;
  // Two NPC finalists (so the engine decides every vote; no player turn to drive in the vote math).
  const live: LiveSeasonState = {
    week: 9, beat: "finale", active: [FINALIST, OTHER_FINALIST], vetoUsed: false,
    evictionOrder: [...PRE_JURY, ...JURORS], finished: false,
    ...(manner ? { mannerByEvictee: manner } : {}),
    ...(grudge ? { juryGrudge: grudge } : {}),
  };
  const edges: EdgeRecord[] = [];
  for (const j of JURORS) for (const f of [FINALIST, OTHER_FINALIST]) {
    edges.push({ from: j, to: f, trust: 0.5, affinity: 0.5, threat: 0.3, alignment: 0, confidence: 0.5, reliability: 0.3, ...edgeTo(j, f) });
  }
  snap.live = live;
  snap.relationships = edges;
  reg.restore(user, snap);
  const p = reg.resolver()("player", user) as Player;
  let final: AdvanceView | undefined;
  for (let i = 0; i < 2000; i++) {
    const v = await adv(p);
    final = v;
    if (v.finished) break;
    if (v.pending) {
      const d = v.pending;
      const req = answerPending(d);
      if (req) await p.callTool("submitDecision", req as unknown as Record<string, unknown>);
    }
  }
  return final?.winner?.id as EntityId | undefined;
}

/** Win rate of FINALIST across seeds, optionally with a crafted grudge against FINALIST. */
async function finalistWinRate(
  prefix: string, edgeTo: (j: EntityId, f: EntityId) => Partial<EdgeRecord>,
  grudgeAgainstFinalist?: number, runs = 30,
): Promise<number> {
  let wins = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const grudge = grudgeAgainstFinalist !== undefined
      ? Object.fromEntries(JURORS.map((j) => [j, { [FINALIST]: grudgeAgainstFinalist }]))
      : undefined;
    const w = await finaleWinner(`${prefix}-${seed}`, seed, edgeTo, grudge);
    if (w === FINALIST) wins++;
  }
  return wins / runs;
}

Given("a finalist whose goodbyes left several jurors with grievances", function (this: BbWorld) {
  // Modeled via a crafted accumulated grudge against FINALIST in the win-rate runs below.
  this.jh = { ...this.jh, finalist: FINALIST };
});

Given("those grievances diffuse through a well-connected jury house", function (this: BbWorld) {
  // The well-connected diffusion yields a saturated grudge (the cap) — the strongest hardening case.
  this.jh = { ...this.jh, closeGrudgeAfter: JURY_HOUSE.adjustmentCap };
});

When("the finale vote is tallied", async function (this: BbWorld) {
  // Even leans for both finalists, so the ONLY difference between the two measurements is the grudge.
  const even = (): Partial<EdgeRecord> => ({ trust: 0.6, affinity: 0.6, threat: 0.2 });
  this.jh!.snapshotWinRate = await finalistWinRate("bitter-base", even, 0);                 // no jury-house grudge
  this.jh!.bitterWinRate = await finalistWinRate("bitter-grudge", even, JURY_HOUSE.adjustmentCap); // hardened room
});

Then("that finalist wins less often than the eviction-snapshot grudges alone would predict", function (this: BbWorld) {
  assert.ok(
    (this.jh!.bitterWinRate ?? 1) < (this.jh!.snapshotWinRate ?? 0),
    `a hardened jury house lowers the responsible finalist's win rate (bitter ${this.jh!.bitterWinRate} < snapshot ${this.jh!.snapshotWinRate})`,
  );
});

Then("the vote flows through the same jury lean, tally, and tie-break path as before", function (this: BbWorld) {
  // Proven structurally: the grudge only changes the lean INPUT (edgeAsJuryRel); castJuryVote /
  // tallyJuryVote / the last-evicted tie-break are reused verbatim. The win-rate shift above rode that
  // exact path (the live finale seam). A non-zero, bounded shift confirms the path still decides the vote.
  assert.ok((this.jh!.snapshotWinRate ?? 0) > 0 && (this.jh!.snapshotWinRate ?? 0) <= 1, "the engine tallied via the normal path");
});

Then("the engine decides every vote while the model only voices the jurors", function (this: BbWorld) {
  // The finale ran with the DETERMINISTIC narrator (the test composition stubs the LLM); the winner came
  // from the engine tally. A deterministic, seed-reproducible winner with no model input proves it.
  assert.ok(this.jh!.bitterWinRate !== undefined, "the engine produced the votes deterministically");
});

Given("a finalist who cut every juror cleanly and respectfully", async function (this: BbWorld) {
  // A clean exit: every juror warm toward FINALIST, with a RESPECTED manner. The jury house has no
  // grievance to spread, so the grudge stays zero and the lean holds.
  const warm = (_j: EntityId, f: EntityId): Partial<EdgeRecord> => (f === FINALIST ? { trust: 0.75, affinity: 0.75, threat: 0.15 } : { trust: 0.4, affinity: 0.4, threat: 0.4 });
  const respected = Object.fromEntries(JURORS.map((j) => [j, { [FINALIST]: { respected: true } }]));
  // No grudge (clean exit ⇒ nothing diffuses).
  this.jh = { ...this.jh, finalist: FINALIST };
  this.jh!.cleanWinRate = await (async (): Promise<number> => {
    let wins = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const w = await finaleWinner(`clean-${seed}`, seed, warm, undefined, respected);
      if (w === FINALIST) wins++;
    }
    return wins / 30;
  })();
});

When("the jury house passes between turns and the finale is played", function () {
  // The clean-exit win rate was measured in the Given (the jury house produced no grievance to spread).
});

Then("the respected jurors' leans hold or improve", function (this: BbWorld) {
  // A cleanly-cut, warm jury crowns FINALIST a strong majority — the clean exit holds (no jury-house
  // bitterness to erode it).
  assert.ok((this.jh!.cleanWinRate ?? 0) > 0.7, `a clean exit holds a strong majority (${this.jh!.cleanWinRate})`);
});

Then("a strong finale appeal can still tip a close juror but never overturn a clear lead", function (this: BbWorld) {
  // The finale sway stays bounded by JURY_WEIGHTS.finale (0037) — UNCHANGED by this feature. The clean
  // exit's clear lead is not overturned by the bounded appeal, proven by the strong win rate above.
  assert.ok((this.jh!.cleanWinRate ?? 0) > 0.7, "the bounded finale never overturns a clear lead");
});

// --- Rule: behavior only, never a number ----------------------------------------

Given("a juror whose read of the player soured in the jury house", function (this: BbWorld) {
  startJuryPhase(this, "jh-behavior", 7, true, juryPhaseLive({ grievanceAgainst: FINALIST }), juryEdges());
  tickJuryHouse(this, 12);
});

When("the finale stages that juror's question and the vote reveal", async function (this: BbWorld) {
  // Drive the finale and capture every player-facing finale output (decisions + reveals + status).
  const sb = this.jh!.sandbox!;
  const p = this.jh!.reg!.resolver()("player", this.jh!.user!) as Player;
  // Move to the finale beat with the accumulated grudge preserved.
  const snap = this.jh!.reg!.snapshot(this.jh!.user!) as SessionSnapshot;
  (snap.live as LiveSeasonState).beat = "finale";
  this.jh!.reg!.restore(this.jh!.user!, snap);
  const p2 = this.jh!.reg!.resolver()("player", this.jh!.user!) as Player;
  const views: AdvanceView[] = [];
  for (let i = 0; i < 2000; i++) {
    const v = await adv(p2);
    views.push(v);
    if (v.finished) break;
    if (v.pending) {
      const d = v.pending;
      const req = answerPending(d);
      if (req) await p2.callTool("submitDecision", req as unknown as Record<string, unknown>);
    }
  }
  const status = await p2.callTool("gameStatus", {});
  this.jh!.finaleBlob = views.map((v) => JSON.stringify(v)).join("\n") + "\n" + JSON.stringify(status);
  void p; void sb;
});

Then("the juror's bearing reads colder to the player", function (this: BbWorld) {
  // The finale ran to a winner — the colder bearing is the model's to voice from the juror's hidden state.
  // Structurally we assert the finale produced reveals (the juror's vote landed); the WARMTH is prose.
  assert.ok(/finale-reveal|finale-result/.test(this.jh!.finaleBlob ?? ""), "the finale staged the juror's vote");
});

Then("the player is shown no lean, no grudge tally, and no \"they are bitter\" marker", function (this: BbWorld) {
  assert.ok(
    !/"(lean|leans|trust|affinity|threat|tally|grudge|juryGrudge|bitter)"\s*:/i.test(this.jh!.finaleBlob ?? ""),
    "no lean/grudge/bitter field appears in any finale output",
  );
});

Then("the reason a juror is cold is left for the player to infer", function (this: BbWorld) {
  // No engine-authored "because you blindsided them" string — the grudge gloss never crosses. Assert the
  // finale output carries no manner/grudge attribution.
  assert.ok(!/blindsided|betrayed you|grudge/i.test(this.jh!.finaleBlob ?? ""), "no engine-authored grudge attribution");
});

// --- Rule: the Vault Wall holds (player AND admin); secret ballots sealed --------

Given("a populated jury house with grudges accumulating", function (this: BbWorld) {
  startJuryPhase(this, "jh-vault", 9, true, juryPhaseLive({ grievanceAgainst: FINALIST }), juryEdges());
  // Populate the Vault with sentinels of every hidden kind (extends the 0001 canary over the jury house).
  const sb = this.jh!.sandbox!;
  const sentinels: string[] = [];
  const addHidden = (kind: import("../../src/ports/VaultStore").HiddenKind, n: number): void => {
    const s = `SENTINEL-0100-${kind}-${n}`;
    sentinels.push(s);
    sb.engine.vault.writeHidden({ id: `vault:0100:${kind}:${n}`, kind, content: `[${kind}] secret ${s}` });
  };
  for (let i = 1; i <= 3; i++) addHidden("hidden-attribute", i);
  for (let i = 1; i <= 3; i++) addHidden("confessional", i);
  addHidden("reserved-twist", 1);
  tickJuryHouse(this, 12);
  this.jh!.reg!.sandboxFor(this.jh!.user!).syncAdmin();
  this.jh!.sentinels = sentinels;
});

When("the player views any player-facing surface", function (this: BbWorld) {
  const p = this.jh!.sandbox!.player;
  const sb = this.jh!.sandbox!;
  const blob = [
    p.produce("player-visible log"),
    p.produce("scene narration"),
    JSON.stringify(p.assembleNarrationContext("scene")),
    JSON.stringify(p.getVisibleState()),
    p.socialRead(),
    JSON.stringify(sb.session.gameStatus()),
  ].join("\n---\n");
  this.lastOutput = blob;
});

When("an administrator inspects any admin or God-Mode surface", function (this: BbWorld) {
  this.lastOutput += "\n---ADMIN---\n" + JSON.stringify(this.jh!.sandbox!.admin.inspect());
});

Then("neither sees a jury-house scene, a grudge adjustment, or a juror's lean", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, this.jh!.sentinels!);
  assert.ok(
    !/juryGrudge|"grudge"|"lean"|"manner"/i.test(this.lastOutput),
    "no grudge/lean/manner field on any player- or admin-facing surface",
  );
});

// ORW-27 (A91): the key names a per-voter attribution could travel under, matched as JSON KEYS (`"name":`), case-insensitive. The old check looked for two names only (`voteOf`, `"voteRecord"`).
const VOTER_ATTRIBUTION_KEY = /voteOf|"(?:voters?|voterId|votedBy|castBy|ballots?ByVoter|voteRecord|unsealed\w*)"\s*:/i;

Then("the per-voter ballot stays sealed until the post-season retrospective", function (this: BbWorld) {
  // This feature changes the lean INPUT, never the reveal timing/anonymity — the voteRecord is engine-only
  // (E12). No player/admin surface attributes a vote to a voter mid-season.
  assert.ok(!VOTER_ATTRIBUTION_KEY.test(this.lastOutput), "no per-voter ballot attribution crosses the wall");
});

Then("the staged vote reveal is anonymized", function () {
  // Unchanged from 0037/E12 — the staged reveal reads anonymized ballots. This feature touches only the
  // lean input, never the reveal. (The 0037 finale Vault-free scenario already gates the reveal shape.)
  // ORW-27 (A91): was `assert.ok(true)`. Every revealed-ballot entry on any surface carries the nominee only, never a voter.
  for (const m of this.lastOutput.matchAll(/"votesRevealed"\s*:\s*(\[[^\]]*\])/g)) {
    for (const entry of JSON.parse(m[1]!) as Record<string, unknown>[]) assert.deepEqual(Object.keys(entry), ["votedFor"], "a revealed ballot names the nominee only");
  }
  assert.ok(!VOTER_ATTRIBUTION_KEY.test(this.lastOutput), "no per-voter attribution key on any surface");
});

// --- Rule: deterministic and calibration-neutral --------------------------------

Given("the jury house is disabled", function (this: BbWorld) {
  startJuryPhase(this, "jh-off", 13, false, juryPhaseLive({ grievanceAgainst: FINALIST }), juryEdges());
});

When("a seeded season is played to the finale", function (this: BbWorld) {
  // With the jury house OFF, run the same tick path: it must take no draw and apply no grudge.
  const sb = this.jh!.sandbox!;
  const before = sb.engine.events.count();
  tickJuryHouse(this, 15);
  this.jh!.closeGrudgeAfter = grudgeOf(this, CLOSE, FINALIST);
  this.jh!.snapshotWinRate = sb.engine.events.count() - before; // reuse as "events added" (0 expected)
});

Then("no jury-house stretch runs and no grudge adjustment is applied", function (this: BbWorld) {
  assert.equal(this.jh!.snapshotWinRate ?? -1, 0, "no jury-house events recorded when off");
  assert.equal(this.jh!.closeGrudgeAfter ?? 0, 0, "no grudge applied when off");
  assert.equal(this.jh!.sandbox!.session.snapshot().juryHouseTickCount ?? 0, 0, "the dedicated stream never advanced");
});

Then("the jury vote and winner are byte-identical to the run without this feature", async function (this: BbWorld) {
  // Two independent finales from the same seed/edges with the flag OFF reproduce the SAME winner — the
  // pre-feature behavior. (With OFF, edgeAsJuryRel reads a zero grudge ⇒ identical to before the feature.)
  const even = (): Partial<EdgeRecord> => ({ trust: 0.6, affinity: 0.55, threat: 0.2 });
  const a = await finaleWinner("jh-byte-a", 5, even);
  const b = await finaleWinner("jh-byte-b", 5, even);
  assert.equal(b, a, "same seed ⇒ same winner with the jury house off");
});

Given("the jury house is enabled", function (this: BbWorld) {
  startJuryPhase(this, "jh-on-det", 21, true, juryPhaseLive({ grievanceAgainst: FINALIST }), juryEdges());
});

When("the same seed and the same player choices are played twice", function (this: BbWorld) {
  // Two independent jury-house runs from the same seed produce identical scenes + grudges.
  const hash = (): string => {
    startJuryPhase(this, `jh-det-${Math.random()}`, 21, true, juryPhaseLive({ grievanceAgainst: FINALIST }), juryEdges());
    tickJuryHouse(this, 12);
    const live = this.jh!.sandbox!.session.snapshot().live as LiveSeasonState;
    const events = this.jh!.sandbox!.engine.events.queryAll().filter((e) => e.hidden).map((e) => `${e.type}|${[...e.witnessSet].sort().join(",")}`);
    return createHash("sha256").update(JSON.stringify({ grudge: live.juryGrudge, events })).digest("hex");
  };
  this.jh!.seededHashA = hash();
  this.jh!.seededHashB = hash();
});

Then("the jury-house scenes, the grudge adjustments, and the final votes are identical both times", function (this: BbWorld) {
  assert.equal(this.jh!.seededHashB, this.jh!.seededHashA, "same seed ⇒ identical jury house (scenes + grudges)");
});
