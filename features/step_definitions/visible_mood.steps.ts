import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";

// ORW-106 watch-list item 1 - the visible mood is never the opposite of the soul's state. Roles only; the engine (no model) decides.
type Soul = { confidence?: number; distress?: number; emotionalState: number; volatility: number; temperamentDrift?: number };
type Voice = { tells?: Array<{ kind: string }> } | null;
type Internals = {
  presence: Map<string, string>;
  soulObj(id: string): Soul | undefined;
  setNpcTellsEnabled(on: boolean): void;
  npcVoice(id: string): Voice;
};
interface MoodState { s: Internals; npc: string; voice: Voice }
const state = new WeakMap<object, MoodState>();
const st = (w: BbWorld): MoodState => state.get(w)!;

function stage(w: BbWorld, present: boolean, soul: Partial<Soul>): void {
  GameSessionAdapter.setTimeOfDayEnabled(null);
  const sess = new GameSessionRegistry().sandboxFor(`vm-${Math.random()}`).session;
  sess.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  const s = sess as unknown as Internals;
  s.setNpcTellsEnabled(true);
  const npc = sess.livingIds().find((i) => i !== PLAYER)!;
  const room = s.presence.get(PLAYER)!;
  s.presence.set(npc, present ? room : room === "kitchen" ? "bedroom-a" : "kitchen");
  Object.assign(s.soulObj(npc)!, soul);
  state.set(w, { s, npc, voice: null });
}
const LOW = { distress: 0.9, confidence: 0.1, emotionalState: 0.1, volatility: 0.8 };
const HIGH = { distress: 0.1, confidence: 0.9, emotionalState: 0.9, volatility: 0.8, temperamentDrift: 0 };

Given("a houseguest in the player's room whose spirits are low and distress is high", function (this: BbWorld) { stage(this, true, LOW); });
Given("a houseguest in the player's room whose spirits are high and distress is low", function (this: BbWorld) { stage(this, true, HIGH); });
Given("a houseguest in another room whose spirits are low and distress is high", function (this: BbWorld) { stage(this, false, LOW); });

When("the narrator is handed that houseguest's voice", function (this: BbWorld) {
  const c = st(this);
  c.voice = c.s.npcVoice(c.npc);
  assert.ok(c.voice, "the houseguest has a voice");
});

Then("the houseguest carries at least one tell", function (this: BbWorld) {
  assert.ok((st(this).voice!.tells ?? []).length > 0);
});

Then("the houseguest carries no tells", function (this: BbWorld) {
  assert.equal("tells" in (st(this).voice as object), false);
});

const kinds = (w: BbWorld): string[] => (st(w).voice!.tells ?? []).map((t) => t.kind);
Then(/^none of the tells is (.+)$/, function (this: BbWorld, list: string) {
  const banned = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(banned.length > 0);
  const got = kinds(this);
  for (const k of got) assert.ok(!banned.includes(k), `tell ${k} is the opposite of the state`);
});
