import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { buildSandbox } from "../../tests/support/sandbox";
import type { PlayerSurfaceType } from "../../src/surfaces/player/PlayerSurface";
import type { PlayerCompetitionView } from "../../src/domain/competition";
import { assertNoSentinels, assertNoneAppear } from "../../tests/support/assertions";
import { vaultBoundaryViolations } from "../../tests/support/architecture";
import { PLAYER, npc } from "../../src/domain/ids";
import { InterrogationHandler } from "../../src/surfaces/player/InterrogationHandler";
import { SummaryService } from "../../src/services/SummaryService";
import { toolsFor } from "../../src/surfaces/tools/registry";
import type { OutwardChannel } from "../../src/surfaces/tools/registry";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import {
  startLiveSweep, setLive, liveOf, livePlayerSurfaces, sentinelsFor, hiddenFor, assertLiveSweepClean,
} from "../support/liveSweep";
import type { LiveSweep } from "../support/liveSweep";

// --- Background ---------------------------------------------------------------

Given("a running game sandbox", function (this: BbWorld) {
  this.sandbox = buildSandbox(1);
});

Given("a fully populated Producer's Vault", function (this: BbWorld) {
  assert.ok(this.sandbox.engine.vault.readHidden().length > 0, "Vault should be populated");
  assert.ok(this.sandbox.sentinels.length > 0, "fixture should have injected sentinels");
});

Given(
  "every Vault datum carries a unique sentinel value not derivable from visible state",
  function (this: BbWorld) {
    const unique = new Set(this.sandbox.sentinels);
    assert.equal(unique.size, this.sandbox.sentinels.length, "sentinels must be unique");
    // Baseline precondition: none are present in the default visible projection.
    const visible = `${this.sandbox.allPlayerOutputs()}\n${this.sandbox.adminOutput()}`;
    assertNoSentinels(visible, this.sandbox.sentinels);
  },
);

// --- No Vault content on any player-facing surface ----------------------------

When(
  "the engine produces player-facing output of type {string}",
  function (this: BbWorld, surface: string) {
    this.lastOutput = this.sandbox.player.produce(surface as PlayerSurfaceType);
  },
);

Then("the output contains none of the Vault sentinel values", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, this.sandbox.sentinels);
});

Then(
  "it contains no hidden attribute, confessional, hidden thread, or unwitnessed off-screen event",
  function (this: BbWorld) {
    assertNoneAppear(this.lastOutput, this.sandbox.hiddenContents);
  },
);

// --- God Mode -----------------------------------------------------------------

Given("an administrator interacting in God Mode", function (this: BbWorld) {
  // The admin port is already built; God Mode is just the admin channel.
  assert.ok(this.sandbox.admin);
});

When("the administrator inspects any game state", function (this: BbWorld) {
  this.lastView = this.sandbox.admin.inspect();
  this.lastOutput = JSON.stringify(this.lastView);
});

Then("no Vault sentinel value is returned", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, this.sandbox.sentinels);
});

Then("only non-Vault state is returned", function (this: BbWorld) {
  assertNoneAppear(this.lastOutput, this.sandbox.hiddenContents);
  assert.match(this.lastOutput, /"phase"/, "expected genuine non-Vault state to be present");
});

// --- NPC confessionals --------------------------------------------------------

Given(
  "an NPC confessional recorded with a witness set that excludes the player",
  function (this: BbWorld) {
    this.specific = this.sandbox.addConfessional();
  },
);

When("any player-facing surface is produced", function (this: BbWorld) {
  // PAT-2: when the scenario drove a LIVE game (liveSweep), sweep THAT game's surfaces, not the canary's.
  const live = liveOf(this);
  this.lastOutput = live?.sb ? livePlayerSurfaces(live.sb) : this.sandbox.allPlayerOutputs();
});

Then("the confessional text does not appear", function (this: BbWorld) {
  assert.ok(!this.lastOutput.includes(this.specific!.content), "confessional text leaked");
});

Then("its sentinel value does not appear", function (this: BbWorld) {
  assert.ok(!this.lastOutput.includes(this.specific!.sentinel), "sentinel leaked");
});

// --- Off-screen NPC-to-NPC event ---------------------------------------------

Given(
  "an off-screen NPC-to-NPC event whose witness set excludes the player",
  function (this: BbWorld) {
    this.specific = this.sandbox.addOffscreenEvent();
  },
);

When("any player-facing log or journal projection is produced", function (this: BbWorld) {
  this.lastOutput = this.sandbox.player.produce("player-visible log");
});

Then("that event does not appear", function (this: BbWorld) {
  assert.ok(!this.lastOutput.includes(this.specific!.content), "off-screen event content leaked");
  assert.ok(!this.lastOutput.includes(this.specific!.sentinel), "off-screen event sentinel leaked");
});

Then("it remains hidden until an in-game pathway surfaces it", function (this: BbWorld) {
  const witnessed = this.sandbox.engine.events.query({ witnessedBy: PLAYER });
  assert.ok(!witnessed.some((e) => e.content === this.specific!.content), "player must not witness it");
  const known = this.sandbox.engine.knowledge.knownTo(PLAYER);
  assert.ok(!known.some((k) => k.content === this.specific!.content), "player must not yet know it");
});

// --- Reserved twist -----------------------------------------------------------

Given("a twist held in the Vault that has not yet occurred in-game", function (this: BbWorld) {
  this.specific = this.sandbox.addReservedTwist();
});

When("the engine produces any player-facing or admin-facing output", function (this: BbWorld) {
  this.lastOutput =
    `${this.sandbox.allPlayerOutputs()}\n---\n${this.sandbox.adminOutput()}\n---\n` +
    this.sandbox.player.ask("is the rumored twist real?");
});

Then("the twist is neither referenced, confirmed, nor denied", function (this: BbWorld) {
  assert.ok(!this.lastOutput.includes(this.specific!.content), "twist content must not be referenced");
  assert.ok(
    this.lastOutput.includes(InterrogationHandler.NONCOMMITTAL),
    "interrogation must answer non-committally (neither confirm nor deny)",
  );
});

// --- End-of-session summary ---------------------------------------------------

When("the engine emits an end-of-session summary", function (this: BbWorld) {
  this.lastOutput = this.sandbox.summary.endOfSession();
});

// NOTE: regex (not a Cucumber Expression) because the step text contains "(s)".
Then(/^it confirms only that updated save\(s\) exist$/, function (this: BbWorld) {
  assert.equal(this.lastOutput, SummaryService.MESSAGE);
  assert.match(this.lastOutput, /updated save\(s\)/i);
});

Then(
  "it does not describe what changed, enumerate Vault sections, or include any sentinel value",
  function (this: BbWorld) {
    assertNoSentinels(this.lastOutput, this.sandbox.sentinels);
    assertNoneAppear(this.lastOutput, this.sandbox.hiddenContents);
    assert.ok(
      !/(hidden-attribute|confessional|hidden-thread|offscreen-event|reserved-twist)/i.test(this.lastOutput),
      "summary must not enumerate Vault sections",
    );
  },
);

// --- Direct interrogation -----------------------------------------------------

Given("the player directly asks whether a specific hidden fact is true", function (this: BbWorld) {
  this.question = `Is it true that ${this.sandbox.hiddenContents[0]}?`;
});

When("the engine responds", function (this: BbWorld) {
  this.lastOutput = this.sandbox.player.ask(this.question);
});

Then("the response contains no Vault sentinel value", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, this.sandbox.sentinels);
});

Then(
  "it neither confirms nor denies the existence of specific Vault content",
  function (this: BbWorld) {
    assert.equal(this.lastOutput, InterrogationHandler.NONCOMMITTAL);
  },
);

// --- Competition results ------------------------------------------------------

When("a competition result is delivered to the player", function (this: BbWorld) {
  this.lastView = this.sandbox.competitionViewForPlayer();
  this.lastOutput = JSON.stringify(this.lastView);
});

Then("the result is stated as an outcome", function (this: BbWorld) {
  const view = this.lastView as PlayerCompetitionView;
  assert.ok(typeof view.outcome === "string" && view.outcome.length > 0);
  assert.match(view.outcome, /won the .+ competition/i);
});

Then(
  "no houseguest stat score, rating, or relative ranking is revealed",
  function (this: BbWorld) {
    assertNoSentinels(this.lastOutput, this.sandbox.sentinels);
    const keys = Object.keys(this.lastView as Record<string, unknown>).sort();
    assert.deepEqual(keys, ["outcome", "type"], "player view must expose only {type, outcome}");
    assert.ok(
      !/\b(score|rating|ranking|rank|stat|stats|physical|mental|social|luck)\b/i.test(this.lastOutput),
      "no stat/rating/ranking may be revealed",
    );
  },
);

// --- Narration context (the inference clause, defended at the source) ----------

Given(
  "the engine assembles the context handed to the narrative layer for a player-facing moment",
  function (this: BbWorld) {
    // The canary fixture's own narration context, AND (PAT-2) the live game's narrator-bound context
    // (narration contexts + the assembled moment prompt) with sentinels planted in ITS hidden state.
    const live = startLiveSweep({ seed: 1, user: "pat2-narrator" });
    setLive(this, live);
    this.lastOutput = JSON.stringify(this.sandbox.player.assembleNarrationContext("scene")) + "\n---\n" + [
      JSON.stringify(live.sb.player.assembleNarrationContext("scene")),
      JSON.stringify(live.sb.player.assembleNarrationContext("dialogue")),
      JSON.stringify(live.sb.session.getMomentPrompt({})),
      JSON.stringify(live.sb.session.getGameState()),
    ].join("\n---\n");
  },
);

Then("that context contains no Vault sentinel value", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, sentinelsFor(this));
  assertNoneAppear(this.lastOutput, hiddenFor(this));
});

// --- PAT-2 positive control: the live-game sweep has teeth ---------------------------------------------

Given("a live game with Vault sentinels planted in its hidden state", function (this: BbWorld) {
  setLive(this, startLiveSweep({ seed: 1, user: "pat2-control" }));
});

When("a sentinel is deliberately leaked onto the live game's player surface", function (this: BbWorld) {
  const live = liveOf(this) as LiveSweep;
  // A PUBLIC, player-witnessed event is exactly what the player surface projects: smuggle a planted
  // sentinel into one, i.e. simulate the very leak the sweeps exist to catch.
  live.sb.engine.events.record({
    id: "pat2:leak", ts: 9_100_000, type: "house-event", initiator: npc(1),
    witnessSet: [PLAYER, npc(1)], hidden: false, content: `A deliberate leak: ${live.sentinels[0]!}`,
  });
  this.lastOutput = livePlayerSurfaces(live.sb);
});

Then("the live-game sweep detects the leak", function (this: BbWorld) {
  const live = liveOf(this)!;
  assert.throws(
    () => assertLiveSweepClean(this.lastOutput, live),
    (e: Error) => e.message.includes(live.sentinels[0]!),
    "the sweep must FAIL on a planted leak, naming the sentinel",
  );
});

// --- Capability + dependency boundary -----------------------------------------

/** The channel under examination (set by the Given, read by the Then in the same scenario). */
let examinedChannel: OutwardChannel;

Given("the tools available in the {string} channel", function (this: BbWorld, channel: string) {
  examinedChannel = channel as OutwardChannel;
  this.tools = toolsFor(examinedChannel);
});

Then("none of them can read from the VaultStore", function (this: BbWorld) {
  assert.ok(this.tools.length > 0, "channel should expose at least one tool");
  // `readsVault` is the literal type `false` — the flag alone is decorative. The STRUCTURAL
  // proof is dependency-cruiser (tests/architecture/vault-boundary.test.ts), which the next
  // step of this scenario runs. What this step adds behaviorally: a LIVE server mounted on
  // this channel serves exactly the static allowlist, by name — no unflagged tool can ride
  // along at runtime to reach the Vault.
  assert.ok(this.tools.every((t) => t.readsVault === false), "no outward tool may read the Vault");
  const sb = this.sandbox;
  const live = new McpServer(examinedChannel, {
    player: sb.player,
    admin: sb.admin,
    summary: sb.summary,
    commands: new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge),
    session: new GameSessionAdapter(),
  });
  assert.deepEqual(
    live.listTools().map((t) => t.name).sort(),
    this.tools.map((t) => t.name).sort(),
    "the live server serves exactly the channel's static allowlist",
  );
});

Then(
  "no {string}-facing adapter depends on the VaultStore port",
  async function (this: BbWorld, _channel: string) {
    const violations = await vaultBoundaryViolations();
    assert.equal(violations.length, 0, JSON.stringify(violations, null, 2));
  },
);

// --- Over-blocking guard: legitimately surfaced fact may appear ----------------

Given(
  "a hidden fact that has been surfaced to the player through an in-game pathway",
  function (this: BbWorld) {
    this.surfaced = this.sandbox.surfaceHiddenFactToPlayer();
  },
);

Given("that fact now lives in the player's knowledge state", function (this: BbWorld) {
  const known = this.sandbox.engine.knowledge.knownTo(PLAYER);
  assert.ok(known.some((k) => k.content === this.surfaced!.content), "fact should be in knowledge");
});

When("a player-facing surface renders it", function (this: BbWorld) {
  this.lastOutput = this.sandbox.player.produce("player-visible log");
});

Then("it may appear", function (this: BbWorld) {
  assert.ok(this.lastOutput.includes(this.surfaced!.content), "surfaced fact should be allowed to appear");
});

Then(
  "it is sourced from the player's knowledge state, not from the Vault",
  function (this: BbWorld) {
    const ctx = this.sandbox.player.assembleNarrationContext("scene");
    const fact = ctx.knowledge.find((k) => k.content === this.surfaced!.content);
    assert.ok(fact, "fact must be present in the player's knowledge projection");
    assert.ok(fact!.pathway.startsWith("told-by"), "fact must carry an in-game pathway (provenance)");
  },
);
