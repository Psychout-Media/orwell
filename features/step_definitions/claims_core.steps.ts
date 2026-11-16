import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { claimConfidence, type ClaimLog, type SpokenClaim } from "../../src/engine/spokenClaims";
import { convictionFor } from "../../src/engine/beliefConviction";

/**
 * Feature 0149 - the claims core (theme 2 slice 1, ORW-330). Drives the REAL adapter through a per-user registry sandbox (its own stores and
 * its player and admin MCP servers). `tellClaim` is engine-side only (no tool), so the steps call it the way slice 3/4 callers will.
 * TEST-ONLY seams: the live season (to read the engine-only claims and beliefs) and the relationship model (to set a listener's trust).
 * Roles only: the player, a speaker, a listener, a subject.
 */

type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; told?: SpokenClaim[]; before?: string; npcs?: string[] };
const bag = (w: unknown): Bag => ((w as { claims0149?: Bag }).claims0149 ??= {});
const live = (s: GameSessionAdapter) => (s as unknown as { live: { claims?: ClaimLog; beliefs?: Record<string, BeliefClaim[]> } }).live;
const rel = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { trust: number } } }).rel;
let n = 0;

const npcs = (w: unknown) => bag(w).npcs!;
const s = (w: unknown) => bag(w).s!;
function tell(w: unknown, c: Parameters<GameSessionAdapter["tellClaim"]>[0]): SpokenClaim {
  const told = s(w).tellClaim(c);
  assert.ok(told, "the engine refused a valid claim");
  (bag(w).told ??= []).push(told);
  return told;
}
const beliefsOf = (w: unknown, holder: string) => live(s(w)).beliefs?.[holder] ?? [];

async function surfaces(sb: UserSandbox): Promise<string> {
  const parts = [
    // review of #2858: the player reads the narrator and the status panel use, and the admin's state read (a standalone registry has no health record, so it is not sampled)
    await sb.mcp.player.callTool("getGameState", {}),
    await sb.mcp.player.callTool("gameStatus", {}),
    await sb.mcp.player.callTool("getMomentPrompt", {}),
    await sb.mcp.admin.callTool("inspectNonVaultState", {}),
  ];
  return JSON.stringify(parts);
}

Given("a started season with claims on", function () {
  const sb = new GameSessionRegistry().sandboxFor(`claims0149-${n++}`);
  sb.session.setNpcBeliefsEnabled(true); // review of #2858: "claims on" turns the belief layer on explicitly (independent of ORWELL_NPC_BELIEFS / ORWELL_FLAGS_OFF)
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  const b = bag(this);
  b.sb = sb; b.s = sb.session;
  b.npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  assert.ok(b.npcs.length >= 4, "too few houseguests");
});

// ---- Scenario: a told claim becomes the listener's belief, with its source ----

When("an NPC tells a second NPC that a third NPC is targeting them", function () {
  const [speaker, listener, subject, other] = npcs(this);
  rel(s(this)).edge(listener!, speaker!).trust = 0.9;      // the listener trusts this speaker
  rel(s(this)).edge(other!, speaker!).trust = 0.1;         // a second listener who does not
  tell(this, { speaker: speaker!, listener: listener!, kind: "targets-you", subject: subject!, isTrue: true, intent: "warn" });
  tell(this, { speaker: speaker!, listener: other!, kind: "targets-you", subject: subject!, isTrue: true, intent: "warn" });
});

Then("the second NPC believes the third NPC is targeting them", function () {
  const [, listener, subject] = npcs(this);
  const held = beliefsOf(this, listener!).filter((c) => c.kind === "targets-me" && c.subject === subject && c.object === listener && c.value);
  assert.equal(held.length, 1, "the listener does not hold the told belief");
});

Then("the belief names the first NPC as its source", function () {
  const [speaker, listener, subject] = npcs(this);
  const held = beliefsOf(this, listener!).find((c) => c.kind === "targets-me" && c.subject === subject)!;
  assert.equal(held.source, speaker);
  assert.equal(held.origin, "told");
});

Then("the belief's confidence follows how much the listener trusts the speaker", function () {
  const [, listener, subject, other] = npcs(this);
  const sure = beliefsOf(this, listener!).find((c) => c.kind === "targets-me" && c.subject === subject)!;
  const doubtful = beliefsOf(this, other!).find((c) => c.kind === "targets-me" && c.subject === subject)!;
  assert.ok(sure.confidence > doubtful.confidence, `trusted ${sure.confidence} vs distrusted ${doubtful.confidence}`);
  // 0160 (conviction): the source's confidence, scaled by the listener's own credulity (`convictionFor`); 0.5 credulity leaves it as is.
  const credulity = (s(this) as unknown as { credulityOf(id: string): number }).credulityOf(listener!);
  assert.equal(sure.confidence, convictionFor(claimConfidence(0.9, false), credulity));
});

// ---- Scenario: a false claim plants a false belief, and the engine knows ----

When("an NPC tells a second NPC something the engine knows is untrue", function () {
  const [speaker, listener, subject] = npcs(this);
  tell(this, { speaker: speaker!, listener: listener!, kind: "voted-to-evict-you", subject: subject!, isTrue: false, intent: "mislead" });
});

Then("the second NPC holds it as a belief like any other", function () {
  const [speaker, listener, subject] = npcs(this);
  const held = beliefsOf(this, listener!).find((c) => c.kind === "voted-against-me" && c.subject === subject);
  assert.ok(held, "the false claim planted no belief");
  assert.equal(held.value, true);
  assert.equal(held.source, speaker);
  assert.equal(held.refuted, undefined);
});

Then("the engine records the claim as a lie told by the first NPC, with what the first NPC meant by it", function () {
  const [speaker] = npcs(this);
  const logged = live(s(this)).claims!.items.filter((c) => c.speaker === speaker);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.isTrue, false);
  assert.equal(logged[0]!.intent, "mislead");
});

// ---- Scenario: the player hears a claim only as its listener ----

When("an NPC tells the player a lie about a second NPC", function () {
  const [speaker, subject] = npcs(this);
  tell(this, { speaker: speaker!, listener: PLAYER, kind: "targets-you", subject: subject!, isTrue: false, intent: "deflect" });
});

Then("the claims the narrator may voice hold the NPC's words to the player", function () {
  const [speaker, subject] = npcs(this);
  const heard = s(this).claimsThePlayerHeard();
  assert.equal(heard.length, 1);
  assert.equal(heard[0]!.speaker, speaker);
  assert.equal(heard[0]!.kind, "targets-you");
  assert.equal(heard[0]!.subject, subject);
});

Then("they never say whether the claim is true or what the NPC meant by it", function () {
  const heard = JSON.stringify(s(this).claimsThePlayerHeard());
  for (const k of ["isTrue", "intent", "deflect", "origin", "claim:"]) assert.ok(!heard.includes(k), `the narrator view carries ${k}`);
  const allowed = new Set(["speaker", "kind", "subject", "object", "week", "day"]);
  for (const k of Object.keys(s(this).claimsThePlayerHeard()[0]!)) assert.ok(allowed.has(k), `the narrator view carries ${k}`);
});

Then("the player is handed no belief: the read is the player's own", function () {
  assert.equal(beliefsOf(this, PLAYER).length, 0);
});

// ---- Scenario: claims are secret engine state, kept whole ----

Given("claims have been told between houseguests the player never heard", async function () {
  const b = bag(this);
  b.before = await surfaces(b.sb!);
  const [a, c, d, e] = npcs(this);
  tell(this, { speaker: a!, listener: c!, kind: "final-two-with", subject: d!, object: e!, isTrue: false, intent: "mislead" });
  tell(this, { speaker: c!, listener: d!, kind: "going-after", subject: a!, object: e!, isTrue: true, intent: "recruit" });
  tell(this, { speaker: d!, listener: e!, kind: "lying-about", subject: c!, isTrue: false, intent: "protect" });
});

Then("no player-facing or admin view contains them", async function () {
  const b = bag(this);
  const after = await surfaces(b.sb!);
  assert.ok(!after.includes("claim:") && !after.includes("isTrue"), "a claim reached a surface");
  assert.equal(after, b.before, "telling claims changed what a player or admin surface shows");
});

Then("the claims the narrator may voice are empty", function () {
  assert.deepEqual(s(this).claimsThePlayerHeard(), []);
});

Then("every claim survives a save and restore unchanged", function () {
  const core = JSON.parse(JSON.stringify(s(this).snapshot()));
  const revived = new GameSessionAdapter();
  revived.restore(core);
  assert.deepEqual(live(revived).claims, live(s(this)).claims);
  assert.equal(live(revived).claims!.items.length, bag(this).told!.length);
});
