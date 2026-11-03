import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import {
  momentForPhase, momentFragment, buildSystemPrompt, renderGameContext,
  BASE_GAME_MASTER_PROMPT, MOMENT_PROMPTS,
} from "../../src/engine/momentPrompts";
import type { GameStateView } from "../../src/ports/GameSession";
import { PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER, npc } from "../../src/domain/ids";
import { assertNoSentinels, assertNoneAppear } from "../../tests/support/assertions";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerPending } from "../support/answerPending";
import { startLiveSweep, setLive, sentinelsFor, hiddenFor } from "../support/liveSweep";

// Background "a running game sandbox with a fully populated Producer's Vault" → mcp_boundary.steps.

function startedView(phase: string): GameStateView {
  return {
    started: true, beatSeq: 0, finished: false, week: 2, phase, moment: momentForPhase(phase),
    pending: null,
    ceremony: { hoh: null, nominees: [], veto: { holder: null, used: false, players: [] } },
    player: { id: PLAYER, name: "Player One", archetype: "mastermind", strategyStyle: "strategic", status: "active" },
    house: [
      { id: npc(1), name: "Houseguest One", status: "active" },
      { id: npc(2), name: "Houseguest Two", status: "active" },
    ],
  };
}

const ALL_MOMENTS = Object.keys(MOMENT_PROMPTS);

// --- Moment derived from phase ------------------------------------------------

Given("the game is in a given phase", function (this: BbWorld) {
  this.gsView = startedView("nominations");
});

When("the current moment is requested", function (this: BbWorld) {
  this.gsMoment = momentForPhase(this.gsView!.phase);
});

Then("the moment corresponds to that phase", function (this: BbWorld) {
  assert.equal(this.gsMoment, momentForPhase(this.gsView!.phase));
  assert.equal(this.gsMoment, "nominations");
});

Then("the same game state always yields the same moment", function (this: BbWorld) {
  assert.equal(momentForPhase(this.gsView!.phase), momentForPhase(this.gsView!.phase));
});

// --- Narrator cannot advance the game -----------------------------------------
// T6: re-pointed at a LIVE sandbox (was a hand-built `startedView` constant the Thens then
// re-read — proving nothing). Drive a real GameSessionAdapter season to its live nomination
// beat, build the narrator's prompt over the LIVE Vault-free view, then prove the live engine
// state (phase + the exact pending decision) is byte-identical after — narration is a pure read.

Given("the game is at the nomination phase", function (this: BbWorld) {
  // Search seeds for one where the PLAYER reaches the HOH seat and the live loop pauses on a real
  // nomination decision — the live nomination beat, not a hand-built phase constant. (A pinned seed
  // breaks whenever balance tuning reshapes the trajectory; the property under test doesn't care which.)
  let game = new GameSessionAdapter();
  let view = game.advanceGame();
  for (let seed = 0; seed < 40; seed++) {
    game = new GameSessionAdapter();
    game.createCharacter({ playerName: "Player One", seed });
    view = game.advanceGame();
    for (let i = 0; i < 400 && !(view.pending && view.pending.kind === "nominations"); i++) {
      if (view.pending) {
        const p = view.pending;
        // Answer every non-nominations decision automatically until the loop pauses on nominations.
        const req = answerPending(p);
        if (req === null) break; // self-evict is never auto-answered
        game.submitDecision(req);
      }
      view = game.advanceGame();
      if (view.finished) break;
    }
    if (view.pending?.kind === "nominations") break;
  }
  assert.equal(view.pending?.kind, "nominations", "the live loop paused on the nomination decision");
  this.liveGame = game;
  this.gsView = game.getGameState();
  assert.equal(this.gsView.phase, "nominations", "the live phase is the nomination phase");
  this.phaseBefore = this.gsView.phase;
  this.pendingBefore = JSON.parse(JSON.stringify(view.pending));
});

When("the narrator produces narration for the moment", function (this: BbWorld) {
  // Build the narrator's whole system prompt over the LIVE view — the only thing the narrator
  // ever does at this seam. It is a pure read; it must move no engine state.
  this.lastOutput = buildSystemPrompt(momentForPhase(this.gsView!.phase), this.gsView!);
});

Then("the phase is still the nomination phase", function (this: BbWorld) {
  // Re-READ the live engine (not the captured constant) — its phase is unmoved by narration.
  const after = this.liveGame!.getGameState();
  assert.equal(after.phase, "nominations", "the live phase is unchanged by narration");
  assert.equal(after.phase, this.phaseBefore, "the live phase did not drift");
  // The pending decision the loop is waiting on is byte-identical too: nothing advanced.
  const pendingAfter = this.liveGame!.advanceGame().pending; // idempotent while pending
  assert.deepEqual(JSON.parse(JSON.stringify(pendingAfter)), this.pendingBefore, "the pending nomination decision is unchanged");
});

Then("the moment is unchanged", function (this: BbWorld) {
  // The moment derives from the LIVE phase, which narration did not move.
  const after = this.liveGame!.getGameState();
  assert.equal(momentForPhase(after.phase), "nominations");
  assert.equal(after.phase, this.phaseBefore, "the live phase (and thus the moment) is unchanged");
});

// --- Persona framing ----------------------------------------------------------

When("the system prompt for any moment is built", function (this: BbWorld) {
  this.lastOutput = buildSystemPrompt("nominations", startedView("nominations"));
});

Then("it frames the model as the host and the voice of the house", function (this: BbWorld) {
  assert.match(this.lastOutput, /host/i);
  assert.match(this.lastOutput, /voice of every houseguest/i);
});

Then("it forbids the model from breaking character as a generic assistant", function (this: BbWorld) {
  assert.match(this.lastOutput, /not a generic ai assistant/i);
});

// --- Lever manifest (0018 / B21): the base prompt names every game-driving lever ----

When("the base system prompt is built", function (this: BbWorld) {
  this.lastOutput = BASE_GAME_MASTER_PROMPT;
});

Then("it names every player-channel lever the agent can call", function (this: BbWorld) {
  const missing = PLAYER_AGENT_LEVERS.filter((name) => !this.lastOutput.includes(name));
  assert.deepEqual(missing, [], `levers missing from the manifest: ${missing.join(", ")}`);
});

Then("it states that the engine decides outcomes and the model only voices them", function (this: BbWorld) {
  // The authority line says the GAME decides (the machinery-scrub: prompts name "the game", not
  // "the engine", per the owner ruling) — tolerate either wording so the assertion tracks the intent
  // (an explicit authority statement), not one literal word.
  assert.match(this.lastOutput, /\b(?:game|engine)\b[^.\n]{0,15}decides/i);
  assert.match(this.lastOutput, /never invent/i);
});

Then("no lever in the player tool registry is missing from it", function (this: BbWorld) {
  for (const name of PLAYER_AGENT_LEVERS) assert.ok(this.lastOutput.includes(name), `manifest names ${name}`);
});

When("the system prompt for a competition moment is built", function (this: BbWorld) {
  this.lastOutput = buildSystemPrompt("hoh-competition", startedView("hoh-competition"));
});

Then("it directs the model to resolve the competition through the engine", function (this: BbWorld) {
  assert.match(this.lastOutput, /runCompetition/);
});

Then("it forbids inventing the winner or revealing scores", function (this: BbWorld) {
  assert.match(this.lastOutput, /never choose the winner|no scores|only the winner/i);
});

// --- Sentinel-free under any Vault contents -----------------------------------

When("the system prompt is built for every moment", function (this: BbWorld) {
  // PAT-2: build the prompts from the LIVE game's projection, with sentinels planted in THAT game's hidden
  // state (not a fresh adapter the canary sandbox never touched) — so the sweeps below can actually fail.
  const live = startLiveSweep({ seed: 1, user: "pat2-moment-prompts" });
  setLive(this, live);
  const view = live.sb.session.getGameState(); // Vault-free projection
  this.lastOutput = ALL_MOMENTS.map((m) => buildSystemPrompt(m, view)).join("\n----\n")
    + "\n----\n" + ALL_MOMENTS.map((m) => JSON.stringify(live.sb.session.getMomentPrompt({ moment: m }))).join("\n----\n");
});

// T16: ONE shared sweep — these two Thens had byte-identical bodies (god_mode.steps.ts
// carried the same duplicate pair over `lastView`; both files are deduplicated locally).
function sweepLastOutputForHiddenContent(this: BbWorld): void {
  assertNoneAppear(this.lastOutput, hiddenFor(this));
}

Then("no hidden attribute appears in it", sweepLastOutputForHiddenContent);

Then("no off-screen event appears in it", sweepLastOutputForHiddenContent);

Then("no Vault sentinel value appears in it", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, sentinelsFor(this));
});

// --- Woven context is Vault-free ----------------------------------------------

// Shared (0018 + 0031): a started game in a registry-backed sandbox + an orchestrator.
// `gsView` (the 0018 projection) is byte-identical to the bare-adapter path; the
// registry/orchestrator/clock are what 0031's advance scenarios drive.
Given("a started game", function (this: BbWorld) {
  this.saveDir = mkdtempSync(join(tmpdir(), "orwell-started-"));
  this.registry = new GameSessionRegistry(new FileSaveStore(this.saveDir));
  this.fakeClock = new FakeClock();
  this.orchestrator = new Orchestrator(this.registry, this.fakeClock, { seed: 4 });
  const sb = this.registry.sandboxFor("user-a");
  sb.session.createCharacter({ playerName: "Player One", seed: 4 });
  this.orchestrator.touch("user-a");
  this.gsView = sb.session.getGameState();
});

When("the system prompt's game context is built", function (this: BbWorld) {
  this.lastOutput = renderGameContext(this.gsView!);
});

Then("it contains the player's own card, the phase, and the house roster by name", function (this: BbWorld) {
  assert.match(this.lastOutput, new RegExp(this.gsView!.player!.name));
  assert.ok(this.lastOutput.includes(this.gsView!.phase));
  for (const h of this.gsView!.house) assert.ok(this.lastOutput.includes(h.name), `roster name ${h.name}`);
});

Then("it contains no competition stats, souls, or hidden attributes", function (this: BbWorld) {
  // Stats / souls / hidden internals never cross. The curated PUBLIC persona facets
  // (archetype, style, background, appearance) DO cross since B61 — they are the
  // narrator's per-houseguest voice anchor, blessed Vault-free by 0004/0020.
  for (const banned of ["physical", "mental", '"soul"', "volatility", "emotionalBaseline", "emotionalState", "hiddenElement", "secret-motive", "concealed-aptitude"]) {
    assert.ok(!this.lastOutput.includes(banned), `leaked: ${banned}`);
  }
});

// --- Editing a fragment is isolated -------------------------------------------

Given("the managed per-moment prompt registry", function () {
  // MOMENT_PROMPTS is the single managed registry.
});

When("the fragment for one moment is changed", function (this: BbWorld) {
  const view = startedView("social");
  const original = MOMENT_PROMPTS["social"]!;
  const baseBefore = BASE_GAME_MASTER_PROMPT;
  const otherBefore = momentFragment("nominations");
  try {
    MOMENT_PROMPTS["social"] = "MOMENT — EDITED-FRAGMENT-XYZ";
    this.lastOutput = JSON.stringify({
      socialChanged: buildSystemPrompt("social", view).includes("EDITED-FRAGMENT-XYZ"),
      nominationsUnchanged: !buildSystemPrompt("nominations", view).includes("EDITED-FRAGMENT-XYZ"),
      baseUnchanged: BASE_GAME_MASTER_PROMPT === baseBefore,
      otherFragmentUnchanged: momentFragment("nominations") === otherBefore,
    });
  } finally {
    MOMENT_PROMPTS["social"] = original; // restore the shared registry
  }
});

Then("only that moment's system prompt changes", function (this: BbWorld) {
  const r = JSON.parse(this.lastOutput) as { socialChanged: boolean; nominationsUnchanged: boolean };
  assert.ok(r.socialChanged && r.nominationsUnchanged);
});

Then("the base persona and the other moments are unaffected", function (this: BbWorld) {
  const r = JSON.parse(this.lastOutput) as { baseUnchanged: boolean; otherFragmentUnchanged: boolean };
  assert.ok(r.baseUnchanged && r.otherFragmentUnchanged);
});
