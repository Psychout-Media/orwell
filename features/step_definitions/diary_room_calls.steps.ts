import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

// Feature 0210 C2 (ORW-668) - called to the Diary Room. Roles only. Module-local state (one scenario at a time).
type Any = Record<string, any>;
let sb: Any, s: Any, gone: string | undefined, wentAway = false;
const WORDS = "SENTINEL_DR_WORDS_bdd";

Given("a played season in a quiet stretch", () => {
  sb = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-drbdd-")))).sandboxFor("u");
  s = sb.session;
  s.createCharacter({ playerName: "P", seed: 5 });
  s.noteMessage({ messageId: "m1" });
  s.phase = "social";
  Object.assign(s.live, { champagneCircle: "done", pending: undefined, ceremony: undefined });
  gone = undefined; wentAway = false;
});
When("production calls a houseguest to the Diary Room", () => {
  const live = s.live as LiveSeasonState;
  for (let d = 1; d <= 6; d++) for (let h = 9; h <= 22; h++) {
    live.dayNumber = d; live.nightDepth = h;
    s.houseLifeStretch(sb.engine.events, s.livingIds().filter((x: string) => x !== PLAYER), (d - 1) * 24 + h, sb.engine.knowledge);
    if (live.diaryCalls?.away && !gone) {
      gone = live.diaryCalls.away.who;
      wentAway = s.notInHouseNow().has(gone);
      live.nightDepth = live.diaryCalls.away.until - (d - 1) * 24 + 1;
      s.houseLifeStretch(sb.engine.events, s.livingIds().filter((x: string) => x !== PLAYER), 999, sb.engine.knowledge);
      return;
    }
  }
});
Then("the call is a public event the room saw", () => {
  const e = sb.engine.events.query({ type: "diary-call" }).find((x: Any) => x.initiator === gone && x.id.startsWith("diary-call:") && !x.id.startsWith("diary-call:back"));
  assert.ok(e, "no call event");
  assert.ok(e.witnessSet.length >= 1 && e.witnessSet.includes(gone));
});
Then("the houseguest is out of every room while they are in the Diary Room", () => assert.equal(wentAway, true));
Then("they come back, and the house records whether they were gone long and how they looked", () => {
  const live = s.live as LiveSeasonState;
  assert.equal(live.diaryCalls!.away, undefined);
  const seen = live.diaryCalls!.seen.find((x) => x.who === gone);
  assert.ok(seen && typeof seen.long === "boolean" && ["lighter", "same", "heavier"].includes(seen.comesBack));
});
Then("the call carries no confessional content and no number", () => {
  for (const e of sb.engine.events.query({ type: "diary-call" })) assert.doesNotMatch(e.content, /\d/);
});

When("the player makes a Diary Room entry", () => {
  const live = s.live as LiveSeasonState;
  live.dayNumber = 2; live.nightDepth = 15;
  sb.commands.diaryRoom({ entry: WORDS });
});
Then("the house sees the player go and nothing of what they said", () => {
  const mine = sb.engine.events.query({ type: "diary-call" }).filter((e: Any) => e.initiator === PLAYER);
  assert.equal(mine.length, 1);
  assert.doesNotMatch(JSON.stringify(mine), /SENTINEL/);
});
Then("no houseguest knows the player's words", () => {
  const npcs = s.livingIds().filter((x: string) => x !== PLAYER);
  assert.doesNotMatch(JSON.stringify(npcs.map((id: string) => sb.engine.knowledge.knownTo(id))), /SENTINEL/);
});
