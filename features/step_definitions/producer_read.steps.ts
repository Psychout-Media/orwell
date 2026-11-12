import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { computeExchangeAccounting } from "../../src/engine/producerRead";
import { PLAYER } from "../../src/domain/ids";

// Feature 0137 - the producer read. Roles only. The player-gain half is staged through the real knowledge service and the
// real accounting function (nothing inside a recorded scene surfaces a fact synchronously, so the gain is surfaced first and
// the accounting stashed through the session's own seam); the flag-gated sink wiring is exercised through a real recordInteraction.
type Sb = ReturnType<GameSessionRegistry["sandboxFor"]>;
interface Ctx { sb: Sb; npc: string; first: string; second: string; stashCalls: number; prompt: string }
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => state.get(w)!;
const LINE = /THE EXCHANGE \(voice this in second person[^\n]*/;

function stage(seed: number): Ctx {
  const sb = new GameSessionRegistry().sandboxFor(`pr-${seed}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const npc = sb.session.livingIds().find((i) => i !== PLAYER)!;
  return { sb, npc, first: "", second: "", stashCalls: 0, prompt: "" };
}
const promptOf = (c: Ctx): string => c.sb.session.getMomentPrompt({ moment: "social" }).systemPrompt;
/** The player learns a fact through a real pathway during a scene that discloses nothing of the player's. */
function playerLearnedScene(c: Ctx): void {
  const before = new Set(c.sb.engine.knowledge.knownTo(PLAYER).map((f) => f.factId ?? f.id));
  c.sb.engine.knowledge.seedBelief(c.npc, { content: "the teller backs the plan", originalContent: "the teller backs the plan", factId: "pr:1", confidence: 0.9, hops: 0, distortion: 0, source: c.npc }, "origin");
  c.sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: "the teller backs the plan", subject: c.npc }, `told-by:${c.npc}`);
  const acc = computeExchangeAccounting({ content: "easy chat", kind: "bonding" }, before, c.sb.engine.knowledge.knownTo(PLAYER));
  c.sb.session.stashExchangeAccounting(acc);
}

Given("a recorded scene that added a fact to the player's knowledge and disclosed nothing", function (this: BbWorld) {
  const c = stage(7); c.sb.session.setProducerReadEnabled(true); playerLearnedScene(c); state.set(this, c);
});
When("the next moment prompt is built", function (this: BbWorld) { const c = st(this); c.first = promptOf(c); });
Then("it carries a second-person exchange beat favoring the player", function (this: BbWorld) {
  const m = st(this).first.match(LINE);
  assert.ok(m, "the exchange beat is present");
  assert.ok(m![0].includes("You got more than you gave."), m![0]);
  assert.ok(m![0].includes("tipped your way"), m![0]);
  assert.ok(!/\d/.test(m![0].split("edges):")[1]!), "no number in the beat");
});

Given("an exchange beat already delivered", function (this: BbWorld) {
  const c = stage(8); c.sb.session.setProducerReadEnabled(true); playerLearnedScene(c);
  c.first = promptOf(c);
  assert.ok(LINE.test(c.first), "the beat was delivered once");
  state.set(this, c);
});
When("the following moment prompt is built", function (this: BbWorld) { const c = st(this); c.second = promptOf(c); });
Then("the beat is not repeated", function (this: BbWorld) { assert.ok(!LINE.test(st(this).second)); });

Given("the producer read is disabled", function (this: BbWorld) {
  const c = stage(9); c.sb.session.setProducerReadEnabled(false);
  const real = c.sb.session.stashExchangeAccounting.bind(c.sb.session);
  c.sb.session.stashExchangeAccounting = (acc) => { c.stashCalls += 1; real(acc); };
  state.set(this, c);
});
When("a scene is recorded", function (this: BbWorld) {
  const c = st(this);
  c.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, c.npc], kind: "strategy", content: "a plan" });
  c.prompt = promptOf(c);
});
Then("the moment prompt is unchanged", function (this: BbWorld) {
  const c = st(this);
  assert.ok(!c.prompt.includes("THE EXCHANGE"), "no exchange beat");
  assert.equal(c.stashCalls, 0, "nothing was stashed for delivery");
});
