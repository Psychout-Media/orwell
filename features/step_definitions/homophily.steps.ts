import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { similarity, pairBondMult, type HomophilyFacets } from "../../src/engine/homophily";
import { HOUSE_LEAN_TUNING } from "../../src/engine/houseLeans";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** Feature 0176 - homophily, part 1 (ORW-561). Roles only. */
type Bag = { cast?: HomophilyFacets[]; ids?: string[]; on?: GameSessionAdapter; off?: GameSessionAdapter; json?: string };
const bag = (w: unknown): Bag => ((w as { hp0176?: Bag }).hp0176 ??= {});
let n = 0;
type H = { house: { npcs: Array<{ id: string; character: HomophilyFacets }> } };
function played(seed: number, flag: boolean): GameSessionAdapter {
  const sb = new GameSessionRegistry().sandboxFor(`hp0176-${n++}`);
  sb.session.setHomophilyEnabled(flag); sb.session.setHouseCultureEnabled(false);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.noteMessage({ messageId: "m1" });
  return sb.session;
}

Given("a seeded played house", function () { const s = played(11, true); bag(this).on = s; bag(this).cast = (s as unknown as H).house.npcs.map((x) => x.character); bag(this).ids = (s as unknown as H).house.npcs.map((x) => x.id); });
Then("every pair's similarity is symmetric and between zero and one", function () {
  const c = bag(this).cast!;
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) { const v = similarity(c[i]!, c[j]!); assert.equal(v, similarity(c[j]!, c[i]!)); assert.ok(v >= 0 && v <= 1); }
});
Then("every pair's bond multiplier is within the house-culture bound", function () {
  const c = bag(this).cast!, F = HOUSE_LEAN_TUNING.MAX_FACTOR;
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) { const m = pairBondMult(c[i]!, c[j]!); assert.ok(m >= 1 / F && m <= F); }
});
Then("a houseguest with no job or hometown on file still gets a finite similarity", function () {
  assert.ok(Number.isFinite(similarity({ age: 30 }, {})));
});
When("the most alike pair and the least alike pair are found", function () {
  const b = bag(this), c = b.cast!; let hi = -1, lo = 2; let like = [0, 1], unlike = [0, 1];
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) { const v = similarity(c[i]!, c[j]!); if (v > hi) { hi = v; like = [i, j]; } if (v < lo) { lo = v; unlike = [i, j]; } }
  (b as Bag & { like?: number[]; unlike?: number[] }).like = like; (b as Bag & { like?: number[]; unlike?: number[] }).unlike = unlike;
});
Then("the alike pair warms faster and stings less than the unlike pair", function () {
  const b = bag(this) as Bag & { like: number[]; unlike: number[] }, ids = b.ids!, s = b.on!;
  const vl = s.socialFoldValence(ids[b.like[0]!]!, ids[b.like[0]!]!, ids[b.like[1]!]!), vu = s.socialFoldValence(ids[b.unlike[0]!]!, ids[b.unlike[0]!]!, ids[b.unlike[1]!]!);
  assert.ok(vl.warm > vu.warm && vl.sore < vu.sore);
});
Given("two played houses with the same seed, one with homophily off", function () { bag(this).on = played(3, true); bag(this).off = played(3, false); });
Then("with homophily off the valence for any pair is exactly one", function () {
  const b = bag(this); const ids = b.ids ?? ["npc:1", "npc:2"];
  assert.deepEqual(b.off!.socialFoldValence(ids[0]!, ids[0]!, ids[1]!), { warm: 1, sore: 1 });
});
Then("no surface carries a similarity or a pair multiplier", async function () {
  const sb = new GameSessionRegistry().sandboxFor(`hp0176-wall-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 21 }); sb.session.noteMessage({ messageId: "m1" });
  const blob = JSON.stringify([await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("getMomentPrompt", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {})]).toLowerCase();
  for (const k of ["homophily", "pairbondmult", "similarity"]) assert.equal(blob.includes(k), false, k);
});
