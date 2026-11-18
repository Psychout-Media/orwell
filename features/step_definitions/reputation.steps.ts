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

// Part 2a (ORW-564): social roles - the REAL adapter through a registry sandbox. TEST-ONLY seams: the event record, the live season, the role read. Roles only.
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { planSpeech } from "../../src/engine/houseSpeech";
import { sayable } from "../../src/engine/claimsToPlayer";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { reputationNature } from "../../src/engine/spokenClaims";
type RoleSeam = {
  live: { playedGame?: boolean; pending?: unknown; beliefs?: BeliefStore };
  record?: { events(): unknown[] };
  roleOf(o: string, s: string): string | undefined; setSocialRolesEnabled(on: boolean): void;
};
type RB = { g?: RoleSeam; npcs: string[]; subject?: string; said?: ReturnType<typeof planSpeech> };
const rb = (x: unknown): RB => ((x as { roles0184?: RB }).roles0184 ??= { npcs: [] });
let rn = 0;
const fightsBy = (s: string, o: string, others: string[]) => [0, 1, 2].map((i) => ({ id: `r${s}${i}`, ts: i, type: "conflict", initiator: s, witnessSet: [s, others[i % others.length]!, o], hidden: false, content: "" }));
Given("a played season with social roles on", function () {
  const b = rb(this);
  const sb = new GameSessionRegistry().sandboxFor(`roles0184-${rn++}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 84 });
  sb.session.advanceGame(); sb.session.advanceGame();
  b.g = sb.session as unknown as RoleSeam; b.g.setSocialRolesEnabled(true);
  b.g.live.playedGame = true; b.g.live.pending = undefined;
  b.npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
});
Given("a houseguest the observer saw start several fights", function () {
  const b = rb(this); const [o, s, a, c] = b.npcs as [string, string, string, string]; b.subject = s;
  b.g!.record = { events: () => fightsBy(s, o, [a, c]) };
});
Given("the player starting several fights the observer saw", function () {
  const b = rb(this); const [o, a, c] = b.npcs as [string, string, string]; b.subject = PLAYER;
  b.g!.record = { events: () => fightsBy(PLAYER, o, [a, c]) };
});
Then("the observer reads that houseguest as the house villain", function () { const b = rb(this); assert.equal(b.g!.roleOf(b.npcs[0]!, b.subject!), "villain"); });
Then("the observer reads the player as the house villain", function () { const b = rb(this); assert.equal(b.g!.roleOf(b.npcs[0]!, PLAYER), "villain"); });
Then("a houseguest who saw none of it reads no role in them", function () { const b = rb(this); assert.notEqual(b.g!.roleOf(b.npcs[4]!, b.subject!), "villain"); }); // the villain read comes only from fights they saw (another read, e.g. a floater in a fresh house, may stand)
When("the observer passes their read on in a scene with nothing else to tell", function () {
  const b = rb(this); const [o, , a] = b.npcs as [string, string, string];
  const g = b.g as unknown as { roleOf(h: string, x: string): string | undefined; truthFactsForTest?: unknown };
  b.said = planSpeech("fish", a, o, b.subject, true, { living: [...b.npcs, PLAYER], beliefs: {}, facts: (b.g as unknown as { truthFacts(): Parameters<typeof planSpeech>[5]["facts"] }).truthFacts(), roll: 0, roleOf: (h, x) => g.roleOf(h, x) });
});
Then("the listener holds it as talk about that houseguest, from the observer", function () {
  const b = rb(this);
  assert.ok(b.said); assert.equal(b.said!.kind, "has-reputation"); assert.equal(b.said!.subject, b.subject); assert.equal(b.said!.speaker, b.npcs[0]); assert.equal(b.said!.label, "villain");
});
Then("whether it is true is the engine's own read of the record, never the speaker's", function () {
  assert.equal(rb(this).said!.isTrue, true); // three fights the record holds: the engine reads the same role
});
Then("a houseguest who heard it may tell the player what the house thinks of them, as gossip in their own words", function () {
  const b = rb(this); const holder = b.npcs[1]!; const store: BeliefStore = {};
  recordClaim(store, { holder, kind: "heard-rumor", subject: PLAYER, value: true, origin: "told", source: b.npcs[0]!, nature: reputationNature("villain"), confidence: 0.6, week: 1 });
  assert.equal(sayable(store[holder]![0]!, holder, PLAYER)?.kind, "has-reputation");
});
