import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefStore } from "../../src/engine/beliefStore";
import type { ClaimLog } from "../../src/engine/spokenClaims";

/**
 * Feature 0155 - the open ledger as the safety net (theme 2 slice 6, ORW-330). The claim goes in through the REAL player-channel write-back
 * (`recordOpenLedger` over the MCP boundary, as the front end sends it), on a registry sandbox. TEST-ONLY seams: the live season (claims,
 * beliefs, the ballot record that fixes the truth). Roles only: a speaker, a listener, a subject, a third houseguest.
 */
type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; speaker?: string; listener?: string; subject?: string; third?: string; before?: string; surfacesBefore?: string };
const bag = (w: unknown): Bag => ((w as { net0155?: Bag }).net0155 ??= {});
const live = (s: GameSessionAdapter) => (s as unknown as { live: { playedGame?: boolean; claims?: ClaimLog; beliefs?: BeliefStore; voteRecord?: unknown[] } }).live;
let n = 0;

async function surfaces(sb: UserSandbox): Promise<string> {
  return JSON.stringify([await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {})]);
}

Given("a played season with the open ledger on", function () {
  const sb = new GameSessionRegistry().sandboxFor(`net0155-${n++}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.setOpenLedgerEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 4 });
  live(sb.session).playedGame = true;
  const present = (sb.session.whereabouts()?.present ?? []).map((x) => x.id as string).filter((id) => id !== PLAYER);
  assert.ok(present.length >= 4, "too few houseguests with the player to overhear anything");
  const b = bag(this);
  b.sb = sb; b.s = sb.session;
  [b.speaker, b.listener, b.subject, b.third] = present;
});

const record = (w: unknown, req: Record<string, unknown>) => bag(w).sb!.mcp.player.callTool("recordOpenLedger", req) as Promise<{ accepted: boolean }>;

When("the narration has a houseguest tell the player and another houseguest that a third houseguest is targeting them", async function () {
  const b = bag(this);
  const r = await record(this, { text: "Watch your back, they are coming for you.", speaker: b.speaker!, addressedTo: [PLAYER, b.listener!], kind: "claim", about: b.subject!,
    claim: { kind: "targets-you", subject: b.subject! } });
  assert.ok(r.accepted, "the ledger refused the entry");
});

Then("the engine records the claim with its speaker and its listeners, as narrated", function () {
  const b = bag(this);
  const items = live(b.s!).claims?.items ?? [];
  const toListener = items.find((c) => c.listener === b.listener && c.speaker === b.speaker && c.kind === "targets-you" && c.subject === b.subject);
  assert.ok(toListener, "no claim was told to the houseguest it was addressed to");
  assert.equal(toListener.origin, "narrated");
  assert.ok(items.some((c) => c.listener === PLAYER && c.origin === "narrated"), "the player, who heard the narration, has no claim recorded as heard");
  assert.ok(b.s!.claimsThePlayerHeard().some((h) => h.speaker === b.speaker && h.kind === "targets-you"), "the narrator seam misses what the player heard");
});

Then("the houseguest who heard it holds it as a belief, sourced to the speaker", function () {
  const b = bag(this);
  const held = (live(b.s!).beliefs?.[b.listener!] ?? []).filter((c) => c.kind === "targets-me" && c.subject === b.subject && c.source === b.speaker);
  assert.equal(held.length, 1);
});

Then("the player is handed no belief", function () {
  assert.equal((live(bag(this).s!).beliefs?.[PLAYER] ?? []).length, 0);
});

When("the narration has a houseguest claim that another houseguest voted to evict a third", async function () {
  const b = bag(this);
  b.surfacesBefore = await surfaces(b.sb!);
  // the engine's own record: the subject voted to evict the third houseguest (secret ballots - engine-only)
  live(b.s!).voteRecord = [{ week: 1, evictee: b.third!, voteOf: { [b.subject!]: b.third!, [b.listener!]: b.speaker! } }];
  await record(this, { text: "You know they voted you out of here, right?", speaker: b.speaker!, addressedTo: [b.listener!], kind: "claim", about: b.subject!,
    claim: { kind: "voted-against", subject: b.subject!, object: b.third! } });
  await record(this, { text: "And they voted against you too.", speaker: b.speaker!, addressedTo: [b.listener!], kind: "claim", about: b.listener!,
    claim: { kind: "voted-against", subject: b.subject!, object: b.listener! } });
});

Then("the engine marks the claim true or false from its own record of the ballots", function () {
  const b = bag(this);
  const items = (live(b.s!).claims?.items ?? []).filter((c) => c.listener === b.listener && c.kind === "voted-against");
  assert.equal(items.find((c) => c.object === b.third)?.isTrue, true, "a claim the ballot record confirms was not marked true");
  assert.equal(items.find((c) => c.object === b.listener)?.isTrue, false, "a claim the ballot record contradicts was not marked false");
});

Then("no player or admin view shows that verdict", async function () {
  const b = bag(this);
  const after = await surfaces(b.sb!);
  assert.ok(!after.includes("isTrue") && !after.includes("claim:"), "a claim or its verdict reached a surface");
});

When("the narration records a promise with no claim attached", async function () {
  const b = bag(this);
  b.before = JSON.stringify({ c: live(b.s!).claims, b: live(b.s!).beliefs });
  const r = await record(this, { text: "I promise I will keep you off the block.", speaker: b.speaker!, addressedTo: [PLAYER], kind: "promise" });
  assert.ok(r.accepted, "the ledger refused a plain promise");
  await record(this, { text: "They are a wizard, I swear.", speaker: b.speaker!, addressedTo: [b.listener!], kind: "claim", claim: { kind: "is-a-wizard", subject: b.subject! } });
});

Then("no claim is recorded and no belief changes", function () {
  const b = bag(this);
  assert.equal(JSON.stringify({ c: live(b.s!).claims, b: live(b.s!).beliefs }), b.before);
});
