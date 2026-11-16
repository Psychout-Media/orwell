import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { LEAN_IDS, describeHouseLeans, dialMult, HOUSE_LEAN_TUNING, type HouseLeans } from "../../src/engine/houseLeans";
import { chooseHourAction, type HourView } from "../../src/engine/houseLife";
import { HOUSE_LIFE, type HouseCulture } from "../../src/engine/houseLifeConstants";

/** Feature 0168 - the house culture foundation (ORW-551). Drives the REAL adapter. Roles only. */
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
Given("two played seasons with the same seed, one with house culture off and one whose culture has no leans", function () {
  const neutral = start(true, false, 3).s;
  (neutral as unknown as { live: { houseLeans?: HouseLeans } }).live.houseLeans = { leans: [] };
  neutral.noteMessage({ messageId: "m1" });
  const off = start(false, true, 3).s;
  neutral.advanceGame({}); off.advanceGame({});
  bag(this).a = strip(neutral); bag(this).b = strip(off);
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
Then("they are identical", function () { assert.equal(bag(this).a, bag(this).b); });
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

const cult = (id: "gossip-mill" | "powder-keg"): HouseCulture => { const c = { leans: [{ id, w: 1 }] }; return { gossip: dialMult(c, "gossip"), conflict: dialMult(c, "conflict"), flirting: dialMult(c, "flirting"), lying: dialMult(c, "lying") }; };
const hourView = (over: Partial<HourView>): HourView => ({
  owner: "npc:1", character: { archetype: "hothead", strategyStyle: "social", secretKinds: [] }, agenda: undefined, habits: [], emotional: 0.5, room: "living-room",
  whereabouts: new Map([["npc:1", "living-room"], ["npc:2", "living-room"], ["npc:3", "kitchen"]]), affinity: new Map([["npc:2", 0.1], ["npc:3", 0.5]]), threat: new Map([["npc:3", 0.8]]),
  mates: [], nominees: [], timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
});
const kindRate = (v: HourView, kind: string): number => { let hit = 0, k = 0; for (let seed = 1; seed <= 60; seed++) for (let h = 8; h < 24; h++) { k++; if (chooseHourAction({ ...v, hour: h }, seed).kind === kind) hit++; } return hit / k; };
Given("a gossip-mill culture and a powder-keg culture", function () { /* built in the Then */ });
Then("the gossip rate and the friction rate rise over no culture, and no baseline moves by more than a factor of 1.35", function () {
  const F = HOUSE_LEAN_TUNING.MAX_FACTOR;
  const talk = hourView({ affinity: new Map([["npc:2", 0.8], ["npc:3", 0.5]]) });
  assert.ok(kindRate({ ...talk, culture: cult("gossip-mill") }, "gossip") > kindRate(talk, "gossip"));
  const fight = hourView({ threat: new Map(), whereabouts: new Map([["npc:1", "living-room"], ["npc:2", "living-room"]]) });
  assert.ok(kindRate({ ...fight, culture: cult("powder-keg") }, "chore-fight") > kindRate(fight, "chore-fight"));
  for (const id of ["gossip-mill", "powder-keg"] as const) for (const v of Object.values(cult(id))) assert.ok(v <= F && v >= 1 / F);
  assert.ok(HOUSE_LIFE.gossipChance * F < 1);
});
Given("a paranoid culture, a ride-or-die culture, a majority-bloc culture, a powder-keg culture and a one-big-family culture", function () { /* built in the Then */ });
Then("the paranoia, loyalty, alliance-size, meeting and bonding dials each rise over no culture, and none moves by more than a factor of 1.35", function () {
  const F = HOUSE_LEAN_TUNING.MAX_FACTOR;
  const one = (id: (typeof LEAN_IDS)[number]): HouseLeans => ({ leans: [{ id, w: 1 }] });
  const pairs = [["paranoid", "paranoia"], ["ride-or-die", "loyalty"], ["majority-bloc", "allianceSize"], ["powder-keg", "meetings"], ["one-big-family", "bonding"]] as const;
  for (const [lean, dial] of pairs) {
    const v = dialMult(one(lean), dial);
    assert.ok(v > 1, `${lean} should raise ${dial}`);
    assert.ok(v <= F && v >= 1 / F);
    assert.equal(dialMult(undefined, dial), 1);
  }
});

Given("a gossip-mill culture and a liars-season culture", function () { /* built in the Then */ });
Then("a listener's credulity rises in the first and falls in the second over no culture, stays within {int} to {int}, and no culture changes nothing", function (lo: number, hi: number) {
  const credOf = (s: GameSessionAdapter, id: string): number => (s as unknown as { credulityOf(id: string): number }).credulityOf(id);
  const withLeans = (leans: HouseLeans | undefined): number => {
    const { s } = start(true, true, 3);
    if (leans) live(s).houseLeans = leans;
    const v = credOf(s, "npc:1");
    assert.ok(v >= lo && v <= hi, `credulity ${v} outside ${lo}..${hi}`);
    return v;
  };
  const none = withLeans(undefined);
  const gossipy = withLeans({ leans: [{ id: "gossip-mill", w: 1 }] });
  const liars = withLeans({ leans: [{ id: "liars-season", w: 1 }] });
  assert.ok(gossipy > none, "a gossip-mill house raises credulity");
  assert.ok(liars < none, "a liars-season house lowers credulity");
  assert.equal(withLeans({ leans: [] }), none, "an empty culture changes nothing");
});
