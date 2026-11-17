import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { deriveHouseGraph, type GraphTie, type HouseGraph } from "../../src/engine/houseGraph";

/** Feature 0177 - drives the pure derive function directly. Roles only. */
type Bag = { members: Set<string>; ties: GraphTie[]; graph?: HouseGraph; a?: HouseGraph; b?: HouseGraph };
const bag = (w: unknown): Bag => ((w as { hg0177?: Bag }).hg0177 ??= { members: new Set(), ties: [] });
const ids = (s: string): string[] => s.split(",").map((x) => x.trim());
const mutual = (b: Bag, x: string, y: string): void => { b.members.add(x); b.members.add(y); b.ties.push({ from: x, to: y, strength: 0.9 }, { from: y, to: x, strength: 0.9 }); };

Given("a house graph with a close group of {string}", function (g: string) {
  const m = ids(g); const b = bag(this);
  for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) mutual(b, m[i]!, m[j]!);
});
Given("a house graph where {string} is close to each of {string}", function (x: string, others: string) {
  const b = bag(this); for (const o of ids(others)) mutual(b, x, o);
});
Given("a house graph member {string} with no ties", function (x: string) { bag(this).members.add(x); });
Given("a house graph where {string} leans hard on each of {string} but they do not lean back", function (x: string, others: string) {
  const b = bag(this); b.members.add(x);
  for (const o of ids(others)) { b.members.add(o); b.ties.push({ from: x, to: o, strength: 1 }); }
});
Given("a house graph with no members", function () { bag(this); });

When("the house graph is derived", function () { const b = bag(this); b.graph = deriveHouseGraph({ members: [...b.members], ties: b.ties }); });
When("the house graph is derived twice, once with the input order reversed", function () {
  const b = bag(this);
  b.a = deriveHouseGraph({ members: [...b.members], ties: b.ties });
  b.b = deriveHouseGraph({ members: [...b.members].reverse(), ties: [...b.ties].reverse() });
});

const g = (w: unknown): HouseGraph => bag(w).graph!;
Then("the house graph reads {string} as a broker", function (x: string) { assert.ok(g(this).brokers.includes(x)); });
Then("the house graph reads {string} as not a broker", function (x: string) { assert.ok(!g(this).brokers.includes(x)); });
Then("the house graph reads {string} as a loner", function (x: string) { assert.ok(g(this).loners.includes(x)); });
Then("the house graph reads {string} as not a loner", function (x: string) { assert.ok(!g(this).loners.includes(x)); });
Then("the house graph reads {string} as a hub", function (x: string) { assert.ok(g(this).hubs.includes(x)); });
Then("the house graph finds no cliques", function () { assert.equal(g(this).cliques.length, 0); });
Then("the two house graph reads are identical", function () { const b = bag(this); assert.equal(JSON.stringify(b.a), JSON.stringify(b.b)); });
Then("the house graph output has only engine-side groupings and no numbers", function () {
  const out = deriveHouseGraph({ members: ["m1", "m2", "m3"], ties: [] });
  assert.deepEqual(Object.keys(out).sort(), ["brokers", "cliques", "hubs", "loners"]);
  assert.ok(!JSON.stringify(out, (_k, v) => (typeof v === "number" ? "NUM" : v)).includes("NUM"));
});
Then("no player, admin or tool surface imports the house graph", function () {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
  for (const dir of ["src/surfaces", "src/adapters/mcp"]) for (const f of walk(dir)) assert.ok(!/houseGraph/.test(readFileSync(f, "utf8")), f);
});
Then("a house graph with unknown ids, self-ties and NaN strengths still derives", function () {
  const out = deriveHouseGraph({ members: ["m1", "m2"], ties: [{ from: "m1", to: "zz", strength: 1 }, { from: "m1", to: "m1", strength: 1 }, { from: "m1", to: "m2", strength: NaN }] });
  assert.equal(out.cliques.length, 0);
});
