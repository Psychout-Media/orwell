import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { catchScales, shockOf } from "../../src/engine/moodContagion";
import type { BondReader } from "../../src/engine/bonds";

/** Feature 0185 - drives the pure spread directly. Roles only. */
type Bag = { pairs: Array<[string, string]>; scales: Record<string, number> };
const bag = (w: unknown): Bag => ((w as { mc0185?: Bag }).mc0185 ??= { pairs: [], scales: {} });
const IDS = ["evictee", "ally", "friend", "stranger"];
const reader = (pairs: Array<[string, string]>): BondReader => {
  const key = (a: string, b: string): string => [a, b].sort().join("|");
  const set = new Set(pairs.map(([a, b]) => key(a, b)));
  const tie = (a: string, b: string): number => (set.has(key(a, b)) ? 0.9 : 0);
  return { living: () => IDS, day: () => 1, tie, strength: tie, ties: () => [] } as unknown as BondReader;
};
const spread = (w: unknown, magnitude: number, mood: "bad" | "good", source = "evictee"): void => {
  const b = bag(w);
  b.scales = Object.fromEntries(catchScales({ reader: reader(b.pairs), source, magnitude, mood, candidates: IDS.filter((x) => x !== source) }).map((x) => [x.id, x.scale]));
};

Given("a house where {string} is close to the {string} and {string} is not", function (a: string, e: string, _stranger: string) { bag(this).pairs.push([a, e]); });
Given("a house where {string} is close to the {string} and {string} is close to {string} only", function (a: string, e: string, f: string, a2: string) { bag(this).pairs.push([a, e], [f, a2]); });
When("the evictee is shockingly evicted", function () { spread(this, shockOf({ x: { blindsided: true, intensity: 1 } }), "bad"); });
When("the evictee is evicted with no shock", function () { spread(this, shockOf({ x: { respected: true, intensity: 1 } }), "bad"); });
When("the evictee wins and the win mood spreads", function () { spread(this, 0.35, "good"); });
Then("{string} catches more of the mood than {string}", function (a: string, b: string) { const s = bag(this).scales; assert.ok((s[a] ?? 0) > (s[b] ?? 0)); });
Then("{string} catches some of the mood", function (a: string) { assert.ok((bag(this).scales[a] ?? 0) > 0); });
Then("nobody catches any of the mood", function () { assert.deepEqual(bag(this).scales, {}); });
