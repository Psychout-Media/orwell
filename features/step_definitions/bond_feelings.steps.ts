import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { BOND_FEELINGS, guiltScale, hesitation } from "../../src/engine/bondFeelings";

/** Feature 0181 - drives the pure rules directly. Roles only. */
type View = { warmth: number; resentment: number; strain: number };
type Bag = { weak: View; strong: View };
const bag = (w: unknown): Bag => ((w as { bf0181?: Bag }).bf0181 ??= { weak: { warmth: 0.3, resentment: 0, strain: 0 }, strong: { warmth: 0.9, resentment: 0, strain: 0 } });

Given("an NPC whose plan says to cut someone they truly like", function () { bag(this); });
Given("an NPC whose plan says to cut someone they hold a grudge against", function () { const b = bag(this); b.weak = { warmth: 0.8, resentment: 1, strain: 0 }; b.strong = { warmth: 0, resentment: 0, strain: 0 }; });
Given("an NPC whose plan says to cut their closest friend", function () { const b = bag(this); b.strong = { warmth: 1, resentment: 0, strain: 0 }; });
Then("they hesitate, more as the feeling is stronger", function () { const b = bag(this); assert.ok(hesitation(b.weak) > 0); assert.ok(hesitation(b.strong) > hesitation(b.weak)); });
Then("they are shaken after, more as the feeling is stronger", function () { const b = bag(this); assert.ok(guiltScale(b.weak) > 0); assert.ok(guiltScale(b.strong) > guiltScale(b.weak)); });
Then("they do not hesitate", function () { const b = bag(this); assert.equal(hesitation(b.weak), 0); assert.equal(hesitation(b.strong), 0); });
Then("they are not shaken after", function () { const b = bag(this); assert.equal(guiltScale(b.weak), 0); assert.equal(guiltScale(b.strong), 0); });
Then("their hesitation stays below one", function () { const b = bag(this); assert.ok(hesitation(b.strong) < 1); assert.ok(BOND_FEELINGS.maxHesitation < 1); });
