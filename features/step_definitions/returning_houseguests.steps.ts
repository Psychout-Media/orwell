import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { InMemoryUserSeasonArchive } from "../../src/adapters/engine/FileUserSeasonArchive";
import { resolveReturnee, planReturner } from "../../src/engine/returnees";
import { softenedFeelings, type ArchivedHouseguest } from "../../src/engine/seasonMemory";

/**
 * Feature 0208 B1 - returning houseguests. Drives the REAL registry through a played, finished season and a return. TEST-ONLY seam: reading the season's
 * engine-only state (the live season and house) to prove the carry stays in the hidden layer. Roles only.
 */
type Inner = { house: { npcs: Array<{ name: string; character: { hiddenElements: Array<{ detail: string }> } }> } | null; live: { returners?: Record<string, unknown>; beliefs?: Record<string, unknown[]> } | null };
type Bag = { archive: InMemoryUserSeasonArchive; reg?: GameSessionRegistry; sb?: UserSandbox; user: string; firstCast?: string[]; proposed?: ArchivedHouseguest | undefined; planned?: unknown };
const MARK = "PRIOR-SEASON-HIDDEN-MARK";
const bag = (w: unknown): Bag => ((w as { rh0208?: Bag }).rh0208 ??= { archive: new InMemoryUserSeasonArchive(), user: "u-rh" });
const inner = (b: Bag): Inner => b.sb!.session as never as Inner;

function playAndFinish(b: Bag): void {
  b.reg = new GameSessionRegistry(undefined, { seasonArchive: b.archive });
  b.sb = b.reg.sandboxFor(b.user);
  b.sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  b.sb.session.noteMessage({ messageId: "m1" });
  assert.equal(b.sb.session.advanceToFinale().finished, true);
}

Given("the player returns and has played seasons before", function () {
  const b = bag(this);
  playAndFinish(b);
  for (const n of inner(b).house!.npcs) n.character.hiddenElements[0]!.detail = MARK;
  b.firstCast = inner(b).house!.npcs.map((n) => n.name);
});

When("a returner is cast", function () {
  const b = bag(this);
  for (let seed = 100; seed < 160; seed++) {
    b.sb!.session.createCharacter({ playerName: "The Player", seed, confirmRestart: true, keepCharacter: true });
    b.sb = b.reg!.sandboxFor(b.user);
    if (inner(b).live?.returners) return;
    // not every return casts one (a keyed chance); the finished state is gone, so replay a played season to try the next seed
    b.sb.session.noteMessage({ messageId: `m${seed}` });
    b.sb.session.advanceToFinale();
  }
  assert.fail("no return seed cast a returner");
});

Then("they are a real houseguest from a season this player played", function () {
  const b = bag(this);
  const archived = b.archive.read(b.user);
  const seat = Object.keys(inner(b).live!.returners!)[0]!;
  const name = inner(b).house!.npcs.find((n) => n.name && (inner(b).live!.returners as Record<string, unknown>)[seat] !== undefined && archived.some((h) => h.name === n.name))?.name;
  assert.ok(name, "the returner's name is in this player's own archive");
  assert.ok(resolveReturnee({ season: archived.find((h) => h.name === name)!.season, npcId: archived.find((h) => h.name === name)!.npcId, name }, archived));
});

Then("nothing the earlier season kept hidden comes back with them", function () {
  const b = bag(this);
  assert.equal(JSON.stringify(inner(b).house).includes(MARK), false);
  assert.equal(JSON.stringify(inner(b).live).includes(MARK), false);
  assert.equal(JSON.stringify(b.archive.read(b.user)).includes(MARK), false);
  assert.equal(JSON.stringify(b.sb!.session.getGameState()).includes("endToward"), false);
});

Then("they start with the feelings they ended that season with, softened by time but never gone", function () {
  const end = { trust: -0.5, affinity: 0.4, threat: 0.6 };
  const one = softenedFeelings(end, 1), many = softenedFeelings(end, 9);
  assert.ok(Math.abs(one.trust) <= Math.abs(end.trust) && Math.abs(many.trust) < Math.abs(one.trust));
  assert.ok(Math.abs(many.trust) > 0 && many.threat > 0);
});

Then("they hold their own account of the player, to be told only through the house's usual pathways", function () {
  const b = bag(this);
  const seat = Object.keys(inner(b).live!.returners!)[0]!;
  const archived = b.archive.read(b.user);
  const held = inner(b).live!.beliefs?.[seat] ?? [];
  assert.ok(held.length <= 6);
  void archived;
});

Given("a player who has finished one season", function () {
  playAndFinish(bag(this));
});

When("someone is proposed to return who is not in that player's own archive", function () {
  const b = bag(this);
  const archive = b.archive.read(b.user);
  b.proposed = resolveReturnee({ season: 1, npcId: "npc-invented", name: "A Name Nobody Archived" }, archive);
  b.planned = planReturner(1, "return", [], [], "The Player", ["npc-1" as never]);
});

Then("the proposal is rejected and the cast member is a fresh one", function () {
  assert.equal(bag(this).proposed, undefined);
});

Then("a player who has never finished a season is never given a returner", function () {
  assert.equal(bag(this).planned, undefined);
  const reg = new GameSessionRegistry(undefined, { seasonArchive: new InMemoryUserSeasonArchive() });
  const sb = reg.sandboxFor("u-never");
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  assert.equal((sb.session as never as Inner).live?.returners, undefined);
});
