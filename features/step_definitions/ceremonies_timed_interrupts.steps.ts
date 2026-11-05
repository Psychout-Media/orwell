import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { renderGameContext } from "../../src/engine/momentPrompts";
import { nextMilestone, MILESTONE_LABEL, DAY_SCHEDULE } from "../../src/engine/daySchedule";
import { resolvePending } from "../support/answerPending";
import { PLAYER } from "../../src/domain/ids";
import type { UserSandbox } from "../../src/composition/registry";

// Feature 0118 (Phase 2, in-game-time pivot) — the day is telegraphed: the next ceremony is announced
// ahead of time, the narrator is primed during the run-up, and when the clock reaches the scheduled time
// production calls the whole house to gather. Dormant + byte-identical when the clock is off. Roles only.

let dscUsers = 0;

function buildScheduledHouse(w: BbWorld, clockOn: boolean, seed = 7): void {
  GameSessionAdapter.setTimeOfDayEnabled(clockOn);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`dsc${dscUsers++}`);
  sb.session.createCharacter({ playerName: "Player", seed });
  sb.session.setPerConversationClockEnabled(true);
  const orch = new Orchestrator(reg, new FakeClock(), { seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  for (let i = 0; i < 120; i++) {
    if (sb.session.perConversationClockLive() && sb.session.snapshot().live?.hoh !== undefined) break;
    if (clockOn ? false : sb.session.snapshot().live?.hoh !== undefined) break;
    const v = sb.session.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => sb.session.submitDecision(req));
    if (v.finished) break;
  }
  w.dscSandbox = sb;
}

const socialTurn = (sb: UserSandbox, c: string): void => {
  const npc = sb.session.livingIds().filter((id) => id !== PLAYER)[0]!;
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content: c });
};

Given("a scheduled house with the in-game clock running", function (this: BbWorld) {
  buildScheduledHouse(this, true);
  assert.equal(this.dscSandbox!.session.perConversationClockLive(), true, "the in-game clock is live");
});

Given("a scheduled house with the in-game clock turned off", function (this: BbWorld) {
  buildScheduledHouse(this, false);
});

Given("a scheduled house with the in-game clock running and a populated Vault", function (this: BbWorld) {
  buildScheduledHouse(this, true);
  this.dscSandbox!.engine.vault.writeHidden({ id: "v118", kind: "hidden-attribute", content: "hidden VAULT_118_SENTINEL" });
});

When("the narrator context is built during the run-up", function (this: BbWorld) {
  this.dscContext = renderGameContext(this.dscSandbox!.session.getGameState());
});

When("the player lingers until the scheduled ceremony time arrives", function (this: BbWorld) {
  const sb = this.dscSandbox!;
  const target = nextMilestone(sb.session.snapshot().live)!.targetHour;
  for (let t = 0; t < 60 && (sb.session.inGameHour() ?? 0) < target; t++) socialTurn(sb, `linger ${t}`);
  this.dscContext = renderGameContext(sb.session.getGameState());
});

When("the day schedule and narrator priming are read", function (this: BbWorld) {
  this.dscContext = renderGameContext(this.dscSandbox!.session.getGameState());
});

Then("the day schedule names the coming ceremony and its in-game phase", function (this: BbWorld) {
  const ds = this.dscSandbox!.session.getGameState().daySchedule;
  assert.ok(ds, "a day schedule is present");
  assert.equal(ds!.next, this.dscSandbox!.session.snapshot().live!.beat, "it names the current ceremony");
  assert.equal(ds!.phase, DAY_SCHEDULE[ds!.next], "it carries the scheduled phase");
});

Then("the narrator is primed that the ceremony is coming", function (this: BbWorld) {
  const ds = this.dscSandbox!.session.getGameState().daySchedule!;
  assert.ok(this.dscContext!.includes(MILESTONE_LABEL[ds.next]), "the narrator context names the ceremony");
  assert.match(this.dscContext!, /COMING UP|IT IS TIME/, "the narrator context telegraphs it");
});

Then("the ceremony is marked due", function (this: BbWorld) {
  assert.equal(this.dscSandbox!.session.milestoneDue(), true, "the milestone is due");
  assert.equal(this.dscSandbox!.session.getGameState().daySchedule!.due, true, "the view flag is due");
});

Then("the narrator calls the whole house together for it", function (this: BbWorld) {
  assert.match(this.dscContext!, /IT IS TIME/, "production calls the gather");
  assert.match(this.dscContext!.toLowerCase(), /living room|gather/, "the whole house is called together");
});

Then("there is no day schedule", function (this: BbWorld) {
  assert.equal(this.dscSandbox!.session.getGameState().daySchedule, undefined, "no schedule when the clock is off");
  assert.equal(this.dscSandbox!.session.milestoneDue(), false, "nothing is due when the clock is off");
});

Then("the narrator context carries no schedule line", function (this: BbWorld) {
  assert.doesNotMatch(this.dscContext!, /COMING UP|IT IS TIME/, "no schedule line when the clock is off");
});

Then("they carry only the public schedule, never any Vault content", function (this: BbWorld) {
  const ds = this.dscSandbox!.session.getGameState().daySchedule;
  assert.ok(!JSON.stringify(ds).includes("VAULT_118_SENTINEL"), "the schedule carries no Vault content");
  assert.ok(!this.dscContext!.includes("VAULT_118_SENTINEL"), "the priming carries no Vault content");
});
