import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { buildSandbox } from "../../tests/support/sandbox";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { toolsFor } from "../../src/surfaces/tools/registry";
import type { OutwardChannel } from "../../src/surfaces/tools/registry";
import { assertNoSentinels } from "../../tests/support/assertions";
import { vaultBoundaryViolations } from "../../tests/support/architecture";
import { PLAYER, npc } from "../../src/domain/ids";
import { SummaryService } from "../../src/services/SummaryService";
import { startLiveSweep, setLive, sentinelsFor } from "../support/liveSweep";

function sampleArgs(name: string): Record<string, unknown> {
  switch (name) {
    case "createCharacter": return { playerName: "The Player", seed: 7 };
    case "getGameState": return {};
    case "gameStatus": return {};
    case "getMomentPrompt": return { moment: "nominations" };
    case "getVisibleStateFor": return { entity: PLAYER };
    case "renderScene": return { mode: "scene" };
    case "askProducers": return { question: "is the rumored secret true?" };
    case "endOfSessionSummary": return {};
    case "runCompetition": return { type: "endurance" };
    case "recordInteraction": return { initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a kitchen chat" };
    case "surfaceInformationTo": return { entity: PLAYER, fact: { content: "a surfaced fact" }, pathway: "told-by:npc:1" };
    case "inspectNonVaultState": return { query: "all" };
    case "overrideMechanic": return { mechanic: "pace", value: 1 };
    case "npcVoice": return { id: npc(1) };
    // AMEND secrets wall item 3: sample args for the newer tools (a missing shape would just be a typed refusal, not a real call).
    case "askJuror": return { jurorId: npc(1) };
    case "hangOut": return { maxBeats: 1 };
    case "playerDossier": return {};
    case "playerReceipts": return {};
    default: return {};
  }
}

async function callEveryTool(server: McpServer): Promise<string> {
  const out: string[] = [];
  for (const t of server.listTools()) {
    // E31 default-deny arg shapes: a typed refusal is a legitimate, Vault-free outcome — the
    // sentinel sweep then checks the refusal MESSAGE too (a leaky error would still fail).
    out.push(await server.callTool(t.name, sampleArgs(t.name)).then(
      (r) => JSON.stringify(r),
      (e: unknown) => String((e as Error).message ?? e),
    ));
  }
  return out.join("\n");
}

// --- Background ---------------------------------------------------------------

Given("a running game sandbox with a fully populated Producer's Vault", function (this: BbWorld) {
  this.sandbox = buildSandbox(1);
});

Given("every Vault datum carries a unique sentinel value", function (this: BbWorld) {
  assert.ok(this.sandbox!.sentinels.length > 0);
});

Given("the engine is served as an MCP server", function (this: BbWorld) {
  const commands = new EngineCommandsAdapter(this.sandbox!.engine.events, this.sandbox!.engine.knowledge);
  const session = new GameSessionAdapter();
  const deps = { player: this.sandbox!.player, admin: this.sandbox!.admin, summary: this.sandbox!.summary, commands, session };
  this.mcpPlayer = new McpServer("player", deps);
  this.mcpAdmin = new McpServer("admin/God Mode", deps);
});

// --- Allowlist mounting -------------------------------------------------------

Given("a client connected on the player channel", function (this: BbWorld) {
  this.server = this.mcpPlayer;
});

Then("the available tools are exactly the player allowlist", function (this: BbWorld) {
  assert.deepEqual(this.server!.listTools(), toolsFor("player"));
});

Then("no admin tool and no Vault-reading tool is available", function (this: BbWorld) {
  const adminNames = new Set(toolsFor("admin/God Mode").map((t) => t.name));
  for (const t of this.server!.listTools()) {
    assert.ok(!adminNames.has(t.name), `admin tool ${t.name} leaked to player`);
    assert.equal(t.readsVault, false);
  }
});

// --- No tool returns Vault content --------------------------------------------

Given("a client on the {string} channel", function (this: BbWorld, channel: string) {
  this.server = (channel as OutwardChannel) === "player" ? this.mcpPlayer : this.mcpAdmin;
});

When("it calls every tool that channel exposes", async function (this: BbWorld) {
  // AMEND secrets wall item 3: sweep a STARTED LIVE game (its own session, commands and surfaces, sentinels planted in ITS hidden state), on the same channel. The canary-sandbox server above
  // wraps a fresh never-started session, so most session tools only threw "no game" there, which a sweep counts as a pass; the canary server still backs the structural scenarios.
  const live = startLiveSweep({ seed: 1, user: "mcp-boundary-live" });
  setLive(this, live);
  const channel: OutwardChannel = this.server === this.mcpAdmin ? "admin/God Mode" : "player";
  const liveServer = channel === "player" ? live.sb.mcp.player : live.sb.mcp.admin;
  this.lastOutput = await callEveryTool(liveServer);
});

Then("no result contains a Vault sentinel value", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, sentinelsFor(this)); // the canary's sentinels AND the live game's
});

// --- getVisibleStateFor -------------------------------------------------------

When("the player calls getVisibleStateFor for themselves", async function (this: BbWorld) {
  this.toolResult = await this.mcpPlayer!.callTool("getVisibleStateFor", { entity: PLAYER });
});

Then("the result contains only events they witnessed and facts they know", function (this: BbWorld) {
  const vs = this.toolResult as { visibleEvents: Array<{ witnessSet: string[] }>; knowledge: unknown[] };
  assert.ok(vs.visibleEvents.every((e) => e.witnessSet.includes(PLAYER)));
  assert.ok(Array.isArray(vs.knowledge));
});

Then("no off-screen or hidden event appears", function (this: BbWorld) {
  const vs = this.toolResult as { visibleEvents: Array<{ hidden: boolean }> };
  assert.ok(vs.visibleEvents.every((e) => !e.hidden));
});

// --- recordInteraction --------------------------------------------------------

When("the player records an interaction they initiated", async function (this: BbWorld) {
  this.ack = (await this.mcpPlayer!.callTool("recordInteraction", {
    initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "player-initiated chat",
  })) as { eventId: string };
});

Then("the event is stored with the player in its witness set", function (this: BbWorld) {
  const ev = this.sandbox!.engine.events.queryAll().find((e) => e.id === this.ack!.eventId);
  assert.ok(ev && ev.witnessSet.includes(PLAYER));
});

Then("it becomes part of the player's knowledge", function (this: BbWorld) {
  const visible = this.sandbox!.engine.events.query({ witnessedBy: PLAYER });
  assert.ok(visible.some((e) => e.id === this.ack!.eventId));
});

Then("it is never written to the Vault", function (this: BbWorld) {
  assert.ok(!this.sandbox!.engine.vault.readHidden().some((r) => r.content.includes("player-initiated chat")));
});

// --- resolveCompetition is gone (audit E20) -------------------------------------

Then("resolveCompetition is absent from the channel's tool list", function (this: BbWorld) {
  assert.ok(!this.server!.listTools().some((t) => t.name === "resolveCompetition"));
});

Then("calling resolveCompetition is refused", async function (this: BbWorld) {
  await assert.rejects(
    this.server!.callTool("resolveCompetition", {
      type: "endurance",
      participants: [{ id: PLAYER, stats: { physical: 0.5, mental: 0.5, social: 0.5 } }],
      intents: [], seed: 1,
    }),
    /not available/,
  );
});

Then("runCompetition remains on the channel's tool list", function (this: BbWorld) {
  assert.ok(this.server!.listTools().some((t) => t.name === "runCompetition"));
});

// --- surfaceInformationTo -----------------------------------------------------

Given("a hidden fact the player does not know", function (this: BbWorld) {
  this.factContent = "a hidden plan surfaced via MCP";
  // Anchored (A4): the teller (npc:2) legitimately holds the fact; the PLAYER does not yet know it.
  this.sandbox!.engine.knowledge.seedBelief(npc(2), { content: this.factContent, factId: "mcp-plan" }, "witnessed");
  assert.ok(!this.sandbox!.engine.knowledge.knownTo(PLAYER).some((k) => k.content === this.factContent));
});

When("surfaceInformationTo is called with a valid in-game pathway", async function (this: BbWorld) {
  await this.mcpPlayer!.callTool("surfaceInformationTo", { entity: PLAYER, fact: { content: this.factContent }, pathway: "told-by:npc:2" });
});

Then("that fact enters the player's knowledge", function (this: BbWorld) {
  assert.ok(this.sandbox!.engine.knowledge.knownTo(PLAYER).some((k) => k.content === this.factContent));
});

Then("a surfacing event carrying that pathway is recorded", function (this: BbWorld) {
  const fact = this.sandbox!.engine.knowledge.knownTo(PLAYER).find((k) => k.content === this.factContent);
  assert.equal(fact!.pathway, "told-by:npc:2");
  assert.ok(this.sandbox!.engine.events.query({ type: "surfacing" }).some((e) => e.id === fact!.sourceEventId));
});

// --- God-Mode tools -----------------------------------------------------------

// regex: the literal text contains "/", which is alternation in a Cucumber Expression.
Given(/^a client on the admin\/God Mode channel$/, function (this: BbWorld) {
  this.server = this.mcpAdmin;
});

When("it inspects game state", async function (this: BbWorld) {
  // Route through `lastOutput` so the shared 0001 assertions ("only non-Vault
  // state is returned" / "no Vault sentinel value is returned") apply here too.
  this.lastOutput = JSON.stringify(await this.mcpAdmin!.callTool("inspectNonVaultState", { query: "all" }));
});

// --- Structural boundary ------------------------------------------------------

Then(
  "no MCP-server module depends on the VaultStore, the vector index, or the engine root",
  async function (this: BbWorld) {
    const violations = await vaultBoundaryViolations();
    assert.equal(violations.length, 0, JSON.stringify(violations, null, 2));
  },
);

// --- End-to-end minimal loop --------------------------------------------------

Given("an external MCP client on the player channel", function (this: BbWorld) {
  this.server = this.mcpPlayer;
});

When(
  "it reads visible state, records an interaction, is refused a direct competition resolution, and reads the summary",
  async function (this: BbWorld) {
    const responses: string[] = [];
    responses.push(JSON.stringify(await this.server!.callTool("getVisibleStateFor", sampleArgs("getVisibleStateFor"))));
    responses.push(JSON.stringify(await this.server!.callTool("recordInteraction", sampleArgs("recordInteraction"))));
    // E20: a direct caller-supplied-stats resolution is refused — and even the REFUSAL is Vault-free.
    let refused: string | null = null;
    try {
      await this.server!.callTool("resolveCompetition", { type: "endurance", participants: [], intents: [], seed: 1 });
    } catch (e) {
      refused = (e as Error).message;
    }
    assert.ok(refused, "resolveCompetition must be refused on the player channel (E20)");
    responses.push(JSON.stringify({ refused }));
    this.toolResult = await this.server!.callTool("endOfSessionSummary", {});
    responses.push(JSON.stringify(this.toolResult));
    this.lastOutput = responses.join("\n");
  },
);

Then("every response is Vault-free", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, this.sandbox!.sentinels);
});

// regex (not a Cucumber Expression) because the step text contains "(s)".
Then(/^the summary confirms only that updated save\(s\) exist$/, function (this: BbWorld) {
  assert.equal(this.toolResult, SummaryService.MESSAGE);
});
