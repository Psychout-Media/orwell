import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { LEAN_IDS, describeHouseLeans, type HouseLeans } from "../../src/engine/houseLeans";

/** Feature 0162 - the house culture foundation (ORW-551). Drives the REAL adapter. Roles only. */
type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; copy?: GameSessionAdapter; a?: string; b?: string };
const bag = (w: unknown): Bag => ((w as { hc0159?: Bag }).hc0159 ??= {});
const live = (s: GameSessionAdapter) => (s as unknown as { live: { houseLeans?: HouseLeans } }).live;
let n = 0;
function start(flag: boolean, played: boolean, seed = 21): { sb: UserSandbox; s: GameSessionAdapter } {
  const sb = new GameSessionRegistry().sandboxFor(`culture0159-${n++}`);
  sb.session.setHouseCultureEnabled(flag);
  sb.session.createCharacter({ playerName: "The Player", seed });
  if (played) sb.session.noteMessage({ messageId: "m1" });
  return { sb, s: sb.session };
}
const strip = (s: GameSessionAdapter) => { const x = s.snapshot() as unknown as { live?: { houseLeans?: unknown } }; delete x.live?.houseLeans; return JSON.stringify(x); };

Given("a season where a person has started playing", function () { const r = start(true, true); Object.assign(bag(this), r); });
Given("a season that nobody has played", function () { const r = start(true, false); Object.assign(bag(this), r); });
Given("two played seasons with the same seed, one with house culture on and one off", function () {
  const on = start(true, true, 3).s, off = start(false, true, 3).s;
  on.advanceGame({}); off.advanceGame({});
  bag(this).a = strip(on); bag(this).b = strip(off);
});

Then("the season holds a culture of two or three distinct leans whose weights sum to one", function () {
  const c = live(bag(this).s!).houseLeans!;
  assert.ok(c.leans.length >= 2 && c.leans.length <= 3);
  assert.equal(new Set(c.leans.map((l) => l.id)).size, c.leans.length);
  assert.ok(Math.abs(c.leans.reduce((a, l) => a + l.w, 0) - 1) < 1e-9);
});
Then("playing on does not change it", function () {
  const s = bag(this).s!; const before = JSON.stringify(live(s).houseLeans);
  s.noteMessage({ messageId: "m2" });
  assert.equal(JSON.stringify(live(s).houseLeans), before);
});
When("the season is saved and loaded", function () {
  const b = bag(this);
  const copy = new GameSessionRegistry().sandboxFor(`culture0159-${n++}`).session;
  copy.restore(JSON.parse(JSON.stringify(b.s!.snapshot())));
  b.copy = copy;
});
Then("the loaded season holds the same culture", function () {
  assert.deepEqual(live(bag(this).copy!).houseLeans, live(bag(this).s!).houseLeans);
});
Then("no player or admin view shows a lean, a weight or the culture", async function () {
  const b = bag(this);
  const blob = JSON.stringify([
    await b.sb!.mcp.player.callTool("getGameState", {}), await b.sb!.mcp.player.callTool("gameStatus", {}), await b.sb!.mcp.player.callTool("getMomentPrompt", {}),
    await b.sb!.mcp.player.callTool("seasonRetrospective", {}), await b.sb!.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
  for (const id of LEAN_IDS) assert.ok(!blob.includes(`"${id}"`), `a live surface carries ${id}`);
  for (const k of ["houseLeans", "houseCulture"]) assert.ok(!blob.includes(k), `a live surface carries ${k}`);
  assert.equal(b.s!.seasonRetrospective(), null);
});
Then("they are identical apart from the culture itself", function () { assert.equal(bag(this).a, bag(this).b); });
Then("the season holds no culture", function () { assert.equal(live(bag(this).s!).houseLeans, undefined); });
When("the season is played through to its crown", function () { assert.equal(bag(this).s!.advanceToFinale().finished, true); });
Then("the retrospective describes the house in plain words, one phrase per lean, with no name, weight or number", function () {
  const b = bag(this);
  const retro = b.s!.seasonRetrospective()!;
  assert.deepEqual(retro.houseCulture!.leans, describeHouseLeans(live(b.s!).houseLeans));
  const blob = JSON.stringify(retro.houseCulture);
  for (const id of LEAN_IDS) assert.ok(!blob.includes(id));
  assert.ok(!/\d/.test(blob));
});
