import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { easeGrudge, freshness, noteGrudge, type GrudgeBook } from "../../src/engine/grudges";

/** Feature 0182 - drives the pure grudge book directly. Roles only. */
const book = (w: unknown): GrudgeBook => ((w as { gb0182?: GrudgeBook }).gb0182 ??= {});
const row = (w: unknown) => book(w)["holder|ally"]!;

Given("a houseguest who was cut by an ally in week 1", function () { noteGrudge(book(this), "holder", "ally", "cut-by-ally", 0.5, 1, 1, "a"); });
Then("the houseguest holds a grudge against that ally", function () { assert.ok(row(this)); });
Then("the grudge is sharper in week 2 than in week 40", function () { assert.ok(freshness(row(this), 2) > freshness(row(this), 40)); });
Then("the grudge in week 40 is still above zero", function () { assert.ok(freshness(row(this), 40) > 0); });
When("the wrong is eased again and again", function () {
  (this as { before0182?: number }).before0182 = freshness(row(this), 1);
  for (let i = 0; i < 50; i++) easeGrudge(row(this), 0.2);
});
Then("the grudge is fainter than before", function () { assert.ok(freshness(row(this), 1) < (this as { before0182?: number }).before0182!); });
Then("the grudge is still above zero", function () { assert.ok(freshness(row(this), 1) > 0); });
When("the same ally lies to them later and harder", function () { noteGrudge(book(this), "holder", "ally", "lied-to", 0.9, 3, 1, "b"); });
Then("the grudge remembers the lie", function () { assert.equal(row(this).kind, "lied-to"); });
Then("the strongest severity held is kept", function () { noteGrudge(book(this), "holder", "ally", "lied-to", 0.2, 4, 1, "c"); assert.equal(row(this).severity, 0.9); assert.equal(row(this).peak, 0.9); });
