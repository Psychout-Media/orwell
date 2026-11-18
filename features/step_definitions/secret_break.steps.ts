import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import { holdersNeeded, SECRET_BREAK } from "../../src/engine/secretBreak";

// Feature 0204 (ORW-647). Roles only. Drives a real played sandbox; the facts are seeded into the knowledge layer the engine already keeps.
type Soul = { volatility: number; emotionalState: number };
type S = {
  secretBreakTick(k: unknown): void; setSecretBreaksEnabled(on: boolean): void; livingIds(): string[];
  live: { dayNumber?: number; nominees?: string[]; secretBreaks?: string[] };
  rel: { peek(a: string, b: string): { trust: number } };
  house: { npcs: Array<{ id: string; soul: Soul }> };
  getGameState(): unknown; getMomentPrompt(o: object): unknown;
};
type Ctx = { s: S; sb: ReturnType<ReturnType<typeof composeRuntime>["registry"]["sandboxFor"]>; npcs: string[]; subject: string; holders: string[]; keptOut?: string; trustBefore?: number; said: string[] };
let c: Ctx | undefined;
let n = 0;
async function played(on = true): Promise<Ctx> {
  const reg = composeRuntime({ clock: new FakeClock(), seed: 5 }).registry;
  const user = `secret-break-bdd-${n++}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed: 5, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setSecretBreaksEnabled(on);
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  return { s, sb, npcs, subject: npcs[0]!, holders: [], said: [] };
}
const hold = (x: Ctx, holders: string[], subject: string, factId: string, content: string): void => {
  for (const h of holders) x.sb.engine.knowledge.seedBelief(h, { content, factId, subject, confidence: 0.8, hops: 1, distortion: 0 }, "told-by:x");
};
const soulOf = (x: Ctx, id: string): Soul => x.s.house.npcs.find((p) => p.id === id)!.soul;
const breaks = (x: Ctx) => x.sb.engine.events.queryAll().filter((e) => e.type === "secret-break");

Given("a secret break: a played house where most of the others hold a fact about one houseguest", async function () {
  c = await played();
  const others = c.npcs.slice(1);
  Object.assign(soulOf(c, c.subject), { volatility: 0, emotionalState: 1 });
  c.holders = others.slice(0, holdersNeeded(others.length));
  const held = c.holders;
  c.keptOut = others.find((o) => !held.includes(o));
  c.trustBefore = c.keptOut ? c.s.rel.peek(c.keptOut, c.subject).trust : undefined;
  hold(c, c.holders, c.subject, "fact:bdd", "the subject hid a past");
});
Given("a secret break: a volatile subject on the block whose fact is closing in", async function () {
  c = await played();
  Object.assign(soulOf(c, c.subject), { volatility: 1, emotionalState: 0 });
  c.s.live.nominees = [c.subject, c.npcs[1]!];
  hold(c, c.npcs.slice(1, 1 + Math.ceil((c.npcs.length - 1) * SECRET_BREAK.closingShare)), c.subject, "fact:hot", "the subject's own thing");
});
Given("a secret break: a calm subject whose fact is closing in", async function () {
  c = await played();
  Object.assign(soulOf(c, c.subject), { volatility: 0, emotionalState: 1 });
  hold(c, c.npcs.slice(1, 1 + Math.ceil((c.npcs.length - 1) * SECRET_BREAK.closingShare)), c.subject, "fact:cool", "the subject's own thing");
});
Given("a secret break: a played house where the others hold a fact about the player and one unspoken fact about someone else", async function () {
  c = await played();
  hold(c, c.npcs, PLAYER, "fact:pl", "the player kept a thing quiet");
  hold(c, c.npcs.slice(0, 1), c.npcs[1]!, "fact:other", "SENTINEL_UNSPOKEN_SECRET");
});
Given("a secret break: a played house with the feature switched off", async function () {
  c = await played(false);
  hold(c, c.npcs.slice(1), c.subject, "fact:off", "x");
  for (let i = 0; i < 20; i++) { c.s.live.dayNumber = (c.s.live.dayNumber ?? 1) + 1; c.s.secretBreakTick(c.sb.engine.knowledge); }
});
When("a secret break: the nights pass", function () {
  const x = c!;
  for (let i = 0; i < 60; i++) { x.s.live.dayNumber = (x.s.live.dayNumber ?? 1) + 1; x.s.secretBreakTick(x.sb.engine.knowledge); }
  x.said = breaks(x).map((e) => e.content);
});
Then("a secret break: it broke once, as a house event the whole room witnessed, and everyone present holds it", function () {
  const x = c!;
  assert.equal(breaks(x).length, 1);
  const ev = breaks(x)[0]!;
  assert.equal(ev.hidden, false);
  assert.ok(ev.witnessSet.includes(PLAYER));
  for (const o of x.npcs.slice(1)) assert.ok(x.sb.engine.knowledge.knownTo(o).some((f) => f.factId === "fact:bdd"));
});
Then("a secret break: it never breaks twice", function () {
  const x = c!;
  for (let i = 0; i < 30; i++) { x.s.live.dayNumber = (x.s.live.dayNumber ?? 1) + 1; x.s.secretBreakTick(x.sb.engine.knowledge); }
  assert.equal(breaks(x).length, 1);
});
Then("a secret break: the subject blew it up themselves", function () {
  assert.equal(c!.said.length, 1);
  assert.match(c!.said[0]!, /blew up their own secret/);
});
Then("a secret break: nothing broke", function () { assert.equal(c!.said.length, 0); });
Then("a secret break: the room thinks less of the subject by a small bounded amount, and a houseguest kept out holds a grudge", function () {
  const x = c!;
  assert.ok(x.keptOut, "a houseguest was kept out");
  const now = x.s.rel.peek(x.keptOut!, x.subject).trust;
  assert.ok(now < x.trustBefore!);
  assert.ok(x.trustBefore! - now < 0.2);
  assert.ok(JSON.stringify((x.s as unknown as { live: { grudges?: unknown } }).live.grudges ?? {}).includes(x.keptOut!));
});
Then("a secret break: the room's line is about the player only, the unspoken fact appears nowhere, and the player was not made a holder", function () {
  const x = c!;
  assert.ok(x.said.length >= 1);
  assert.ok(x.said.every((l) => !l.includes("blew up")));
  const surfaces = JSON.stringify(x.s.getGameState()) + JSON.stringify(x.s.getMomentPrompt({})) + x.said.join(" ");
  assert.ok(!surfaces.includes("SENTINEL_UNSPOKEN_SECRET"));
  assert.ok(!x.sb.engine.knowledge.knownTo(PLAYER).some((f) => f.pathway === "public"));
});
Then("a secret break: nothing breaks and nothing is saved", function () {
  assert.equal(breaks(c!).length, 0);
  assert.equal(c!.s.live.secretBreaks, undefined);
});
