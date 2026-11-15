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
  const e = entry(this, bag(this).speaker);
  assert.equal(e.status, "awake"); assert.equal(e.room, "kitchen");
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
