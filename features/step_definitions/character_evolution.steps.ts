import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { evolveEmotion, arcNote } from "../../src/engine/emotionalArc";
import { nominationStrategy } from "../../src/engine/season";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import type { Competitor } from "../../src/domain/competitionOutcome";
import { RelationshipModel } from "../../src/engine/relationships";
import { SoulStore } from "../../src/adapters/engine/SoulStore";
import { DeterministicEmbedding } from "../../src/adapters/embedding/DeterministicEmbedding";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { McpServer } from "../../src/adapters/mcp/McpServer";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { GameHouse, Soul } from "../../src/engine/characterFactory";
import { npc } from "../../src/domain/ids";
import { answerPending } from "../support/answerPending";

// Feature 0041 — a season changes a houseguest: live emotional evolution that modulates behavior,
// accumulates as a recall-able arc, while the static CHARACTER stays byte-stable. Hidden layer only.
// HARD rule: roles only — houseguest, HOH, nominee, evictee. No names.

const settledSoul = (): Soul => ({ emotionalBaseline: 0.5, volatility: 0.4, emotionalState: 0.5, emotionalHistory: [], memory: [] });
const fake = new DeterministicEmbedding();

/** Drive a live game a bounded number of beats, resolving every player decision legally. */
async function driveLive(player: McpServer, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    const adv = (await player.callTool("advanceGame", {})) as AdvanceView;
    if (adv.finished) return;
    const p = adv.pending;
    if (!p) continue;
    const req = answerPending(p);
    if (req) await player.callTool("submitDecision", req as unknown as Record<string, unknown>);
  }
}

const houseOf = (reg: GameSessionRegistry, user: string): GameHouse => reg.sandboxFor(user).session.snapshot().house!;
const souls = (h: GameHouse) => [h.player, ...h.npcs];

// --- Scenario: a blindside shifts the houseguest's emotional state --------------

Given("a houseguest with a settled emotional state", function (this: BbWorld) {
  this.evoSoul = settledSoul();
  this.evoStart = { state: this.evoSoul.emotionalState, volatility: this.evoSoul.volatility };
});

When("they live through a blindside on the live path", function (this: BbWorld) {
  // `evolveEmotion` is exactly what the live consequence fold calls at an eviction (GameSessionAdapter).
  evolveEmotion(this.evoSoul!, "blindside");
});

Then("their hidden emotional state shifts toward distress and volatility", function (this: BbWorld) {
  assert.ok(this.evoSoul!.emotionalState < this.evoStart!.state, "distress: state fell below the settled baseline");
  assert.ok(this.evoSoul!.volatility > this.evoStart!.volatility, "more volatile after the shock");
  assert.equal(this.evoSoul!.emotionalHistory.length, 1, "the arc recorded the new level");
});

// --- Scenario: the shift modulates later behavior -------------------------------

Given("the same houseguest rattled versus calm", function (this: BbWorld) {
  // A decision setup: a clear top threat, a trusted 2nd, and a distrusted low-threat houseguest.
  const hoh = npc(1), top = npc(2), trusted = npc(3), distrusted = npc(4);
  this.evoHoh = hoh;
  const rel = new RelationshipModel(0.5);
  const set = (to: ReturnType<typeof npc>, threat: number, trust: number): void => {
    const e = rel.edge(hoh, to); e.threat = threat; e.trust = trust;
  };
  set(top, 0.9, 0.5); set(trusted, 0.6, 0.9); set(distrusted, 0.5, 0.0);
  // 0044 §9: keep the floater / duo reads out of this mood check — a fifth houseguest is in everyone's
  // corner (one-way, so no mutual pair) and the HOH trusts them, so only threat + paranoia separate.
  const fan = npc(5);
  for (const c of [top, trusted, distrusted]) { const e = rel.edge(fan, c); e.trust = 0.9; e.affinity = 0.9; }
  { const h = rel.edge(hoh, fan); h.trust = 0.9; h.affinity = 0.9; h.threat = 0; }
  this.dealRel = rel; // reuse a RelationshipModel slot
  const active = [hoh, top, trusted, distrusted, fan];
  this.evoNomsCalm = nominationStrategy(hoh, active, rel, { mood: 0.5 });
  this.evoNomsRattled = nominationStrategy(hoh, active, rel, { mood: 0.0 });

  // A competition setup: the same field resolved with the focal houseguest calm vs rattled — the ONLY
  // difference is mood, so the score delta is purely the emotional modifier (anti-sycophancy holds).
  const field = (mood: number): Competitor[] => [
    { id: top, stats: { physical: 0.6, mental: 0.5, social: 0.5 }, emotionalState: mood },
    { id: trusted, stats: { physical: 0.52, mental: 0.5, social: 0.5 } },
    { id: distrusted, stats: { physical: 0.5, mental: 0.5, social: 0.5 } },
  ];
  this.evoCompCalm = resolveCompetition(field(0.5), "physical", new CompetitionIntents(), new SeededRandom(3)).scores[top];
  this.evoCompRattled = resolveCompetition(field(0.15), "physical", new CompetitionIntents(), new SeededRandom(3)).scores[top];
});

When("each plays a competition and faces a decision", function () {
  // Both already computed deterministically in the Given (calm vs rattled), so the comparison is exact.
});

Then("the rattled version behaves measurably differently from the calm version", function (this: BbWorld) {
  // Competition: the rattled houseguest scores measurably lower (the emotional modifier bit).
  assert.ok((this.evoCompRattled ?? 0) < (this.evoCompCalm ?? 0) - 0.1, "rattled competes measurably worse");
  // Decision: the rattled HOH's nominations differ from the calm HOH's.
  assert.notDeepEqual(this.evoNomsRattled, this.evoNomsCalm, "a rattled HOH nominates differently");
});

Then("emotion never overrides a hard rule", function (this: BbWorld) {
  for (const noms of [this.evoNomsCalm!, this.evoNomsRattled!]) {
    assert.equal(new Set(noms).size, 2, "two distinct nominees");
    assert.ok(!noms.includes(this.evoHoh!), "the HOH is never on their own block");
  }
});

// --- Scenario: the change accumulates into a persisted arc (LIVE path) -----------
// PAT-5 (#1982): this used to drive a standalone `SoulStore` and assert `SoulProvider.recall`, which has no
// production caller. The live arc is `GameSessionAdapter.inflect`: it appends an `arcNote` to the houseguest's
// persisted `soul.memory` and `emotionalHistory`, which the save -> resume path restores. Assert THAT, on a
// season actually played through the live loop.

const ARC_NOTE = /^week \d+: /;
type ArcState = { id: string; notes: string[]; history: number };
const arcCtx = new WeakMap<object, { player: McpServer; arc: ArcState }>();
const arcOf = (reg: GameSessionRegistry, user: string): ArcState[] =>
  houseOf(reg, user).npcs.map((n) => ({ id: n.id, notes: n.soul.memory.filter((m) => ARC_NOTE.test(m)), history: n.soul.emotionalHistory.length }));

Given("a houseguest who has been through several season-shaping events", async function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  this.registry = reg; this.liveUser = "evo-bdd-arc";
  const player = reg.resolver()("player", this.liveUser) as McpServer;
  await player.callTool("createCharacter", { playerName: "P", seed: 2 });
  await driveLive(player, 200);
  const arcs = arcOf(reg, this.liveUser).filter((a) => a.notes.length > 0);
  assert.ok(arcs.length > 0, "the played season inflected at least one houseguest (an arc note was recorded)");
  const focal = arcs.sort((x, y) => y.notes.length - x.notes.length)[0]!;
  assert.ok(focal.notes.length >= 2, `accumulation needs MULTIPLE inflections on one houseguest, got ${focal.notes.length}`);
  arcCtx.set(this, { player, arc: focal });
});

Then("their soul accumulates those moments without losing earlier ones", async function (this: BbWorld) {
  const { player, arc: before } = arcCtx.get(this)!;
  await driveLive(player, 120); // the season goes on...
  const after = arcOf(this.registry!, this.liveUser!).find((a) => a.id === before.id)!;
  assert.ok(before.notes.length >= 2, "the houseguest already held several inflections before the season went on");
  assert.ok(after.notes.length >= before.notes.length, "the arc only grows");
  assert.deepEqual(after.notes.slice(0, before.notes.length), before.notes, "every earlier inflection is retained, in order");
  assert.ok(after.history >= before.history, "the persisted emotional arc grew monotonically");
  arcCtx.set(this, { player, arc: after });
});

Then("a specific past inflection is held in the persisted arc and survives save and resume", function (this: BbWorld) {
  const held = arcCtx.get(this)!.arc;
  const snap = JSON.parse(JSON.stringify(this.registry!.snapshot(this.liveUser!)));
  const resumed = new GameSessionRegistry().restore(this.liveUser!, snap);
  const hg = resumed.session.snapshot().house!.npcs.find((n) => n.id === held.id)!;
  for (const note of held.notes) assert.ok(hg.soul.memory.includes(note), `the inflection "${note}" survives resume`);
  assert.equal(hg.soul.emotionalHistory.length, held.history, "the persisted emotional arc survives resume");
});

// --- Scenario: the static character stays byte-stable while the soul drifts ------

Given("a houseguest at the start and deep into the season", async function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  this.registry = reg; this.liveUser = "evo-bdd-stable";
  const player = reg.resolver()("player", this.liveUser) as McpServer;
  await player.callTool("createCharacter", { playerName: "P", seed: 2 });
  // Capture every static character byte-for-byte at the start.
  this.evoCharStart = new Map(souls(houseOf(reg, this.liveUser)).map((hg) => [hg.id, JSON.stringify(hg.character)]));
  await driveLive(player, 200);
});

Then("their static character baseline is unchanged", function (this: BbWorld) {
  const house = houseOf(this.registry!, this.liveUser!);
  for (const hg of souls(house)) {
    assert.equal(JSON.stringify(hg.character), this.evoCharStart!.get(hg.id), "the static character never drifted");
  }
});

Then("only their dynamic soul has drifted", function (this: BbWorld) {
  const house = houseOf(this.registry!, this.liveUser!);
  const drifted = souls(house).find((hg) => hg.soul.emotionalHistory.length > 0 || hg.soul.emotionalState !== 0.5);
  assert.ok(drifted, "at least one houseguest's soul drifted over the season");
});

// --- Scenario: emotional drift is bounded, mean-reverting, and deterministic -----

Given("a houseguest whose emotional state spiked", function (this: BbWorld) {
  this.evoSoul = settledSoul();
  evolveEmotion(this.evoSoul, "blindside");
  evolveEmotion(this.evoSoul, "betrayed");
  this.evoSpiked = this.evoSoul.emotionalState;
});

When("the game calms for a stretch", function (this: BbWorld) {
  for (let i = 0; i < 6; i++) evolveEmotion(this.evoSoul!, "calm");
});

Then("their emotional state reverts toward their baseline within bounds", function (this: BbWorld) {
  const s = this.evoSoul!;
  const before = Math.abs(this.evoSpiked! - s.emotionalBaseline);
  const after = Math.abs(s.emotionalState - s.emotionalBaseline);
  assert.ok(after < before, "settled back toward the calm baseline");
  assert.ok(s.emotionalState >= 0 && s.emotionalState <= 1, "stayed within bounds");
});

Then("the same seed reproduces the same arc", function (this: BbWorld) {
  const run = (): number[] => {
    const s = settledSoul();
    for (const e of ["blindside", "betrayed", "calm", "calm", "comp-win", "calm"] as const) evolveEmotion(s, e);
    return s.emotionalHistory;
  };
  this.evoArcA = run(); this.evoArcB = run();
  assert.deepEqual(this.evoArcA, this.evoArcB, "the arc is fully deterministic");
});

// --- Scenario: the evolution is Vault-free --------------------------------------

Given("a started game whose houseguests have evolved", async function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  this.registry = reg; this.liveUser = "evo-bdd-wall";
  const player = reg.resolver()("player", this.liveUser) as McpServer;
  this.livePlayer = player;
  await player.callTool("createCharacter", { playerName: "P", seed: 7 });
  await driveLive(player, 80);
});

When("the player's surfaces are read after the houseguests evolve", async function (this: BbWorld) {
  const player = this.livePlayer!;
  const sb = this.registry!.sandboxFor(this.liveUser!);
  this.lastOutput = [
    JSON.stringify(await player.callTool("gameStatus", {})),
    JSON.stringify(await player.callTool("getGameState", {})),
    JSON.stringify(await player.callTool("getMomentPrompt", {})),
    sb.player.produce("player-visible log"),
    JSON.stringify(sb.player.getVisibleState()),
    JSON.stringify(sb.player.assembleNarrationContext("scene")),
  ].join("\n---\n");
});

Then("no emotional number or hidden state appears", function (this: BbWorld) {
  const house = houseOf(this.registry!, this.liveUser!);
  const evolved = souls(house).filter((hg) => hg.soul.emotionalState !== 0.5).map((hg) => String(hg.soul.emotionalState));
  assert.ok(evolved.length > 0, "there IS hidden evolved state to leak");
  for (const v of evolved) assert.ok(!this.lastOutput.includes(v), "an emotional number leaked onto a player surface");
  // AMEND 0041 #4: a ROUNDED copy of a hidden number would slip the exact-string check above (0.6234 -> "0.62" / "62%"). Search the 2-decimal and percent renderings of every evolved
  // emotionalState / volatility too. (Seed 7's player surfaces carry no other decimals that collide; a collision would be a real finding to investigate, not to loosen.)
  const hidden = souls(house).flatMap((hg) => [hg.soul.emotionalState, hg.soul.volatility]).filter((v) => typeof v === "number" && v !== 0.5);
  for (const v of hidden) {
    const forms = [v.toFixed(2), `${Math.round(v * 100)}%`];
    for (const f of forms) assert.ok(!new RegExp(`(?<![\\d.])${f.replace(".", "\\.")}(?![\\d])`).test(this.lastOutput!), `a rounded hidden emotional value (${f}) leaked onto a player surface`);
  }
  for (const field of ["emotionalState", "emotionalHistory", "emotionalBaseline", "volatility"]) {
    assert.ok(!this.lastOutput.includes(field), `the hidden soul field ${field} leaked onto a player surface`);
  }
});
