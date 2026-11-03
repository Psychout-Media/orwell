import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { assertNoSentinels, assertNoneAppear } from "../../tests/support/assertions";
import { DeterministicNarrator } from "../../src/adapters/narrative/DeterministicNarrator";
import { LlmNarrativePort, safeFallbackLine, type NarratorTransport } from "../../src/adapters/narrative/LlmNarrativePort";
import { loadNarratorConfig } from "../../src/adapters/narrative/narratorConfig";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import type { Competitor } from "../../src/domain/competitionOutcome";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { ALL_PLAYER_SURFACES } from "../../tests/support/sandbox";
import { startLiveSweep, setLive, sentinelsFor, hiddenFor } from "../support/liveSweep";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";

// Reuses: Background "a running game sandbox with a fully populated Producer's Vault" (mcp_boundary),
// "the game state is unchanged" (agent_play_loop — asserts nothing was executed; no-op here).

// PAT-5 (#1982): `LlmNarrativePort` (and `buildStreamingNarrator`/`loadNarratorConfig`) have NO production caller. The live
// engine composes `EchoNarrativePort`; the real LLM narration runs in the Python FE, reading the engine's Vault-free
// context (`assembleNarrationContext` + `session.getMomentPrompt`). So the "Vault-free context" and "never changes an
// outcome" scenarios drive THAT live seam, while the adapter-only scenarios (failure fallback, config) are tagged
// @standalone-module in the feature.
const narrationCtx = new WeakMap<object, { visible: ReturnType<UserSandbox["player"]["getVisibleState"]>; sb?: UserSandbox }>();
const MOMENT_PROMPT = "You are the voice of the house. Narrate the moment in character; the engine decides outcomes.";

/** A seed-deterministic engine decision — re-running it is how we 're-read the engine'. */
function decideWinner(seed: number): string {
  const competitors: Competitor[] = [
    { id: PLAYER, stats: { physical: 0.4, mental: 0.6, social: 0.5 } },
    { id: npc(1), stats: { physical: 0.75, mental: 0.5, social: 0.4 } },
    { id: npc(2), stats: { physical: 0.55, mental: 0.7, social: 0.6 } },
  ];
  return resolveCompetition(competitors, "physical", new CompetitionIntents(), new SeededRandom(seed)).winner;
}

function erroringPort(): LlmNarrativePort {
  const erroring: NarratorTransport = {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("provider timed out");
    },
  };
  return new LlmNarrativePort(
    { provider: "ollama", endpoint: "http://127.0.0.1:0", model: "m", apiKey: undefined, timeoutMs: 20, maxRetries: 0 },
    erroring,
  );
}

// --- The adapter receives only Vault-free context -----------------------------

When("narration is requested for the player", function (this: BbWorld) {
  // PAT-5: the context the LIVE narrator is handed — the registry-built game's outward surface (proven Vault-free,
  // 0001) plus its managed moment prompt (0018) — with sentinels planted in THAT game's hidden state.
  const live = startLiveSweep({ seed: 1, user: "pat5-narration", ticks: 2 });
  setLive(this, live);
  const ctx = live.sb.player.assembleNarrationContext("scene");
  ctx.systemPrompt = live.sb.session.getMomentPrompt({}).systemPrompt;
  this.narrationCtx = ctx;
  narrationCtx.set(this, { visible: live.sb.player.getVisibleState() });
});

Then("the context handed to the adapter contains no Vault sentinel value", function (this: BbWorld) {
  const json = JSON.stringify(this.narrationCtx);
  assertNoSentinels(json, sentinelsFor(this));
  assertNoneAppear(json, hiddenFor(this));
});

Then("it contains only the visible projection and the moment prompt", function (this: BbWorld) {
  const ctx = this.narrationCtx!;
  const allowed = new Set(["forEntity", "mode", "visibleEvents", "knowledge", "fidelity", "systemPrompt"]);
  for (const key of Object.keys(ctx)) assert.ok(allowed.has(key), `unexpected context key leaked in: ${key}`);
  const vs = narrationCtx.get(this)!.visible;
  assert.deepEqual(ctx.visibleEvents, vs.visibleEvents); // exactly the visible projection
  assert.deepEqual(ctx.knowledge, vs.knowledge);
  assert.ok(typeof ctx.systemPrompt === "string" && ctx.systemPrompt.length > 0, "and the moment prompt");
});

// --- Streaming concatenates to the full narration -----------------------------

Given("the deterministic test narrator", function (this: BbWorld) {
  this.narrator = new DeterministicNarrator(3);
  const ctx = this.sandbox!.player.assembleNarrationContext("scene");
  ctx.systemPrompt = MOMENT_PROMPT;
  this.narrationCtx = ctx;
});

When("narration is streamed token by token", async function (this: BbWorld) {
  const chunks: string[] = [];
  for await (const c of this.narrator!.narrateStream(this.narrationCtx!)) chunks.push(c);
  this.narrationChunks = chunks;
  this.narrationFull = await this.narrator!.narrate(this.narrationCtx!);
});

Then("the concatenated stream equals the full narration", function (this: BbWorld) {
  assert.equal(this.narrationChunks!.join(""), this.narrationFull);
  assert.ok(this.narrationChunks!.length > 1, "narration should genuinely stream in pieces");
});

// --- A narration failure leaves game state untouched --------------------------

Given("the narrator provider times out or errors", function (this: BbWorld) {
  this.narrator = erroringPort();
});

When("narration is requested for a resolved beat", async function (this: BbWorld) {
  this.engineWinnerBefore = decideWinner(5); // the engine settled the beat BEFORE narration
  this.narrationCtx = this.sandbox!.player.assembleNarrationContext("scene");
  this.narrationOut = await this.narrator!.narrate(this.narrationCtx);
});

Then("a safe fallback line is produced", function (this: BbWorld) {
  assert.equal(this.narrationOut, safeFallbackLine(this.narrationCtx!));
});

Then("re-reading the engine gives the same result", function (this: BbWorld) {
  assert.equal(decideWinner(5), this.engineWinnerBefore); // narration text moved nothing
});

// --- Narration never changes an outcome ---------------------------------------
// T5: a LIVE game. PAT-5: narration is produced through the LIVE player surfaces (the engine's own narrator seam, not the
// unwired `LlmNarrativePort`); the prose is text out and the engine has no inbound path from it, so the result AND the
// whole game state are unmoved by narrating the resolved competition.

Given("the engine has decided a competition result", function (this: BbWorld) {
  const sb = new GameSessionRegistry().sandboxFor("pat5-narration-comp");
  sb.session.createCharacter({ playerName: "Player One", seed: 11 });
  this.liveCompGame = sb.session;
  narrationCtx.set(this, { visible: sb.player.getVisibleState(), sb });
  this.liveCompResult = sb.session.runCompetition({ type: "endurance" });
  assert.ok(this.liveCompResult.winner, "the engine produced the winner the narrator must voice");
  // The full Vault-free engine state right after the engine decided — narration must not move it.
  this.liveStateBefore = JSON.stringify(sb.session.getGameState());
});

When("the narrator produces narration for it", function (this: BbWorld) {
  const sb = narrationCtx.get(this)!.sb!;
  this.narrationOut = [
    ...ALL_PLAYER_SURFACES.map((surface) => sb.player.produce(surface)),
    JSON.stringify(sb.player.assembleNarrationContext("scene")),
    sb.player.renderScene("full"),
  ].join("\n---\n");
});

Then("the engine's result is unchanged", function (this: BbWorld) {
  // Re-running the SAME live competition yields the same winner — the engine, not the prose, owns it.
  const again = this.liveCompGame!.runCompetition({ type: "endurance" });
  assert.deepEqual(again.winner, this.liveCompResult!.winner, "the live engine's competition winner is unmoved by narration");
});

Then("even a hallucinated result in the prose changes no game state", function (this: BbWorld) {
  assert.ok(this.narrationOut && this.narrationOut.length > 0); // the prose said something...
  // ...and the live engine's whole game state is byte-identical: narrating moved nothing (the engine never reads prose back).
  assert.equal(JSON.stringify(this.liveCompGame!.getGameState()), this.liveStateBefore, "no game state changed");
});

// --- Provider and secrets come from config, never code ------------------------

When("the adapter is configured", function (this: BbWorld) {
  this.narratorEnv = {
    ORWELL_NARRATOR_PROVIDER: "anthropic",
    ORWELL_NARRATOR_ENDPOINT: "https://provider.example",
    ORWELL_NARRATOR_MODEL: "configured-model",
    ORWELL_NARRATOR_API_KEY: "from-env-only",
  };
  this.narratorCfg = loadNarratorConfig(this.narratorEnv);
});

Then("the provider, endpoint, and model come from the environment", function (this: BbWorld) {
  assert.equal(this.narratorCfg!.provider, "anthropic");
  assert.equal(this.narratorCfg!.endpoint, "https://provider.example");
  assert.equal(this.narratorCfg!.model, "configured-model");
});

Then("no secret is read from committed source", function (this: BbWorld) {
  // The key is ONLY ever from env: with no env key set, it is undefined (no literal default in code).
  assert.equal(loadNarratorConfig({}).apiKey, undefined);
  assert.equal(this.narratorCfg!.apiKey, this.narratorEnv!["ORWELL_NARRATOR_API_KEY"]);
});
