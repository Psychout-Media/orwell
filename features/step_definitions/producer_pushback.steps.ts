import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { AssuranceLedger } from "../../src/engine/assurances";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

// Feature 0210 C3 (ORW-669) - the producer who pushes back. Roles only. Module-local state (one scenario at a time).
type Any = Record<string, any>;
let sb: Any, s: Any, ally: string, before: string;
const WORDS = "SENTINEL_DR_WORDS_pb_bdd";

function start(): void {
  sb = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-pbbdd-")))).sandboxFor("u");
  s = sb.session;
  s.createCharacter({ playerName: "P", seed: 5 });
  s.noteMessage({ messageId: "m1" });
  s.phase = "social";
  Object.assign(s.live, { champagneCircle: "done", pending: undefined, ceremony: undefined, dayNumber: 2, nightDepth: 15 });
  ally = s.livingIds().find((x: string) => x !== PLAYER);
  const l = new AssuranceLedger();
  l.add({ from: PLAYER, to: ally, kind: "safe", week: s.live.week, sincerity: 1, source: "player" });
  s.live.assurances = l.toJSON();
}
Given("a played season where the player told a houseguest they were safe and then nominated them", () => {
  start();
  const live = s.live as LiveSeasonState;
  live.hoh = PLAYER;
  live.nominees = [ally, s.livingIds().find((x: string) => x !== PLAYER && x !== ally)];
});
Given("a played season where the player kept their word to a houseguest", () => start());
When("the player is in the Diary Room", () => {
  const npcs = s.livingIds().filter((x: string) => x !== PLAYER);
  before = JSON.stringify(npcs.map((id: string) => sb.engine.knowledge.knownTo(id)));
  sb.commands.diaryRoom({ entry: WORDS });
});
Then("the producer is handed both facts, in kind, to ask about", () => {
  const v = s.getGameState().producerPushback;
  assert.equal(v.facts.length, 1);
  assert.match(v.facts[0].said, /safe/);
  assert.match(v.facts[0].did, /block/);
});
Then("nothing the player typed in the Diary Room is kept or reaches any houseguest", () => {
  assert.doesNotMatch(JSON.stringify(s.live), /SENTINEL/);
  assert.doesNotMatch(JSON.stringify(s.getGameState().producerPushback), /SENTINEL/);
  const npcs = s.livingIds().filter((x: string) => x !== PLAYER);
  assert.equal(JSON.stringify(npcs.map((id: string) => sb.engine.knowledge.knownTo(id))), before);
});
Then("the producer has nothing to raise", () => assert.equal(s.getGameState().producerPushback, undefined));
