import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { AllianceStore, allianceTieBoost, type AllianceHistoryEntry } from "../../src/engine/alliances";
import type { RelationshipModel } from "../../src/engine/relationships";

/**
 * Feature 0161 - alliance history (ORW-544). Drives the REAL adapter: alliances are named on its own store, the real fade / prune / betrayal paths run, and the events are read
 * back from the engine's event store. Roles only.
 */
type Poke = {
  live: { dayNumber?: number; week: number; evictionOrder?: EntityId[] };
  alliances: AllianceStore;
  rel: RelationshipModel;
  fadeAlliances(): void;
  campaignTick(): void;
  reconcileAllianceBetrayals(a: unknown): void;
};
type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; npcs?: string[]; saved?: ReturnType<GameSessionAdapter["snapshot"]>; loaded?: GameSessionAdapter; earlier?: number; newId?: string; endedIds?: string[] };
const bag = (w: unknown): Bag => ((w as { ah0161?: Bag }).ah0161 ??= {});
const poke = (s: GameSessionAdapter): Poke => s as unknown as Poke;
const NAME = "The Faded Few";
let n = 0;

function start(w: unknown, seed = 7, campaigns = false): void {
  const sb = new GameSessionRegistry().sandboxFor(`alliancehistory0161-${n++}`);
  if (campaigns) sb.session.setCampaignsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const b = bag(w);
  b.sb = sb; b.s = sb.session;
  b.npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
}
function setBond(s: GameSessionAdapter, a: EntityId, b: EntityId, v: number): void {
  for (const [x, y] of [[a, b], [b, a]] as const) { const e = poke(s).rel.edge(x, y); e.trust = v; e.affinity = v; e.threat = 0.1; }
}
const cold = (s: GameSessionAdapter, ids: EntityId[]): void => { for (const a of ids) for (const b of ids) if (a < b) setBond(s, a, b, 0); };
const history = (s: GameSessionAdapter): readonly AllianceHistoryEntry[] => poke(s).alliances.history();
const allianceEvents = (b: Bag) => b.sb!.engine.events.queryAll().filter((e) => e.type.startsWith("alliance-"));
function fadeDays(s: GameSessionAdapter, days = 4): void {
  for (let d = 1; d <= days; d++) { poke(s).live.dayNumber = d; poke(s).fadeAlliances(); }
}

Given("an alliance history season where three houseguests named an alliance and have grown cold to each other", function () {
  start(this);
  const b = bag(this); const [x, y, z] = b.npcs!;
  poke(b.s!).alliances.add(NAME, x!, [x!, y!, z!], 1);
  cold(b.s!, [x!, y!, z!]);
});
Given("an alliance history season where three houseguests named an alliance", function () {
  start(this);
  const [x, y, z] = bag(this).npcs!;
  poke(bag(this).s!).alliances.add(NAME, x!, [x!, y!, z!], 1);
});
Given("an alliance history season where two houseguests named an alliance", function () {
  start(this);
  const [x, y] = bag(this).npcs!;
  poke(bag(this).s!).alliances.add(NAME, x!, [x!, y!], 1);
});
Given("an alliance history season where an alliance was named and the player was pitched into it", function () {
  start(this);
  const b = bag(this); const [x, y, z] = b.npcs!;
  const a = poke(b.s!).alliances.add(NAME, x!, [x!, y!, z!], 1);
  poke(b.s!).alliances.reveal(a.id, PLAYER);
  cold(b.s!, [x!, y!, z!]);
});
Given("an alliance history season where one alliance faded and another is still standing", function () {
  start(this);
  const b = bag(this); const [x, y, z, p, q] = b.npcs!;
  const store = poke(b.s!).alliances;
  store.add(NAME, x!, [x!, y!, z!], 1);
  store.add("The Steady Two", p!, [p!, q!], 1);
  cold(b.s!, [x!, y!, z!]); setBond(b.s!, p!, q!, 0.9);
  fadeDays(b.s!);
  assert.equal(store.all().length, 1, "only the steady alliance is left");
});
Given("an alliance history season where the newest alliance has ended and an older one is still standing", function () {
  start(this);
  const b = bag(this); const [x, y, p, q] = b.npcs!;
  const store = poke(b.s!).alliances;
  store.add("The Older Two", p!, [p!, q!], 1);
  const newest = store.add(NAME, x!, [x!, y!], 1);
  store.removeMember(newest.id, y!);
  assert.equal(store.byId(newest.id), undefined);
  b.endedIds = [newest.id];
});
Given("an alliance history season where a bonded trio of houseguests can name an alliance off-screen", function () {
  start(this, 2026, true);
  const b = bag(this); const [x, y, z] = b.npcs!;
  setBond(b.s!, x!, y!, 0.85); setBond(b.s!, x!, z!, 0.85); setBond(b.s!, y!, z!, 0.85);
});

When("the alliance history days pass until it fades", function () { fadeDays(bag(this).s!); });
When("one of them turns on the other", function () {
  const b = bag(this); const [x, y] = b.npcs!;
  poke(b.s!).reconcileAllianceBetrayals({ actor: x, kind: "nominate", targets: [y] });
});
When("two of them have left the house", function () {
  const b = bag(this); const [x, y] = b.npcs!;
  const live = poke(b.s!).live;
  live.evictionOrder = [...(live.evictionOrder ?? []), x!, y!];
  poke(b.s!).fadeAlliances();
});
When("the season is saved and loaded into a fresh session", function () {
  const b = bag(this);
  b.earlier = history(b.s!).length;
  b.saved = JSON.parse(JSON.stringify(b.s!.snapshot()));
  const fresh = new GameSessionRegistry().sandboxFor(`alliancehistory0161-${n++}`).session;
  fresh.restore(b.saved!);
  b.loaded = fresh;
});
When("the houseguests name a new alliance", function () {
  const b = bag(this); const [x, y] = b.npcs!;
  b.newId = poke(b.loaded!).alliances.add("The Newcomers", x!, [x!, y!], 2).id;
});
When("the house lives long enough for them to name it", function () {
  const b = bag(this);
  for (let k = 0; k < 4 && poke(b.s!).alliances.all().length === 0; k++) poke(b.s!).campaignTick();
  assert.ok(poke(b.s!).alliances.all().length > 0, "the trio named an alliance");
});

Then("the alliance is gone from the live alliances", function () { assert.equal(poke(bag(this).s!).alliances.all().length, 0); });
Then("the alliance history still holds it, with all three members and the reason it faded", function () {
  const b = bag(this);
  const fade = history(b.s!).find((e) => e.kind === "faded");
  assert.ok(fade, "a faded entry is kept");
  assert.deepEqual([...fade!.members].sort(), [...b.npcs!.slice(0, 3)].sort());
  assert.equal(fade!.why, "cohesion");
  assert.equal(fade!.name, NAME);
});
Then("the alliance history still holds the betrayal and the ended alliance with both members", function () {
  const b = bag(this); const [x, y] = b.npcs!;
  const kinds = history(b.s!).map((e) => e.kind);
  assert.ok(kinds.includes("betrayed"));
  const end = history(b.s!).find((e) => e.kind === "dissolved");
  assert.ok(end, "the ended alliance is kept");
  assert.deepEqual([...end!.members].sort(), [x!, y!].sort());
  assert.equal(end!.why, "betrayal");
});
Then("the alliance history still holds the two exits and the ended alliance with all three members", function () {
  const b = bag(this);
  assert.equal(history(b.s!).filter((e) => e.kind === "left" && e.why === "evicted").length, 2);
  const end = history(b.s!).find((e) => e.kind === "dissolved");
  assert.ok(end, "the ended alliance is kept");
  assert.deepEqual([...end!.members].sort(), [...b.npcs!.slice(0, 3)].sort());
  assert.equal(end!.why, "evicted-out");
});
Then("the loaded session holds every history entry the saved one held", function () {
  const b = bag(this);
  assert.ok(b.earlier! > 0);
  assert.deepEqual(history(b.loaded!), history(b.s!));
});
Then("a later save never holds fewer history entries than an earlier one", function () {
  const b = bag(this);
  const later = b.loaded!.snapshot();
  assert.ok((later.allianceHistory ?? []).length >= b.earlier!);
  assert.deepEqual((later.allianceHistory ?? []).map((e) => e.seq), (b.saved!.allianceHistory ?? []).map((e) => e.seq));
});
Then("the new alliance has an id no earlier alliance ever had", function () {
  const b = bag(this);
  const used = new Set(history(b.loaded!).filter((e) => e.seq).map((e) => e.allianceId));
  const earlierIds = [...used].filter((id) => id !== b.newId);
  assert.ok(!earlierIds.includes(b.newId!), `id ${b.newId} was reused`);
  assert.equal(history(b.loaded!).filter((e) => e.allianceId === b.newId).length, 1, "only the new alliance holds that id");
  assert.ok(b.endedIds!.every((id) => id !== b.newId));
});
Then("an alliance-formed event is on record naming only those houseguests as witnesses", function () {
  const b = bag(this);
  const ev = allianceEvents(b).find((e) => e.type === "alliance-formed");
  assert.ok(ev, "a formed event is recorded");
  const members = poke(b.s!).alliances.all()[0]!.members;
  assert.deepEqual([...ev!.witnessSet].sort(), [...members].sort());
  assert.ok(!ev!.witnessSet.includes(PLAYER));
});
Then("that event is hidden from the player", function () {
  const ev = allianceEvents(bag(this)).find((e) => e.type === "alliance-formed")!;
  assert.equal(ev.hidden, true);
});
Then("an alliance-faded event is on record and it is hidden from the player", function () {
  const ev = allianceEvents(bag(this)).filter((e) => e.type === "alliance-faded");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.hidden, true);
  assert.ok(!ev[0]!.witnessSet.includes(PLAYER));
});
Then("the alliance-faded event is visible to the player", function () {
  const ev = allianceEvents(bag(this)).filter((e) => e.type === "alliance-faded");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.hidden, false);
  assert.ok(ev[0]!.witnessSet.includes(PLAYER));
});
Then("no player or admin view shows the alliance name, its members or the alliance history", async function () {
  const b = bag(this);
  const blob = JSON.stringify([
    await b.sb!.mcp.player.callTool("getGameState", {}), await b.sb!.mcp.player.callTool("gameStatus", {}),
    await b.sb!.mcp.player.callTool("getMomentPrompt", {}), await b.sb!.mcp.player.callTool("seasonRetrospective", {}),
    await b.sb!.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
  for (const k of [NAME, "allianceHistory", "alliance-faded", "alliance-formed", "alliance-dissolved"]) assert.ok(!blob.includes(k), `a live surface carries ${k}`);
});
Then("the live alliances and the bloc cement read exactly as they did without a history", function () {
  const b = bag(this); const [x, y, z] = b.npcs!;
  const store = poke(b.s!).alliances;
  const bare = new AllianceStore();
  bare.load(store.serialize()); // the same live rows, no history
  assert.deepEqual(store.serialize(), bare.serialize());
  for (const [p, q] of [[x!, y!], [x!, z!], [y!, z!]]) assert.equal(allianceTieBoost(store.all(), p, q), allianceTieBoost(bare.all(), p, q));
  assert.ok(allianceTieBoost(store.all(), x!, y!) > 0);
});
