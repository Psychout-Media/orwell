import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { buildSandbox } from "../../tests/support/sandbox";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { ADMIN_TOOLS, toolsFor } from "../../src/surfaces/tools/registry";
import { assertNoSentinels, assertNoneAppear } from "../../tests/support/assertions";
import { sentinelsFor, hiddenFor } from "../support/liveSweep";

// Background "a running game sandbox with a fully populated Producer's Vault" → mcp_boundary.steps.

function adminServerOf(sb: ReturnType<typeof buildSandbox>): McpServer {
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const session = new GameSessionAdapter();
  return new McpServer("admin/God Mode", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
}

// --- Inspect non-Vault state --------------------------------------------------

When("the admin inspects the sandbox", function (this: BbWorld) {
  this.lastView = this.sandbox!.admin.inspect();
});

Then("the admin sees the current week and phase", function (this: BbWorld) {
  const v = this.lastView as { week: number; phase: string };
  assert.equal(typeof v.week, "number");
  assert.equal(typeof v.phase, "string");
});

Then("the admin sees the public houseguest roster", function (this: BbWorld) {
  const v = this.lastView as { houseguests: unknown[] };
  assert.ok(Array.isArray(v.houseguests));
});

Then("the admin sees the sandbox configuration", function (this: BbWorld) {
  assert.ok("config" in (this.lastView as object));
});

// --- Inspection returns no Vault content --------------------------------------

// T16: ONE shared sweep — these two Thens had byte-identical bodies (and a third copy
// lived in moment_orchestration.steps.ts, deduplicated there the same way).
function sweepLastViewForHiddenContent(this: BbWorld): void {
  assertNoneAppear(JSON.stringify(this.lastView), hiddenFor(this));
}

Then("no hidden attribute appears", sweepLastViewForHiddenContent);

Then("no off-screen event appears", sweepLastViewForHiddenContent);

Then("no Vault sentinel value appears", function (this: BbWorld) {
  assertNoSentinels(JSON.stringify(this.lastView), sentinelsFor(this));
});

// --- The admin tool allowlist -------------------------------------------------

When("the admin channel's available tools are enumerated", function (this: BbWorld) {
  this.tools = toolsFor("admin/God Mode");
});

Then("the tool set is a fixed allowlist", function (this: BbWorld) {
  assert.deepEqual(this.tools, ADMIN_TOOLS);
  assert.deepEqual(toolsFor("admin/God Mode"), ADMIN_TOOLS); // stable across calls
});

Then("no tool in it reads the Vault", function (this: BbWorld) {
  // `readsVault` is the literal type `false` — the flag alone is decorative. The STRUCTURAL
  // proof that nothing outward can even import the Vault is dependency-cruiser
  // (tests/architecture/vault-boundary.test.ts). What this step adds behaviorally: the flag
  // describes the tools a LIVE admin server actually serves — the served set is exactly the
  // static allowlist, by name, so no unflagged tool can ride along at runtime.
  assert.ok(this.tools!.every((t) => t.readsVault === false));
  const served = adminServerOf(this.sandbox!).listTools().map((t) => t.name).sort();
  assert.deepEqual(served, [...ADMIN_TOOLS].map((t) => t.name).sort(), "the live admin channel serves exactly the static allowlist");
});

Then("no tool in it returns reserve-twist content", function (this: BbWorld) {
  // No tool name offers to reveal hidden/twist content; the allowlist forbids one by construction.
  assert.ok(!this.tools!.some((t) => /reveal|hidden|secret|twist|confessional/i.test(t.name)));
});

Then("obtaining a Vault-reading tool on the admin channel fails", async function (this: BbWorld) {
  const admin = adminServerOf(this.sandbox!);
  await assert.rejects(() => admin.callTool("readHidden", {}));
  await assert.rejects(() => admin.callTool("revealVault", {}));
});

// --- Override a non-Vault mechanic --------------------------------------------

When("the admin overrides a non-Vault mechanic in the sandbox", function (this: BbWorld) {
  this.lastView = this.sandbox!.admin.overrideMechanic({ mechanic: "phase", value: "veto-ceremony" });
});

Then("the observed non-Vault state reflects the override", function (this: BbWorld) {
  assert.equal((this.sandbox!.admin.inspect() as { phase: string }).phase, "veto-ceremony");
});

Then("the override returns no Vault-derived value", function (this: BbWorld) {
  assertNoSentinels(JSON.stringify(this.lastView), this.sandbox!.sentinels);
});

// --- God Mode cannot reveal the Vault -----------------------------------------

When("the admin attempts to reveal hidden game state", async function (this: BbWorld) {
  const admin = adminServerOf(this.sandbox!);
  this.revealRejected = true;
  for (const name of ["readHidden", "revealVault", "getVault", "inspectVault"]) {
    try { await admin.callTool(name, {}); this.revealRejected = false; } catch { /* expected */ }
  }
});

Then("no such capability exists on the admin channel", function (this: BbWorld) {
  assert.ok(!toolsFor("admin/God Mode").some((t) => /reveal|hidden|secret|twist|confessional/i.test(t.name)));
  assert.equal(this.revealRejected, true);
});

Then("no Vault content is returned", function (this: BbWorld) {
  // The whole admin output sweep stays sentinel-clean.
  assertNoSentinels(this.sandbox!.adminOutput(), this.sandbox!.sentinels);
});

// --- Enable reserve twists without learning them ------------------------------

When("the admin enables reserve twists in the configuration", function (this: BbWorld) {
  this.lastView = this.sandbox!.admin.configure({ reserveTwists: 2 }); // a COUNT knob, not content
  this.twist = this.sandbox!.addReservedTwist();                       // engine generates + seals it in the Vault
});

Then("the twist content is generated and sealed in the Vault", function (this: BbWorld) {
  const sealed = this.sandbox!.engine.vault.readHidden({ kind: "reserved-twist" });
  assert.ok(sealed.some((r) => r.content.includes(this.twist!.sentinel)), "twist is sealed in the Vault (engine-only)");
});

Then("no admin surface reveals which twist was prepared", function (this: BbWorld) {
  const adminOut = JSON.stringify(this.lastView) + "\n" + this.sandbox!.adminOutput();
  assertNoneAppear(adminOut, [this.twist!.content]);
  assertNoSentinels(adminOut, this.sandbox!.sentinels);
});

Then("no admin surface reveals when it will fire", function (this: BbWorld) {
  assertNoSentinels(this.sandbox!.adminOutput(), this.sandbox!.sentinels);
});

Then("the twist can still occur during play", function (this: BbWorld) {
  // The mechanism is intact: the sealed twist is readable by the ENGINE (and thus can fire),
  // even though no admin surface can read it.
  assert.ok(this.sandbox!.engine.vault.readHidden({ kind: "reserved-twist" }).length > 0);
});

// --- Sandbox isolation --------------------------------------------------------

Given("a second, separate game sandbox", function (this: BbWorld) {
  this.sandbox2 = buildSandbox(2);
});

When("the admin acts on the first sandbox", function (this: BbWorld) {
  this.sandbox!.admin.overrideMechanic({ mechanic: "phase", value: "eviction" });
  this.sandbox!.admin.configure({ reserveTwists: 3 });
});

Then("the second sandbox is unchanged", function (this: BbWorld) {
  const v = this.sandbox2!.admin.inspect();
  assert.notEqual(v.phase, "eviction");
  assert.equal((v.config as Record<string, unknown> | undefined)?.["reserveTwists"], undefined);
});
