import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { MOOD_CAUSES, causeLine, isBadNight, isCloseFriend, mayShareEventCause, strongestCause, type MoodCauseEntry, type MoodCauseSource } from "../../src/engine/moodCauses";

/** Feature 0194 - drives the pure cause rules directly. Roles only. Every step carries the "mood causes:" prefix. */
type Bag = { log: MoodCauseEntry[]; week: number };
const bag = (w: unknown): Bag => ((w as { mc0194?: Bag }).mc0194 ??= { log: [], week: 1 });

Given("mood causes: a houseguest with the causes {string} and {string} this week", function (a: string, b: string) {
  const w = bag(this);
  for (const s of [a, b]) w.log.push({ holder: "holder", source: s as MoodCauseSource, line: causeLine(s as MoodCauseSource), week: w.week });
});
Given("mood causes: a houseguest with the causes {string} this week", function (a: string) { const w = bag(this); w.log.push({ holder: "holder", source: a as MoodCauseSource, line: causeLine(a as MoodCauseSource), week: w.week }); });
When("mood causes: a new week begins", function () { bag(this).week += 1; });
Then("mood causes: the cause they would give is {string}", function (s: string) { const w = bag(this); assert.equal(strongestCause(w.log, "holder", w.week)?.source, s); });
Then("mood causes: the houseguest has no cause to give", function () { const w = bag(this); assert.equal(strongestCause(w.log, "holder", w.week), undefined); });
Given("mood causes: a listener of middling trust and a candid houseguest", function () { (this as { mc0194b?: [number, number] }).mc0194b = [0.5, 0.45]; });
Then("mood causes: a {string} cause may be said", function (s: string) { const [a, c] = (this as unknown as { mc0194b: [number, number] }).mc0194b; assert.equal(mayShareEventCause(s as MoodCauseSource, a, c), true); });
Then("mood causes: a {string} cause may not be said", function (s: string) { const [a, c] = (this as unknown as { mc0194b: [number, number] }).mc0194b; assert.equal(mayShareEventCause(s as MoodCauseSource, a, c), false); });
Then("mood causes: a late night of two in the morning is a bad night", function () { assert.equal(isBadNight(MOOD_CAUSES.badSleepDeficit), true); });
Then("mood causes: an early night is not", function () { assert.equal(isBadNight(0.05), false); });
Then("mood causes: a bond of high trust and affinity is a close friend", function () { assert.equal(isCloseFriend(0.8, 0.8), true); });
Then("mood causes: a cool bond is not", function () { assert.equal(isCloseFriend(0.2, 0.2), false); });
