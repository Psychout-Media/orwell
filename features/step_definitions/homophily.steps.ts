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

// --- Part 2: territory ---------------------------------------------------------------------------------------------------------------
import { TERRITORY, topRoomOf, territoryNudge, type Tenure } from "../../src/engine/territory";
import type { BedsState } from "../../src/engine/beds";
type Hours = { session: GameSessionAdapter; engine: { events: unknown } };
type Lived = { live: { tenure?: Tenure; beds?: BedsState; nightDepth?: number }; houseLifeStretch(e: unknown, a: readonly string[], i: number): unknown[]; livingIds(): string[]; territoryBondNudge(a: string, b: string): number };
function lived(flag = true): Hours {
  const sb = new GameSessionRegistry().sandboxFor(`hp0176-t-${n++}`) as unknown as Hours;
  sb.session.setTerritoryEnabled(flag); sb.session.setHouseCultureEnabled(false);
  sb.session.createCharacter({ playerName: "The Player", seed: 7 }); sb.session.noteMessage({ messageId: "m1" });
  const s = sb.session as unknown as Lived, awake = s.livingIds().filter((i) => i !== "player");
  for (let h = 0; h < 30; h++) { s.live.nightDepth = (s.live.nightDepth ?? 8) + 1; s.houseLifeStretch(sb.engine.events, awake, h); }
  return sb;
}
Given("a seeded played house that has lived some hours", function () { (bag(this) as Bag & { t?: Hours }).t = lived(true); });
Then("the tenure only ever grows and a houseguest's top room is never the Diary Room or the HOH room", function () {
  const t = (bag(this) as Bag & { t: Hours }).t, s = t.session as unknown as Lived;
  const before = JSON.parse(JSON.stringify(s.live.tenure ?? {})) as Tenure;
  assert.ok(Object.keys(before).length > 0);
  const awake = s.livingIds().filter((i) => i !== "player");
  for (let h = 30; h < 40; h++) { s.live.nightDepth = (s.live.nightDepth ?? 8) + 1; s.houseLifeStretch(t.engine.events, awake, h); }
  for (const [who, rooms] of Object.entries(before)) for (const [r, v] of Object.entries(rooms)) assert.ok((s.live.tenure![who]![r as keyof Tenure[string]] ?? 0) >= (v as number));
  for (const who of Object.keys(s.live.tenure!)) { const top = topRoomOf(s.live.tenure, who); assert.ok(top !== "diary-room" && top !== "hoh-room"); }
});
Then("a pair who share a bedroom get a nudge no larger than the cap", function () {
  const s = (bag(this) as Bag & { t: Hours }).t.session as unknown as Lived, owners = Object.entries(s.live.beds!.owner);
  const pair = owners.flatMap(([a, ba]) => owners.filter(([b]) => a < b).map(([b, bb]) => [a, b, ba.split("#")[0] === bb.split("#")[0]] as const)).find((p) => p[2])!;
  const v = s.territoryBondNudge(pair[0], pair[1]);
  assert.ok(v > 0 && v <= TERRITORY.NUDGE_CAP);
  assert.equal(v, territoryNudge(s.live.tenure, s.live.beds, pair[0], pair[1]));
});
Then("with territory off the nudge is exactly zero", function () {
  const s = lived(false).session as unknown as Lived, owners = Object.keys(s.live.beds!.owner);
  assert.equal(s.territoryBondNudge(owners[0]!, owners[1]!), 0);
  assert.equal(s.live.tenure, undefined);
});
Then("no surface carries a tenure, a territory or a regulars field", async function () {
  const sb = new GameSessionRegistry().sandboxFor(`hp0176-twall-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 21 }); sb.session.noteMessage({ messageId: "m1" });
  const blob = JSON.stringify([await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("getMomentPrompt", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {})]).toLowerCase();
  for (const k of ["tenure", "territory", "regulars"]) assert.equal(blob.includes(k), false, k);
});
