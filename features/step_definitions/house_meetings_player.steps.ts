import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * Feature 0156 - house meetings, the PLAYER half and the narrator seam (theme 2 slice 7b, ORW-330): the player calls one in their own words, the narrator hears it only as the speakers'
 * words and only when the player was in the house and awake. The engine half (scenarios 1-3, the NPC call, scenario 7-8) is slice 7a's. Roles only.
 * TEST-ONLY seams: `live.playedGame` (a person is playing) and `resumeNapTicks` (the player asleep) to stage the two presences.
 */
type Bag = { s?: GameSessionAdapter; names?: string[]; accused?: string; other?: string; prompt?: string; saidAccused?: string };
const bag = (w: unknown): Bag => ((w as { meetings0156p?: Bag }).meetings0156p ??= {});
let n = 0;
const s = (w: unknown) => bag(w).s!;

function start(w: unknown): void {
  const sess = new GameSessionRegistry().sandboxFor(`meetp0156-${n++}`).session as GameSessionAdapter;
  sess.setNpcBeliefsEnabled(true);
  sess.createCharacter({ playerName: "The Player", seed: 7 });
  (sess as unknown as { live: { playedGame?: boolean } }).live.playedGame = true; // a person is playing
  const names = sess.getGameState().house.filter((h) => h.id !== PLAYER).map((h) => h.name);
  assert.ok(names.length >= 4, "too few houseguests");
  Object.assign(bag(w), { s: sess, names, accused: names[0], other: names[1] });
}
const first = (full: string): string => full.split(/\s+/)[0]!;
const prompt = (w: unknown): string => s(w).getMomentPrompt({}).systemPrompt;
const callText = (w: unknown): string => `I call a house meeting. ${first(bag(w).accused!)} is going after ${first(bag(w).other!)}.`;

// ---- Scenario 4 (player half) ----
Then("the player can call one by saying so in their own words", function () {
  start(this);
  s(this).resolvePlayerMove({ text: "I go to the kitchen and make a sandwich." });
  assert.equal(s(this).houseMeetingThePlayerHeard(), undefined, "unrelated words called a meeting");
  s(this).resolvePlayerMove({ text: "I won't call a house meeting about it." });
  assert.equal(s(this).houseMeetingThePlayerHeard(), undefined, "a negation called a meeting");
  s(this).resolvePlayerMove({ text: callText(this) });
  const heard = s(this).houseMeetingThePlayerHeard();
  assert.ok(heard, "the player's call held no meeting");
  assert.equal(heard.claim.kind, "going-after");
  assert.equal(heard.accused, bag(this).accused);
});

// ---- Scenario 5: the player hears it as its audience ----
Given("the player is in the house and awake when a meeting is called", function () {
  start(this);
  s(this).resolvePlayerMove({ text: callText(this) });
  bag(this).prompt = prompt(this);
});

Then("the narrator is handed the accusation and the accused's answer as the speakers' words", function () {
  const p = bag(this).prompt!;
  const line = p.split("\n").find((l) => l.includes("HOUSE MEETING"));
  assert.ok(line, "the narrator got no house meeting line");
  assert.ok(line.includes(bag(this).accused!), "the accused is not named");
  assert.ok(line.includes(bag(this).other!), "the claim's other party is not named");
  assert.match(line, /going after/, "the accusation is not voiced");
  assert.match(line, /denies it|admits it|turns it back/, "the accused's answer is missing");
  assert.match(line, /speakers' own words/, "the narrator is not told to voice them as words");
});

Then("is never told whether either is true, why the caller called it, or how any houseguest settled", function () {
  const line = bag(this).prompt!.split("\n").find((l) => l.includes("HOUSE MEETING"))!.split("Voice the accusation")[0]!; // the data half; the instruction half names what NOT to say
  assert.doesNotMatch(line, /isTrue|intent|\bclaim:|\bmeeting:|\bnpc:|trust|believ|settled|convinced|\btrue\b|\bfalse\b/i, "the meeting line carries engine-only content");
  const v = JSON.stringify(s(this).houseMeetingThePlayerHeard());
  assert.doesNotMatch(v, /isTrue|intent|"id"|outcome|belief|trust/i, "the heard view carries engine-only fields");
});

// ---- Scenario 6: asleep or out, it never reaches the narrator ----
Given("a meeting is called while the player is asleep", function () {
  start(this);
  s(this).resumeNapTicks(); // the player is asleep: they hear and see nothing
  const meeting = s(this).holdHouseMeeting({ caller: s(this).livingIds().filter((id) => id !== PLAYER)[1]!, accused: s(this).livingIds().filter((id) => id !== PLAYER)[0]!, claim: { kind: "lying-about", subject: s(this).livingIds().filter((id) => id !== PLAYER)[0]! } });
  assert.ok(meeting, "no meeting was held");
});

Then("the narrator is handed nothing about it", function () {
  s(this).endNapTicks(); // they wake: still nothing, the meeting was held without them
  assert.ok(!prompt(this).includes("HOUSE MEETING"), "a meeting the player slept through reached the narrator");
});
