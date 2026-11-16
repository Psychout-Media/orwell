import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";
import type { EntityId } from "../../src/domain/ids";

// Feature 0049 (ORW-462 amendment) — the house search never sees through a closed door. HARD rule: roles only.
type Hack = { presence: Map<EntityId, string>; ceremony: { hoh?: EntityId } };
interface Bag { s: GameSessionAdapter; behind: EntityId; inHoh: EntityId; inDiary: EntityId; speaker: EntityId; result?: ReturnType<GameSessionAdapter["whereabouts"]>; sweep?: Array<{ id: EntityId; entry: { status: string; room?: string } }> }
const bags = new WeakMap<object, Bag>();
let n = 0;
const bag = (w: object): Bag => bags.get(w)!;

Given("a played game where the player stands in the backyard, one houseguest is behind an unlocked bedroom door, one is in the HOH room held by another, and one is in the diary room", function (this: BbWorld) {
  const s = new GameSessionRegistry().sandboxFor(`closed-doors-${n++}`).session;
  s.createCharacter({ playerName: "The Player", seed: 5 });
  // past the premiere: while a whole-house event is on, everyone is gathered in the player's room
  for (let i = 0; i < 400 && (s.whereabouts()?.houseEvent || s.getGameState().phase === "premiere"); i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
  assert.ok(!s.whereabouts()?.houseEvent, "no whole-house event is on");
  const npcs = s.livingIds().filter((id) => id !== PLAYER);
  const [behind, inHoh, inDiary, speaker, holder] = npcs;
  const h = s as unknown as Hack;
  const seats: Array<[EntityId, string]> = [[PLAYER, "backyard"]];
  for (const id of npcs) seats.push([id, "kitchen"]);
  h.presence = new Map(seats);
  h.presence.set(behind!, "bedroom-a"); h.presence.set(inHoh!, "hoh-room"); h.presence.set(inDiary!, "diary-room");
  h.ceremony.hoh = holder; // someone else holds the crown, so the HOH room is closed to the player
  bags.set(this, { s, behind: behind!, inHoh: inHoh!, inDiary: inDiary!, speaker: speaker! });
});

When("the player searches the house without naming anyone", function (this: BbWorld) {
  const b = bag(this); b.result = b.s.whereabouts({ search: true });
});

const asked = (b: Bag, id: EntityId) => b.s.whereabouts({ search: true, lookingFor: id });

When("the player asks for each houseguest by name in turn, knowing nothing about where anyone is", function (this: BbWorld) {
  const b = bag(this);
  (b.s as unknown as { trackedSightings: unknown; lastSeenAt: unknown }).trackedSightings = null;
  (b.s as unknown as { trackedSightings: unknown; lastSeenAt: unknown }).lastSeenAt = null;
  b.sweep = [b.behind, b.inHoh, b.inDiary, b.speaker].map((id) => ({ id, entry: asked(b, id)!.search!.houseguests.find((e) => e.id === id)! }));
});

When("the player has watched a houseguest head into a closed room and asks for them", function (this: BbWorld) {
  const b = bag(this);
  const p = b.s as unknown as { trackedSightings: Map<EntityId, unknown> | null; lastSeenAt: unknown; presenceTickCount: number };
  p.lastSeenAt = null;
  p.trackedSightings = new Map([[b.behind, { room: "bedroom-a", tick: p.presenceTickCount, pathway: "tracked:bdd", confidence: 0.5 }]]);
  b.result = asked(b, b.behind);
});

const entry = (w: object, id: EntityId) => bag(w).result!.search!.houseguests.find((e) => e.id === id)!;

Then("the houseguests behind doors are listed as not in view with no room named", function (this: BbWorld) {
  const b = bag(this);
  for (const id of [b.behind, b.inHoh, b.inDiary]) { assert.equal(entry(this, id).status, "unseen"); assert.equal(entry(this, id).room, undefined); }
  const rooms = b.result!.search!.rooms.map((r) => r.room);
  for (const r of ["bedroom-a", "hoh-room", "diary-room"]) assert.ok(!rooms.includes(r), `${r} is not on the roster`);
});

Then("the houseguests the player can see are still named in their rooms", function (this: BbWorld) {
  const b = bag(this);
  // every houseguest the player can see (all of the others sit in the kitchen), not only one; and the kitchen roster names them all
  const hidden = new Set([b.behind, b.inHoh, b.inDiary]);
  const visible = b.result!.search!.houseguests.filter((e) => !hidden.has(e.id));
  assert.ok(visible.length >= 2, "more than one houseguest is in view");
  for (const e of visible) { assert.equal(e.status, "awake", e.id); assert.equal(e.room, "kitchen", e.id); }
  const kitchen = b.result!.search!.rooms.find((r) => r.room === "kitchen");
  assert.deepEqual(kitchen?.present.map((p) => p.id).sort(), visible.map((e) => e.id).sort());
});

Then("only the houseguest in view is placed in a room", function (this: BbWorld) {
  const b = bag(this);
  for (const { id, entry: e } of b.sweep!) {
    if (id === b.speaker) { assert.equal(e.room, "kitchen"); continue; }
    assert.equal(e.status, "unknown", `${id} is not known`);
    assert.equal(e.room, undefined, `${id} is not placed`);
  }
});

Then("the answer is a lead that names the room as last seen, not confirmed", function (this: BbWorld) {
  const e = entry(this, bag(this).behind);
  assert.equal(e.status, "lead"); assert.equal(e.room, "bedroom-a"); assert.match(e.fact, /last seen heading into/); assert.match(e.fact, /not confirmed/);
});

// --- ORW-475: asking around -------------------------------------------------------------------------------------------------------
type Ask = { s: GameSessionAdapter; V: EntityId; S: EntityId; result?: { status: string; room?: string; toldBy?: { id: string }; fact: string } };
const askBags = new WeakMap<object, Ask>();
const CANDID = { archetype: "hothead", strategyStyle: "emotional" };
const GUARDED = { archetype: "villain", strategyStyle: "strategic" };

Given("a played game where the player stands in the backyard, a houseguest is in the kitchen in view, and another is behind a bedroom door", function (this: BbWorld) {
  const s = new GameSessionRegistry().sandboxFor(`ask475-bdd-${n++}`).session;
  s.createCharacter({ playerName: "The Player", seed: 5 });
  for (let i = 0; i < 400 && (s.whereabouts()?.houseEvent || s.getGameState().phase === "premiere"); i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
  const npcs = s.livingIds().filter((id) => id !== PLAYER);
  const [V, S] = [npcs[0]!, npcs[1]!];
  const h = s as unknown as Hack & { npcSightings: unknown; lastSeenAt: unknown; trackedSightings: unknown };
  const seats: Array<[EntityId, string]> = [[PLAYER, "backyard"], [V, "kitchen"], [S, "bedroom-a"]];
  for (const id of npcs) if (!seats.some(([x]) => x === id)) seats.push([id, "bedroom-c"]);
  h.presence = new Map(seats);
  h.npcSightings = null; h.lastSeenAt = null; h.trackedSightings = null;
  askBags.set(this, { s, V, S });
});

const priv = (s: GameSessionAdapter) => s as unknown as { agendaCharacterOf: (id: string) => unknown; rel: { edge: (a: string, b: string) => { affinity: number } }; noteNpcSighting: (v: string, s: string, room: string, heading: boolean) => void; presence: Map<string, string>; live: { dayNumber?: number } };
const setSheet = (a: Ask, character: unknown, player: number, subject: number): void => {
  const p = priv(a.s);
  p.agendaCharacterOf = () => character;
  p.rel = { edge: (x: string, y: string) => ({ affinity: x === a.V && y === a.S ? subject : player }) };
};
const askNow = (a: Ask): void => { a.result = a.s.whereabouts({ search: true, lookingFor: a.S })!.search!.houseguests.find((e) => e.id === a.S)!; };

Given("the houseguest in the kitchen watched the other walk into the storage room", function (this: BbWorld) { const a = askBags.get(this)!; priv(a.s).noteNpcSighting(a.V, a.S, "storage-room", true); });
Given("the houseguest in the kitchen is candid and fond of everyone", function (this: BbWorld) { setSheet(askBags.get(this)!, CANDID, 0.6, 0.6); });
Given("the houseguest in the kitchen is guarded and cold to the player", function (this: BbWorld) { setSheet(askBags.get(this)!, GUARDED, 0, 0); });
When("the player asks around for the other houseguest", function (this: BbWorld) { askNow(askBags.get(this)!); });
When("the player asks around for the other houseguest on every day of a long season", function (this: BbWorld) {
  const a = askBags.get(this)!; const seen = new Set<string>();
  for (let day = 1; day <= 40; day++) { priv(a.s).live.dayNumber = day; askNow(a); seen.add(a.result!.status); }
  (a as Ask & { seen?: Set<string> }).seen = seen;
});
Then("the answer is told by the houseguest in the kitchen, naming the storage room, as something that may be out of date", function (this: BbWorld) {
  const r = askBags.get(this)!.result!;
  assert.equal(r.status, "told"); assert.equal(r.room, "storage-room"); assert.equal(r.toldBy?.id, askBags.get(this)!.V); assert.match(r.fact, /may be out of date/);
});
Then("the other houseguest is really in the bedroom, so the lead is out of date", function (this: BbWorld) { assert.equal(priv(askBags.get(this)!.s).presence.get(askBags.get(this)!.S), "bedroom-a"); });
Then("nobody here knows where the other houseguest is and no room is named", function (this: BbWorld) { const r = askBags.get(this)!.result!; assert.equal(r.status, "unknown"); assert.equal(r.room, undefined); });
Then("the guarded houseguest sometimes gives no straight answer and names no room", function (this: BbWorld) {
  const a = askBags.get(this)! as Ask & { seen?: Set<string> };
  assert.deepEqual([...a.seen!].sort(), ["told", "unknown"]);
  for (let day = 1; day <= 40; day++) { priv(a.s).live.dayNumber = day; askNow(a); if (a.result!.status === "unknown") { assert.equal(a.result!.room, undefined); assert.match(a.result!.fact, /does not give a straight answer/); return; } }
  assert.fail("never dodged");
});
