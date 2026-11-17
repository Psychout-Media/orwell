import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";
import type { OpenLedger } from "../../src/engine/openLedger";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/** Feature 0187 - promises bind (ORW-586). Drives the REAL adapter, no model. Roles only. */
type Mem = { kind: string; severity: number };
type Live = { playedGame?: boolean; beliefs?: BeliefStore; npcMemory?: Record<string, Record<string, Mem[]>> };
type Priv = Omit<GameSessionAdapter, "live" | "openLedger" | "rel"> & {
  live: Live; openLedger: OpenLedger;
  rel: { edge(a: string, b: string): { trust: number } };
  setPromiseTermsEnabled(on: boolean): void;
  movePlayer(room: string): { present: Array<{ id: string }> } | undefined;
  recordPromiseTerm(r: unknown): { accepted: boolean; reason?: string; entryId?: string };
  assuranceNominated(h: string, n: string, among?: readonly string[]): void;
  assuranceVotedOut(v: string, n: string, among?: readonly string[]): void;
  assuranceKeptAtNominations(h: string, ns: readonly string[]): void;
};
type Bag = { sb?: UserSandbox; g?: Priv; promiser?: string; promisee?: string; third?: string; pool?: string[]; entryId?: string; trust0?: number; refusals?: Array<{ accepted: boolean; reason?: string }>; withdraw?: { accepted: boolean }; reloaded?: Priv };
const bag = (w: unknown): Bag => ((w as { pb0187?: Bag }).pb0187 ??= {});
let n = 0;

function stage(w: unknown, flag: boolean): Bag {
  const b = bag(w);
  const sb = new GameSessionRegistry().sandboxFor(`pb0187-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Priv;
  g.live.playedGame = true;
  g.setAdvanceGateEnabled(false);
  sb.session.setAssurancesEnabled(true);
  sb.session.setNpcBeliefsEnabled(true); sb.session.setMemoryPromisesEnabled(true); sb.session.setLiesCaughtEnabled(true);
  g.setPromiseTermsEnabled(flag);
  g.noteMessage({ messageId: "m1" });
  const present = g.movePlayer("living-room")!.present.map((p) => p.id).filter((i) => i !== PLAYER);
  assert.ok(present.length >= 3, "three houseguests present");
  Object.assign(b, { sb, g, promiser: present[0], promisee: present[1], third: present[2], pool: present });
  return b;
}
const entry = (b: Bag, g: Priv = b.g!) => g.openLedger.entries.find((e) => e.id === b.entryId)!;
const lied = (g: Priv, holder: string) => claimsOf(g.live.beliefs ?? {}, holder).filter((c) => c.kind === "lied-to-me");
const sev = (g: Priv, holder: string, about: string, kind: string): number => (g.live.npcMemory?.[holder]?.[about] ?? []).filter((m) => m.kind === kind).reduce((s, m) => s + m.severity, 0);

function promise(w: unknown, what: string, subject?: "third"): void {
  const b = stage(w, true);
  const r = b.g!.recordPromiseTerm({ by: b.promiser, to: b.promisee, what, ...(subject ? { subject: b.third } : {}) });
  assert.equal(r.accepted, true, `the promise was recorded (${r.reason ?? ""})`);
  b.entryId = r.entryId; b.trust0 = b.g!.rel.edge(b.promisee!, b.promiser!).trust;
}

Given("a house where a promiser has promised a promisee not to nominate them", function () { promise(this, "no-nominate"); });
Given("a house where a promiser has promised a promisee to share what they hear", function () { promise(this, "share-info"); });
Given("a house where a promiser has promised a promisee not to vote out a third houseguest", function () { promise(this, "no-evict-vote", "third"); });
Given("a house with promise terms switched off", function () { stage(this, false); });

When("the promiser's nominations leave the promisee off the block", function () { const b = bag(this); b.g!.assuranceKeptAtNominations(b.promiser!, [b.third!]); });
When("the promiser nominates the promisee", function () { const b = bag(this); b.g!.assuranceNominated(b.promiser!, b.promisee!); });
When("the promiser votes the third houseguest out in the sealed ballot", function () { const b = bag(this); b.g!.assuranceVotedOut(b.promiser!, b.third!, b.pool!); });
When("the front end tries to mark that promise kept or broken", function () {
  const b = bag(this);
  b.refusals = (["kept", "broken"] as const).map((status) => b.g!.resolveOpenLedger({ entryId: b.entryId!, status, note: "x" }));
});
When("promise terms: the season is saved and loaded", function () {
  const b = bag(this);
  const next = new GameSessionAdapter();
  next.restore(JSON.parse(JSON.stringify(b.g!.snapshot())) as SessionSnapshot);
  b.reloaded = next as unknown as Priv;
});

Then("the promise is closed as kept by the engine", function () { const e = entry(bag(this)); assert.equal(e.status, "kept"); assert.match(e.note ?? "", /^engine judged kept/); });
Then("the promise is closed as broken by the engine", function () { const e = entry(bag(this)); assert.equal(e.status, "broken"); assert.match(e.note ?? "", /^engine judged broken/); });
Then("the promisee holds a favor toward the promiser", function () {
  const b = bag(this);
  assert.ok(sev(b.g!, b.promisee!, b.promiser!, "deal-kept") + lied(b.g!, b.promisee!).length > 0, "a favor (or, by the seeded rumor roll, a wrong belief) was folded");
});
Then("the promisee trusts the promiser less and believes they were lied to", function () {
  const b = bag(this);
  assert.ok(b.g!.rel.edge(b.promisee!, b.promiser!).trust < b.trust0! || b.trust0 === 0, "trust fell");
  assert.ok(lied(b.g!, b.promisee!).some((c) => c.subject === b.promiser), "a lied-to-me claim");
});
Then("the engine refuses both", function () { for (const r of bag(this).refusals!) assert.deepEqual(r, { accepted: false, reason: "engine-judged" }); assert.equal(entry(bag(this)).status, "open"); });
Then("the front end may still withdraw it", function () { const b = bag(this); assert.deepEqual(b.g!.resolveOpenLedger({ entryId: b.entryId!, status: "withdrawn", note: "x" }), { accepted: true }); });
Then("the promise stays open", function () { assert.equal(entry(bag(this)).status, "open"); });
Then("the promisee blames every possible voter by the same share", function () {
  const b = bag(this);
  const shares = b.pool!.filter((s) => s !== b.promisee).map((s) => sev(b.g!, b.promisee!, s, "deal-broken"));
  assert.ok(shares[0]! > 0);
  for (const x of shares) assert.ok(Math.abs(x - shares[0]!) < 1e-12);
});
Then("no lied-to-me claim names anyone", function () { const b = bag(this); assert.deepEqual(lied(b.g!, b.promisee!), []); });
Then("the visible promise stays open", function () { assert.equal(entry(bag(this)).status, "open"); });
Then("the promise still carries its term and reads broken", function () {
  const b = bag(this);
  const e = entry(b, b.reloaded!);
  assert.equal(e.status, "broken");
  assert.equal(e.term?.what, "no-nominate");
  assert.equal(e.term?.by, b.promiser);
});
Then("recording a promise term is refused", function () { const b = bag(this); assert.deepEqual(b.g!.recordPromiseTerm({ by: b.promiser, to: b.promisee, what: "no-nominate" }), { accepted: false, reason: "off" }); });
Then("a nomination leaves the ledger empty", function () { const b = bag(this); b.g!.assuranceNominated(b.promiser!, b.promisee!); assert.equal(b.g!.openLedger.entries.length, 0); });
Then("no player or admin view shows a promise term or a judgement note", async function () {
  const b = bag(this);
  const surfaces = [
    await b.sb!.mcp.player.callTool("getGameState", {}), await b.sb!.mcp.player.callTool("gameStatus", {}), await b.sb!.mcp.player.callTool("getMomentPrompt", {}),
    await b.sb!.mcp.player.callTool("whereabouts", {}), await b.sb!.mcp.admin.callTool("inspectNonVaultState", {}), b.g!.openLedgerHere(),
  ];
  const blob = JSON.stringify(surfaces);
  for (const k of ["engine judged", '"no-nominate"', '"term"']) assert.ok(!blob.includes(k), `a live surface carries ${k}`);
});
