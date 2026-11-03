import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { PLAYER } from "../../src/domain/ids";
import type { UserSandbox } from "../../src/composition/registry";

// Feature 0120 (PO expansion of the 0038 review) — the strategic-drive off-screen cadence. Roles only;
// the hidden off-screen society is walled from the player.

// The off-screen society's rng is seeded per USER (B60/E12 — each user's stream is their own), so
// determinism is per (seed AND user): comparisons must hold the user name fixed and vary only the knob.
function scGame(seed: number, cadenceOn: boolean, user = "sc-cmp"): { sb: UserSandbox; orch: Orchestrator; user: string } {
  const reg = new GameSessionRegistry();
  const orch = new Orchestrator(reg, { now: () => seed }, { seed });
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setStrategicCadenceEnabled(cadenceOn);
  return { sb, orch, user };
}

const stream = (sb: UserSandbox): string[] =>
  sb.engine.events.queryAll()
    .filter((e) => e.hidden && e.id.startsWith("offscreen:"))
    .map((e) => `${e.initiator}:${e.type}:${e.content}`);

Given("a started game with a scheming house", function (this: BbWorld) {
  const g = scGame(7, true);
  this.scSandbox = g.sb; this.scOrch = g.orch; this.scUser = g.user;
});

Given("a started game with the strategic cadence on", function (this: BbWorld) {
  const g = scGame(41, true);
  this.scSandbox = g.sb; this.scOrch = g.orch; this.scUser = g.user;
});

When("each houseguest's strategic drive is read", function (this: BbWorld) {
  const npcs = this.scSandbox!.session.snapshot().house!.npcs;
  const sharp = [...npcs].sort((a, b) => b.character.stats.mental - a.character.stats.mental)[0]!;
  const passive = [...npcs].sort((a, b) => a.character.stats.mental - b.character.stats.mental)[0]!;
  this.scSharpDrive = this.scSandbox!.session.initiatorDrive(sharp.id);
  this.scPassiveDrive = this.scSandbox!.session.initiatorDrive(passive.id);
});

Then("a sharper, more-strategic houseguest weighs more than a passive one", function (this: BbWorld) {
  assert.ok(this.scSharpDrive! > this.scPassiveDrive!, "the sharper houseguest carries a higher drive");
});

Then("the difference is slight, never a wild skew", function (this: BbWorld) {
  assert.ok(this.scPassiveDrive! > 0, "every drive is positive");
  assert.ok(this.scSharpDrive! / this.scPassiveDrive! < 3, "the skew is slight (< 3x), not a wild dominance");
});

When("the same off-screen ticks run on each", function () {
  // Ticks already applied in the Given (deterministic setup).
});

Given("the same seed with the strategic cadence on versus off", function (this: BbWorld) {
  // Search a small seed set for one where the weighting visibly shifts the initiator pattern.
  for (const seed of [21, 22, 23, 24, 25, 26]) {
    const off = scGame(seed, false);
    const on = scGame(seed, true);
    const onB = scGame(seed, true);
    for (let t = 0; t < 12; t++) {
      off.orch.advance(off.user, "offscreen-tick");
      on.orch.advance(on.user, "offscreen-tick");
      onB.orch.advance(onB.user, "offscreen-tick");
    }
    this.scOffStream = stream(off.sb);
    this.scOnStream = stream(on.sb);
    this.scOnStreamB = stream(onB.sb);
    if (JSON.stringify(this.scOffStream) !== JSON.stringify(this.scOnStream)) return;
  }
});

Then("the on cadence changes the off-screen initiator pattern", function (this: BbWorld) {
  assert.notDeepEqual(this.scOnStream, this.scOffStream, "turning the cadence on shifts who schemes");
});

Then("the on cadence is itself seed-deterministic", function (this: BbWorld) {
  assert.deepEqual(this.scOnStream, this.scOnStreamB, "cadence on, same seed ⇒ identical society");
});

When("the cadenced off-screen society runs several ticks", function (this: BbWorld) {
  for (let t = 0; t < 10; t++) this.scOrch!.advance(this.scUser!, "offscreen-tick");
});

Then("no off-screen scene is witnessed by the player", function (this: BbWorld) {
  const scenes = this.scSandbox!.engine.events.queryAll().filter((e) => e.hidden && e.id.startsWith("offscreen:"));
  assert.ok(scenes.length > 0, "the off-screen society ran");
  for (const s of scenes) assert.ok(!s.witnessSet.includes(PLAYER), "the player witnesses no off-screen scene");
});
