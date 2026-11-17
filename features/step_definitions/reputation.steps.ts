import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { REPUTATION, composeWithCredibility, standing } from "../../src/engine/reputation";
import { CREDIBILITY } from "../../src/engine/credibilityConstants";

/** Feature 0184 - drives the pure standing directly. Roles only. */
type W = { heard0184?: Array<{ week: number; confidence: number }>; before0184?: number };
const w = (x: unknown) => x as W;
Given("a houseguest the observer has heard lying and turning on people", function () { w(this).heard0184 = [{ week: 1, confidence: 0.8 }, { week: 2, confidence: 0.8 }]; });
Then("the observer holds that houseguest at a lower standing than one with no record", function () { assert.ok(standing(w(this).heard0184!, 0, 2) < standing([], 0, 2)); });
Then("another houseguest who heard nothing holds them at full standing", function () { assert.equal(standing([], 0, 2), 1); });
When("the houseguest keeps promises to the observer", function () { w(this).before0184 = standing(w(this).heard0184!, 0, 2); });
Then("the standing is higher than before", function () { assert.ok(standing(w(this).heard0184!, 2, 2) > w(this).before0184!); });
Then("the standing is still below full", function () { assert.ok(standing(w(this).heard0184!, 1000, 2) < 1); });
Then("the observer's credit for the houseguest's word is the bounded product of credibility and standing", function () {
  const s = standing(w(this).heard0184!, 0, 2);
  assert.equal(composeWithCredibility(0.6, s, CREDIBILITY.floor), Math.max(CREDIBILITY.floor, 0.6 * s));
  assert.ok(composeWithCredibility(CREDIBILITY.floor, REPUTATION.floor, CREDIBILITY.floor) > 0);
});
