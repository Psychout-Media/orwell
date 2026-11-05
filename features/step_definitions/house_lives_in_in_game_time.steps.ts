import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { resolvePending } from "../support/answerPending";
import { PLAYER } from "../../src/domain/ids";
import type { UserSandbox } from "../../src/composition/registry";

// Feature 0117 (Phase 1, in-game-time pivot) — the house lives IN IN-GAME TIME: it keeps scheming as the
// clock passes during the player's between-ceremony social play, while a clock-OFF run stays byte-identical.
// Production-shaped orchestrator: turnDriven + auxTicksNever. Roles only; in-game time only, never real time.

let igtUsers = 0;

function buildLiveHouse(w: BbWorld, clockOn: boolean, seed = 7): void {
  GameSessionAdapter.setTimeOfDayEnabled(clockOn);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`igt${igtUsers++}`);
  sb.session.createCharacter({ playerName: "Player", seed });
  sb.session.setPerConversationClockEnabled(true);
  const orch = new Orchestrator(reg, new FakeClock(), { seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  for (let i = 0; i < 120 && sb.session.snapshot().live?.hoh === undefined; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => sb.session.submitDecision(req));
    if (v.finished) break;
  }
  w.igtSandbox = sb;
}

function scenes(sb: UserSandbox): string[] {
  return sb.engine.events
    .queryAll()
    .filter((e) => e.hidden && e.witnessSet.length === 2 && !e.witnessSet.includes(PLAYER))
    .map((e) => e.id);
}

function socialTurn(sb: UserSandbox, content: string): void {
  const npc = sb.session.livingIds().filter((id) => id !== PLAYER)[0]!;
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content });
}

Given("a live house with the in-game clock running", function (this: BbWorld) {
  buildLiveHouse(this, true);
  assert.equal(this.igtSandbox!.session.perConversationClockLive(), true, "the in-game clock is live");
});

Given("a live house with the in-game clock turned off", function (this: BbWorld) {
  buildLiveHouse(this, false);
  assert.equal(this.igtSandbox!.session.perConversationClockLive(), false, "the in-game clock is off");
});

Given("a live house with the in-game clock running and a populated Vault", function (this: BbWorld) {
  buildLiveHouse(this, true);
  this.igtSandbox!.engine.vault.writeHidden({ id: "v117", kind: "hidden-attribute", content: "hidden VAULT_117_SENTINEL" });
});

When("the player takes several social turns between ceremonies", function (this: BbWorld) {
  const sb = this.igtSandbox!;
  this.igtHourBefore = sb.session.inGameHour();
  this.igtScenesBefore = new Set(scenes(sb));
  for (let t = 0; t < 12; t++) socialTurn(sb, `linger ${t}`);
  this.igtNewScenes = scenes(sb).filter((id) => !this.igtScenesBefore!.has(id));
});

When("the player lingers through many social turns", function (this: BbWorld) {
  const sb = this.igtSandbox!;
  let seen = new Set(scenes(sb));
  let tickTurns = 0;
  const N = 15;
  for (let t = 0; t < N; t++) {
    socialTurn(sb, `linger ${t}`);
    const now = scenes(sb);
    if (now.some((id) => !seen.has(id))) tickTurns++;
    seen = new Set(now);
  }
  this.igtTickTurns = tickTurns;
  (this as { igtTurns?: number }).igtTurns = N;
});

When("the in-game clock is read for pacing", function (this: BbWorld) {
  // No-op: the reads are exercised in the Then. Present so the scenario reads naturally.
});

Then("in-game time advances across those turns", function (this: BbWorld) {
  assert.ok(this.igtHourBefore !== undefined, "the clock had started");
  assert.ok(this.igtSandbox!.session.inGameHour()! > this.igtHourBefore!, "in-game time advanced during social play");
});

Then("the off-screen house schemes at least once during that social play", function (this: BbWorld) {
  assert.ok(this.igtNewScenes!.length > 0, "the hidden house schemed during the player's social play");
});

Then("none of that scheming is witnessed by the player", function (this: BbWorld) {
  const sb = this.igtSandbox!;
  for (const id of this.igtNewScenes!) {
    const ev = sb.engine.events.queryAll().find((e) => e.id === id)!;
    assert.equal(ev.witnessSet.includes(PLAYER), false, "off-screen scheming is never witnessed by the player");
  }
});

Then("the off-screen house schemes on some turns but stays quiet on others", function (this: BbWorld) {
  const ticks = this.igtTickTurns!;
  const turns = (this as { igtTurns?: number }).igtTurns!;
  assert.ok(ticks > 0, "the house schemed during social play (un-silenced)");
  assert.ok(ticks < turns, "but NOT on every turn — the society is paced by in-game time, not per tool call");
});

Then("no in-game time advances", function (this: BbWorld) {
  assert.equal(this.igtSandbox!.session.inGameHour(), undefined, "no in-game clock runs");
});

Then("the off-screen house stays quiet during that social play", function (this: BbWorld) {
  assert.equal(this.igtNewScenes!.length, 0, "with the clock off, social turns add no off-screen scene");
});

Then("the reads return only the clock, never any Vault content", function (this: BbWorld) {
  const sb = this.igtSandbox!;
  const hour = sb.session.inGameHour();
  assert.equal(typeof hour, "number", "inGameHour returns the clock hour");
  assert.ok(!JSON.stringify(hour).includes("VAULT_117_SENTINEL"), "no Vault content in the hour read");
  assert.ok(!JSON.stringify(sb.session.perConversationClockLive()).includes("VAULT_117_SENTINEL"), "no Vault content in the live read");
  // An explicit ALLOWLIST (deepEqual on the key set), not "no forbidden key": the player-facing reads may carry ONLY these
  // clock-bearing fields — a stray raw-hour / depth / rest key fails here instead of slipping through.
  const CLOCK_KEY = /time|clock|hour|asleep|rest|night|schedule|depth/i;
  const clockKeys = (o: object): string[] => Object.keys(o).filter((k) => CLOCK_KEY.test(k)).sort();
  assert.deepEqual(clockKeys(sb.session.gameStatus()), ["asleep", "timeOfDay"], "gameStatus carries no clock key beyond the allowed clock fields");
  assert.deepEqual(clockKeys(sb.session.getGameState()), ["asleep", "daySchedule", "timeOfDay"], "getGameState carries no clock key beyond the allowed clock fields");
  assert.ok(!JSON.stringify(sb.session.gameStatus()).includes("VAULT_117_SENTINEL"), "no Vault content in the public status");
});
