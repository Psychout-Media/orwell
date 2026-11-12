import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";

// Feature 0138 - the player dossier. Roles only: two houseguest roles, read through the session's own playerDossier lever.
type Sb = ReturnType<GameSessionRegistry["sandboxFor"]>;
type Dossier = Record<string, Array<{ content: string; ts: number }>>;
interface Ctx { sb: Sb; a: string; b: string; result: Dossier }
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => state.get(w)!;

function stage(seed: number): Ctx {
  const sb = new GameSessionRegistry().sandboxFor(`dossier-${seed}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setPlayerDossierEnabled(true);
  return { sb, a: npc(1), b: npc(2), result: {} };
}
function recordReads(c: Ctx): void {
  c.sb.engine.knowledge.recordDiaryRoom("the first houseguest is playing both sides", c.a);
  c.sb.engine.knowledge.recordDiaryRoom("the second houseguest might be a threat", c.b);
  c.sb.engine.knowledge.recordDiaryRoom("the first houseguest denied everything", c.a);
}

Given("the player recorded Diary-Room reads on two houseguests", function (this: BbWorld) { const c = stage(7); recordReads(c); state.set(this, c); });
Given("reads on several houseguests", function (this: BbWorld) { const c = stage(8); recordReads(c); c.sb.engine.knowledge.recordDiaryRoom("the third houseguest is quiet", npc(3)); state.set(this, c); });
Given("a dossier read on any houseguest", function (this: BbWorld) {
  const c = stage(9); recordReads(c);
  // Engine truth that shares the subject: a witnessed fact on the player, and NPC-only beliefs with a sentinel. None may surface.
  c.sb.engine.knowledge.seedBelief(PLAYER, { content: "SENTINEL-engine-truth about the first houseguest", subject: c.a, factId: "d:truth" }, "witnessed");
  c.sb.engine.knowledge.seedBelief(c.a, { content: "SENTINEL-npc-only belief", subject: c.a, factId: "d:npc" }, "witnessed");
  c.sb.engine.vault.writeHidden({ id: "d:vault", kind: "confessional", subject: c.a, content: "SENTINEL-vault-content" });
  state.set(this, c);
});

When("the dossier is read", function (this: BbWorld) { const c = st(this); c.result = c.sb.session.playerDossier(); });
When("the dossier is read for one subject", function (this: BbWorld) { const c = st(this); c.result = c.sb.session.playerDossier(c.a); });
When("the result is inspected", function (this: BbWorld) { const c = st(this); c.result = c.sb.session.playerDossier(c.a); });

Then("the reads are grouped per houseguest in the player's own words", function (this: BbWorld) {
  const c = st(this);
  assert.deepEqual(Object.keys(c.result).sort(), [c.a, c.b].sort());
  assert.deepEqual(c.result[c.a]!.map((e) => e.content), ["the first houseguest is playing both sides", "the first houseguest denied everything"]);
  assert.deepEqual(c.result[c.b]!.map((e) => e.content), ["the second houseguest might be a threat"]);
});
Then("only that houseguest's reads are returned", function (this: BbWorld) {
  const c = st(this);
  assert.deepEqual(Object.keys(c.result), [c.a]);
  assert.equal(c.result[c.a]!.length, 2);
});
Then("it contains no hidden state or relationship values", function (this: BbWorld) {
  const c = st(this);
  const json = JSON.stringify(c.result);
  assert.ok(!/SENTINEL/.test(json), "no engine truth or vault content");
  for (const e of c.result[c.a]!) assert.deepEqual(Object.keys(e).sort(), ["content", "ts"]);
  assert.equal(c.result[c.a]!.length, 2, "only the Diary-Room reads on that subject");
});
