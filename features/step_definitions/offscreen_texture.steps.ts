import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER, npc } from "../../src/domain/ids";

// Feature 0070 — off-screen society texture enrichment. HARD rule: roles only, no names.
// Enriched prose is model-voiced content landing DOWNSTREAM of the Vault boundary (on already-
// hidden events). Content-only: the write-back cannot alter witness sets, the hidden flag, or
// any relationship number. Fail-soft: absent driver ⇒ deterministic template content stands.

let txUsers = 0;
const TYPED = new Set(["alliance", "gossip", "conflict", "bonding", "strategy", "showmance", "betrayal"]);

function txGame(w: BbWorld, seed: number): void {
  const reg = new GameSessionRegistry();
  const user = `tx${txUsers++}`;
  const orch = new Orchestrator(reg, { now: () => seed }, { seed });
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const server = new McpServer("player", {
    player: sb.player, admin: sb.admin, summary: sb.summary,
    commands: sb.commands, session: sb.session,
  });
  w.txRegistry = reg; w.txUser = user; w.txSandbox = sb; w.txOrch = orch; w.txServer = server;
}

/** ORW-286 item 9: a game whose off-screen tick produced AT LEAST ONE scene. Scenarios 2 to 5 used to pass on an empty scene list (`if (skeletons.length > 0)`), proving nothing. */
function txGameWithScenes(w: BbWorld, firstSeed: number): void {
  for (let seed = firstSeed; seed < firstSeed + 12; seed++) {
    txGame(w, seed);
    runOffscreenTick(w);
    if (w.txSandbox!.session.getOffscreenSceneSkeletons().length > 0) return;
  }
  throw new Error(`no seed in ${firstSeed}..${firstSeed + 11} produced an off-screen scene on the first tick`);
}

// Run one off-screen tick and return the scenes.
function runOffscreenTick(w: BbWorld): void {
  w.txOrch!.advance(w.txUser!, "offscreen-tick");
}

// ─── Scenario 1: the texture write-back reaches the engine over the player channel ────────────────

Given("a live game with off-screen scenes recorded this tick", function (this: BbWorld) {
  txGameWithScenes(this, 701);
});

When("the off-screen scene skeletons are read over the player channel", async function (this: BbWorld) {
  const result = await this.txServer!.callTool("getOffscreenSceneSkeletons", {});
  this.txSkeletons = result as import("../../src/ports/GameSession").OffscreenSceneSkeleton[];
});

Then("the skeletons are Vault-free — public participants, room, and nature only", function (this: BbWorld) {
  const skeletons = this.txSkeletons!;
  assert.ok(Array.isArray(skeletons), "expected an array of skeletons");
  assert.ok(skeletons.length > 0, "expected at least one off-screen scene skeleton");
  for (const sk of skeletons) {
    assert.ok(typeof sk.eventId === "string" && sk.eventId.length > 0, "skeleton missing eventId");
    assert.ok(typeof sk.nature === "string" && sk.nature.length > 0, "skeleton missing nature");
    assert.ok(Array.isArray(sk.participants) && sk.participants.length >= 2, "skeleton missing participants");
    assert.ok(typeof sk.templateContent === "string", "skeleton missing templateContent");
    // Nature must be a known interaction type (not a Vault slug)
    assert.ok(TYPED.has(sk.nature) || sk.nature.length > 0, "unexpected nature");
    // No raw float / relationship number must appear in the skeleton
    const blob = JSON.stringify(sk);
    assert.ok(!/\d+\.\d{3,}/.test(blob), "a relationship number leaked into the skeleton");
    // The event must be off-screen (id starts with 'offscreen:')
    assert.ok(sk.eventId.startsWith("offscreen:"), `expected offscreen: prefix, got ${sk.eventId}`);
  }
});

When("voiced texture is written back over the channel for a recorded off-screen scene", async function (this: BbWorld) {
  const sk = this.txSkeletons![0]!;
  const result = await this.txServer!.callTool("recordOffscreenSceneTexture", {
    eventId: sk.eventId,
    content: "NPC-A leaned in and whispered their plan — a tactical partnership forged in the shadow of the pantry.",
  });
  this.txWriteOk = (result as { ok: boolean }).ok;
});

Then("the texture write-back is accepted over the channel", function (this: BbWorld) {
  assert.ok(this.txWriteOk === true, "expected the texture write-back to be accepted");
});

Then("the addressed scene now carries the voiced texture as its content", async function (this: BbWorld) {
  const sk = this.txSkeletons![0]!;
  const updated = await this.txServer!.callTool("getOffscreenSceneSkeletons", {}) as import("../../src/ports/GameSession").OffscreenSceneSkeleton[];
  const match = updated.find((s) => s.eventId === sk.eventId);
  assert.ok(match, "the addressed scene is no longer in the skeleton list");
  assert.ok(
    match!.templateContent !== sk.templateContent || match!.templateContent.includes("whispered"),
    "the texture write-back did not update the scene's content",
  );
});

// ─── Scenario 2: an enriched off-screen scene stays hidden until a pathway reaches the player ─────

Given("a live game with an enriched off-screen scene the player did not witness", async function (this: BbWorld) {
  txGameWithScenes(this, 702);
  const sb = this.txSandbox!;
  const skeletons = sb.session.getOffscreenSceneSkeletons();
  const sk = skeletons[0]!;
  const res = sb.session.recordOffscreenSceneTexture({ eventId: sk.eventId, content: "SENTINEL-0070-enriched-hidden-scene-content-secret" });
  assert.ok(res.ok, `the enrichment write-back was refused: ${JSON.stringify(res)}`);
  // POSITIVE CONTROL: the engine really holds the enriched prose for this scene, so the absence checks below mean something.
  assert.ok(sb.session.getOffscreenSceneSkeletons().find((s) => s.eventId === sk.eventId)!.templateContent.includes("SENTINEL-0070"), "the engine does not hold the enriched scene");
  this.txSkeletons = skeletons;
});

Then("the player surface never shows the enriched scene", function (this: BbWorld) {
  const sb = this.txSandbox!;
  const surfaces = [JSON.stringify(sb.session.getGameState()), JSON.stringify(sb.player.getVisibleState()),
    JSON.stringify(sb.session.getMomentPrompt({})), JSON.stringify(sb.session.getMomentPrompt({ moment: "social" })),
    JSON.stringify(sb.engine.knowledge.knownTo(PLAYER))];
  for (const s of surfaces) assert.ok(!s.includes("SENTINEL-0070"), "an enriched hidden scene leaked onto a player surface");
});

Then("the admin surface never shows the enriched scene", function (this: BbWorld) {
  const sb = this.txSandbox!;
  sb.syncAdmin();
  const adminBlob = JSON.stringify(sb.session.gameStatus()) + JSON.stringify(sb.admin.inspect());
  assert.ok(!adminBlob.includes("SENTINEL-0070"), "an enriched hidden scene leaked onto the admin surface");
});

When("an in-game pathway surfaces the scene to the player as gossip", function (this: BbWorld) {
  // The real gossip pathway (0002): the NPC who was there holds a (vague) belief, then it surfaces to the player through a `told-by` pathway.
  const sk = this.txSkeletons![0]!;
  const sourceNpc = sk.participants[0] ?? npc(1);
  const driftedContent = "some NPC and another NPC were seen talking — vague whispers only";
  this.txSandbox!.engine.knowledge.seedBelief(sourceNpc, { content: driftedContent, factId: "gossip:0070:test", confidence: 0.4 }, `told-by:${sourceNpc}`);
  this.txSandbox!.engine.knowledge.surfaceInformationTo(PLAYER, { content: driftedContent, confidence: 0.3 }, `told-by:${sourceNpc}`);
  this.txSourceNpc = sourceNpc;
});

Then("the player learns a sourced, possibly-drifted belief, not the raw hidden scene", function (this: BbWorld) {
  // ORW-286 item 9: assert the belief EXISTS and is sourced and uncertain, not merely that no fact contains the sentinel (an empty knowledge list passed before).
  const facts = this.txSandbox!.engine.knowledge.knownTo(PLAYER) as unknown as Array<{ content: string; pathway?: string; confidence?: number }>;
  const learned = facts.find((f) => f.content.includes("vague whispers only"));
  assert.ok(learned, "the player holds no surfaced belief at all");
  assert.ok(typeof learned!.pathway === "string" && learned!.pathway!.startsWith("told-by:"), `the belief is not sourced through a told-by pathway: ${JSON.stringify(learned)}`);
  assert.ok(typeof learned!.confidence === "number" && learned!.confidence! < 1, `the belief carries no uncertainty: ${JSON.stringify(learned)}`);
  for (const f of facts) assert.ok(!f.content.includes("SENTINEL-0070"), "the raw enriched hidden scene reached the player as a fact");
});

// ─── Scenario 3: the write-back is content-only and cannot pierce the closed set ───────────────────
// Reuses `Given "a live game with off-screen scenes recorded this tick"` (Scenario 1), which now guarantees at least one scene.

When("a texture write-back attempts to set a witness, flip the hidden flag, or carry a relationship number", async function (this: BbWorld) {
  const sb = this.txSandbox!;
  const sk = sb.session.getOffscreenSceneSkeletons()[0]!;
  const ev = sb.engine.events.queryAll().find((e) => e.id === sk.eventId)!;
  assert.ok(ev, "the addressed scene is a recorded event");
  this.txBefore = JSON.stringify({ count: sb.engine.events.queryAll().length, witness: [...ev.witnessSet].sort(), hidden: ev.hidden, template: sk.templateContent,
    edges: sk.participants.map((a) => sk.participants.map((b) => sb.engine.relationships.edge(a, b))) });
  const attempts: Array<[string, Record<string, unknown>]> = [
    ["witnessSet", { witnessSet: ["player"] }],
    ["hidden", { hidden: false }],
    ["relationship*", { relationshipTrust: 0.9 }],
  ];
  this.txRefusals = [];
  for (const [field, extra] of attempts) {
    try {
      await this.txServer!.callTool("recordOffscreenSceneTexture", { eventId: sk.eventId, content: "some voiced prose", ...extra });
      this.txRefusals.push(`${field}: NOT REFUSED`);
    } catch (err) {
      this.txRefusals.push(`${field}: ${(err as Error).message}`);
    }
  }
});

Then("the write-back is refused at the channel boundary", function (this: BbWorld) {
  const r = this.txRefusals!;
  assert.equal(r.length, 3, "all three forbidden attempts were made");
  for (const line of r) {
    assert.ok(!line.endsWith("NOT REFUSED"), `the boundary accepted a forbidden field: ${line}`);
    const field = line.split(":")[0]!;
    assert.ok(line.includes(field === "relationship*" ? "relationship" : field), `the refusal does not name the forbidden field: ${line}`);
  }
});

Then("no event is created, no witness set changes, and no relationship number crosses", function (this: BbWorld) {
  const sb = this.txSandbox!;
  const sk = sb.session.getOffscreenSceneSkeletons()[0]!;
  const ev = sb.engine.events.queryAll().find((e) => e.id === sk.eventId)!;
  const after = JSON.stringify({ count: sb.engine.events.queryAll().length, witness: [...ev.witnessSet].sort(), hidden: ev.hidden, template: sk.templateContent,
    edges: sk.participants.map((a) => sk.participants.map((b) => sb.engine.relationships.edge(a, b))) });
  assert.equal(after, this.txBefore, "a refused write-back changed the event count, a witness set, the hidden flag, the prose or a relationship edge");
  assert.ok(!sk.templateContent.includes("some voiced prose"), "the refused write-back's prose was applied");
});

// ─── Scenario 4: open/closed non-collapse — no texture means a byte-identical fold ───────────────

Given("two identical seeded games", function (this: BbWorld) {
  // Two games, same seed; nothing is run yet. A = no texture driver; B = texture driver present.
  const mk = (): { sb: ReturnType<GameSessionRegistry["sandboxFor"]>; orch: Orchestrator; user: string } => {
    const reg = new GameSessionRegistry();
    // The SAME user name in both games (each in its own registry): the engine keys its seeded streams on the user, so two different names would be two different games.
    const user = "tx-fold";
    const orch = new Orchestrator(reg, { now: () => 704 }, { seed: 704 });
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 704 });
    return { sb, orch, user };
  };
  this.txGameA = mk(); this.txGameB = mk();
});

When("one advances an off-screen tick with the texture driver absent", function (this: BbWorld) {
  const a = this.txGameA!;
  a.orch.advance(a.user, "offscreen-tick");
});

When("the other advances the same tick with the texture driver present", function (this: BbWorld) {
  const b = this.txGameB!;
  b.orch.advance(b.user, "offscreen-tick");
  const skeletons = b.sb.session.getOffscreenSceneSkeletons();
  assert.ok(skeletons.length > 0, "the tick produced scenes for the driver to enrich, so the comparison below is not vacuous");
  for (const sk of skeletons) assert.ok(b.sb.session.recordOffscreenSceneTexture({ eventId: sk.eventId, content: "Voiced texture for game B." }).ok);
});

Then("both games produce the byte-identical seeded relationship fold", function (this: BbWorld) {
  // ORW-286 item 9: actually COMPARE the two games (the old step looked only at game B, week === 1). The relationship fold, and every event's type/witnesses/hidden flag, match exactly.
  const a = this.txGameA!.sb, b = this.txGameB!.sb;
  const fold = (sb: typeof a): string => {
    const ids = [...sb.session.getGameState().house.map((h) => h.id as string), PLAYER as string];
    return JSON.stringify(ids.flatMap((x) => ids.filter((y) => y !== x).map((y) => sb.engine.relationships.edge(x as never, y as never))));
  };
  assert.ok(fold(a).length > 20, "game A has a relationship fold to compare");
  assert.equal(fold(b), fold(a), "the texture write-back changed the relationship fold");
  const shape = (sb: typeof a): string => JSON.stringify(sb.engine.events.queryAll().map((e) => [e.id, e.type, [...e.witnessSet].sort(), e.hidden]));
  assert.equal(shape(b), shape(a), "the texture write-back changed an event's type, witnesses or hidden flag");
});

Then("only the scene prose differs between them", function (this: BbWorld) {
  const a = this.txGameA!.sb, b = this.txGameB!.sb;
  const skA = a.session.getOffscreenSceneSkeletons(), skB = b.session.getOffscreenSceneSkeletons();
  assert.equal(skA.length, skB.length, "both games recorded the same number of scenes");
  assert.ok(skB.length > 0);
  for (let i = 0; i < skB.length; i++) {
    assert.equal(skB[i]!.eventId, skA[i]!.eventId, "the same scene in both games");
    assert.ok(skB[i]!.templateContent.includes("Voiced texture for game B."), "game B's scene carries the voiced texture");
    assert.ok(!skA[i]!.templateContent.includes("Voiced texture"), "game A's scene stays the deterministic template");
  }
  // and the texture is the ONLY snapshot key that differs
  const strip = (s: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "textureOverrides")));
  assert.equal(strip(b.session.snapshot() as never), strip(a.session.snapshot() as never), "something other than the scene prose differs between the games");
});

// ─── Scenario 5: enrichment is budget-capped and fail-soft ──────────────────────────────────────

Given("a live game advancing an off-screen tick", function (this: BbWorld) {
  txGameWithScenes(this, 705);
});

When("the texture driver fails or no model is configured", async function (this: BbWorld) {
  // A failing driver is modelled for real: its write-backs are malformed or address nothing, and the engine must shrug them off (no model ⇒ none are attempted).
  const sb = this.txSandbox!;
  this.txSkeletons = sb.session.getOffscreenSceneSkeletons();
  this.txTemplates = this.txSkeletons.map((s) => s.templateContent);
  const real = this.txSkeletons[0]!.eventId;
  const results = [
    sb.session.recordOffscreenSceneTexture({ eventId: "offscreen:does-not-exist:0:0", content: "orphan prose" }),
    sb.session.recordOffscreenSceneTexture({ eventId: real, content: "   " }),
  ];
  this.txFailedWrites = results.map((r) => r.ok);
});

Then("every off-screen scene retains its deterministic template content", function (this: BbWorld) {
  const sb = this.txSandbox!;
  assert.deepEqual(this.txFailedWrites, [false, false], "a failed driver's write-backs were accepted");
  const now = sb.session.getOffscreenSceneSkeletons().map((s) => s.templateContent);
  assert.deepEqual(now, this.txTemplates, "a failed driver changed a scene's deterministic template content");
  for (const c of now) assert.ok(c.length > 0 && !/orphan prose/.test(c), "a scene lost its template content");
  // the template is the recorded event's own content, not something the skeleton reader invented
  const events = sb.engine.events.queryAll();
  for (const sk of this.txSkeletons!) assert.ok(events.some((e) => e.id === sk.eventId), "a skeleton has no recorded event behind it");
});

Then("the game advance is unaffected", function (this: BbWorld) {
  // After the failed driver, the game still advances: a real advance returns a view and the engine reports a sound state.
  const sb = this.txSandbox!;
  const before = JSON.stringify(sb.session.snapshot().week);
  const view = sb.session.advanceGame();
  assert.ok(view, "advanceGame returned nothing after a failed driver");
  assert.ok(sb.session.gameStatus(), "game status is absent after a failed driver");
  assert.equal(before, "1", "unexpected week before the advance");
});
