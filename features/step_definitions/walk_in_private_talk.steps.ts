import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { walkInLine, type WalkInReaction } from "../../src/engine/walkIn";
import { resolvePending } from "../support/answerPending";

// Feature 0049 (ORW-473) - walking in on a private talk: each houseguest's reaction comes from their own sheet. Roles only.
type Ev = { id: string; ts: number; type: string; initiator: string; witnessSet: string[]; hidden: boolean; content: string; houseLife?: Record<string, unknown> };
type Hack = { presence: Map<EntityId, string>; awakeNow: () => Set<EntityId> | null; live: { playedGame?: boolean }; agendaCharacterOf: (id: EntityId) => unknown; rel: { edge: (a: EntityId, b: EntityId) => { affinity: number } } };
interface Bag { s: GameSessionAdapter; A: EntityId; B: EntityId; walked?: { reactions: Array<{ id: string; line: string }>; with: Array<{ id: string }> } }
const bags = new WeakMap<object, Bag>();
let n = 0;
const bag = (w: object): Bag => bags.get(w)!;

Given("a played game where two houseguests are in the kitchen in a private strategy talk and the player is in the backyard", function (this: BbWorld) {
  const s = new GameSessionRegistry().sandboxFor(`walkin-bdd-${n++}`).session;
  s.createCharacter({ playerName: "The Player", seed: 5 });
  for (let i = 0; i < 400 && (s.whereabouts()?.houseEvent || s.getGameState().phase === "premiere"); i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
  const npcs = s.livingIds().filter((id) => id !== PLAYER);
  const [A, B] = [npcs[0]!, npcs[1]!];
  const h = s as unknown as Hack;
  const seats: Array<[EntityId, string]> = [[PLAYER, "backyard"], [A, "kitchen"], [B, "kitchen"]];
  for (const id of npcs) if (!seats.some(([x]) => x === id)) seats.push([id, "bedroom-c"]);
  h.presence = new Map(seats);
  h.awakeNow = () => new Set<EntityId>([PLAYER, A, B]);
  h.live.playedGame = true;
  const orig = (s as unknown as { record: { events: () => Ev[]; hidden: unknown } }).record;
  const talk: Ev = { id: "offscreen:strategy:bdd", ts: 1, type: "strategy", initiator: A, witnessSet: [A, B], hidden: true, content: "secret", houseLife: { action: "pitch", place: "kitchen", manner: "low", truthful: true, stretch: 1, at: s.inGameAbsHour() } };
  s.setRecordProviders({ events: () => [...orig.events(), talk] as never, hidden: orig.hidden as never });
  bags.set(this, { s, A, B });
});

const SHEET: Record<string, { arch: { archetype: string; strategyStyle: string }; ap: number }> = {
  "pulls the player in": { arch: { archetype: "hothead", strategyStyle: "emotional" }, ap: 0.9 },       // very candid, warm to the player
  "carries on guarded": { arch: { archetype: "loyalist", strategyStyle: "loyal" }, ap: 0.5 },          // candid, some trust
  "moves the talk": { arch: { archetype: "villain", strategyStyle: "strategic" }, ap: 0.3 },           // secretive, wary of the player
  "goes quiet": { arch: { archetype: "floater", strategyStyle: "social" }, ap: 0.05 },                 // middling candor, cold to the player
};
Given(/^both houseguests have the sheet of one who (pulls the player in|carries on guarded|moves the talk|goes quiet)$/, function (this: BbWorld, kind: string) {
  const b = bag(this); const h = b.s as unknown as Hack; const sh = SHEET[kind]!;
  h.agendaCharacterOf = () => sh.arch;
  h.rel = { edge: (_a: EntityId, o: EntityId) => ({ affinity: o === PLAYER ? sh.ap : 0.5 }) };
});
When("the player walks into the kitchen", function (this: BbWorld) { const b = bag(this); b.s.movePlayer("kitchen"); b.walked = b.s.getGameState().walkedIn as Bag["walked"]; });
Then(/^each of them (pulls the player in|carries on guarded|moves the talk|goes quiet)$/, function (this: BbWorld, kind: string) {
  const w = bag(this).walked!;
  assert.ok(w, "the player's walking in was noticed");
  const want = walkInLine(kind.replace(/ /g, "-") as WalkInReaction); // the view carries the manner (line) only
  for (const r of w.reactions) assert.equal(r.line, want, r.id);
});
Then("the narrator is told the manner of each reaction and nothing about what the talk was", function (this: BbWorld) {
  const w = bag(this).walked!;
  for (const r of w.reactions) assert.ok(r.line.length > 10);
  assert.doesNotMatch(JSON.stringify(w), /secret|pitch|strategy/i);
});
Then("both of them remember that the player walked in", function (this: BbWorld) {
  const b = bag(this);
  const npcs = (b.s as unknown as { house: { npcs: { id: string; soul: { memory: string[] } }[] } }).house.npcs;
  for (const id of [b.A, b.B]) assert.ok(npcs.find((x) => x.id === id)!.soul.memory.some((m) => m.includes("walked in on my private talk")), id);
});
