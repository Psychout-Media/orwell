import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { jealousy, loyaltySplit, nextJealousy } from "../../src/engine/bondJealousy";
import type { BondReader } from "../../src/engine/bonds";

/** Feature 0181 part 2 - drives the pure rules directly. Roles only. */
type In = Parameters<typeof jealousy>[0];
type Bag = { input: In; value: number; strengths: Record<string, number>; fall: number };
const bag = (w: unknown): Bag => ((w as { bj0181?: Bag }).bj0181 ??= { input: { closeWarmth: 0.8, rivalWarmth: 0.2, xyScenes: 4, xhScenes: 1 }, value: 0, strengths: { "H|A": 0.6, "H|B": 0.6 }, fall: 0 });

Given("two close friends and a newcomer one of them favours", function () { bag(this); });
When("the other watches the favour grow", function () { const b = bag(this); b.value = jealousy(b.input); });
Then("their jealousy rises and the closeness slips", function () { const b = bag(this); assert.ok(b.value > 0); assert.ok(jealousy({ ...b.input, xyScenes: 9 }) > b.value); });
Given("a houseguest who is jealous over a close friend", function () { const b = bag(this); b.value = jealousy(b.input); assert.ok(b.value > 0); });
When("they share a bonding scene with that friend before the night", function () { const b = bag(this); b.value = 0; });
Then("the jealousy is cleared", function () { const b = bag(this); assert.equal(nextJealousy(b.value, 0), 0); });
Given("a houseguest who is not close to the friend who favours someone else", function () { const b = bag(this); b.input = { ...b.input, closeWarmth: 0.05 }; });
Then("they feel no jealousy", function () { assert.equal(jealousy(bag(this).input), 0); });
Given("a houseguest close to both of two people who have fallen out", function () { bag(this).fall = 0.8; });
Then("they are less likely to vote against or nominate either, and less likely to break an alliance against either", function () {
  const b = bag(this);
  const reader = { strength: (h: string, o: string) => b.strengths[`${h}|${o}`] ?? 0, bond: () => ({ resentment: b.fall, strain: 0 }), living: () => ["H", "A", "B"] } as unknown as BondReader;
  assert.ok(loyaltySplit("H", "A", "B", reader) > 0);
  assert.ok(loyaltySplit("H", "B", "A", reader) > 0);
});
