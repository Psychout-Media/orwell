import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { Deal } from "../../src/domain/deal";
import { BOND, type BondStore } from "../../src/engine/bondRecord";

/**
 * Feature 0175 - the bond record (Theme 3 Core 1). Drives the REAL adapter through a registry sandbox: scenes go into the sandbox's real event store, deals
 * through the adapter's real deal ledger, and the bond is read through the adapter's own `bondReader()` (which folds what happened). TEST-ONLY seams: the
 * live season (bonds, the day, the veto), the deal ledger. Roles only: a pair, a breaker, a veto holder and a nominee.
 */
type Live = { playedGame?: boolean; bonds?: BondStore; dayNumber?: number; week: number; vetoHolder?: string; saved?: string };
type Ledger = { make(parties: [string, string], kind: string, terms: string, madeEventId?: string, madeWeek?: number): Deal; breakDeliberately(d: Deal, breaker: string): string | undefined };
type Seam = { live: Live; deals: Ledger };
type Bag = { sb?: UserSandbox; a?: string; b?: string; before?: number; grudge?: number; strain?: number };
const bag = (w: unknown): Bag => ((w as { bond0175?: Bag }).bond0175 ??= {});
const seam = (w: unknown) => bag(w).sb!.session as unknown as Seam;
const session = (w: unknown) => bag(w).sb!.session as GameSessionAdapter;
let n = 0, seq = 0;

Given("a played season with the bond record on", function () {
  const sb = new GameSessionRegistry().sandboxFor(`bond0175-${n++}`);
  sb.session.setBondRecordEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 6 });
  const b = bag(this);
  b.sb = sb;
  seam(this).live.playedGame = true;
  [b.a, b.b] = sb.session.livingIds().filter((id) => id !== PLAYER);
});

function scene(w: unknown, type: string, people: string[]): void {
  bag(w).sb!.engine.events.record({
    id: `bond0175-${seq++}`, ts: 5_000_000 + seq, type, initiator: people[0]!, witnessSet: people, hidden: true, content: `a ${type} scene`,
    houseLife: { action: type, place: "kitchen", manner: "plain", truthful: true, stretch: 0 },
  });
}

When("two houseguests share several warm scenes and make a final two", function () {
  const b = bag(this);
  b.before = session(this).bondReader().strength(b.a!, b.b!);
  for (let i = 0; i < 5; i++) scene(this, "bonding", [b.a!, b.b!]);
  seam(this).deals.make([b.a!, b.b!], "final-two", "the two of us to the end", undefined, seam(this).live.week);
});

Then("each holds the other as a friend, with a final-two commitment", function () {
  const b = bag(this); const r = session(this).bondReader();
  for (const [x, y] of [[b.a!, b.b!], [b.b!, b.a!]]) {
    const v = r.bond(x, y);
    assert.equal(v.kind, "friendship");
    assert.equal(v.commitment, "final-two");
    assert.ok(v.history >= 5, `history ${v.history}`);
  }
});

Then("the bond between them is stronger than before", function () {
  const b = bag(this);
  assert.ok(session(this).bondReader().strength(b.a!, b.b!) > b.before!, "warm scenes did not strengthen the bond");
});

When("two houseguests clash twice", function () {
  const b = bag(this);
  scene(this, "conflict", [b.a!, b.b!]); scene(this, "conflict", [b.a!, b.b!]);
});

Then("each holds a grudge and strain toward the other", function () {
  const b = bag(this); const r = session(this).bondReader();
  for (const [x, y] of [[b.a!, b.b!], [b.b!, b.a!]]) {
    const v = r.bond(x, y);
    assert.ok(v.resentment > 0 && v.strain > 0, `resentment ${v.resentment} strain ${v.strain}`);
  }
  const v = r.bond(b.a!, b.b!);
  b.grudge = v.resentment; b.strain = v.strain;
});

When("several nights pass with no new clash", function () {
  const live = seam(this).live;
  live.dayNumber = (live.dayNumber ?? 1) + 5;
});

Then("the strain has eased more than the grudge, and the worst of the grudge is still remembered", function () {
  const b = bag(this);
  const v = session(this).bondReader().bond(b.a!, b.b!);
  const eased = b.strain! - v.strain, faded = b.grudge! - v.resentment;
  assert.ok(eased > 0 && eased > faded, `strain eased ${eased}, grudge faded ${faded}`);
  assert.ok((seam(this).live.bonds?.[`${b.a}|${b.b}`]?.peakResentment ?? 0) >= b.grudge!, "the worst of the grudge was forgotten");
});

When("one houseguest quietly breaks a deal with another", function () {
  const b = bag(this);
  const d = seam(this).deals.make([b.a!, b.b!], "safety", "you are safe with me", undefined, seam(this).live.week);
  assert.ok(seam(this).deals.breakDeliberately(d, b.a!), "the deal was not broken");
});

Then("the one wronged holds no grudge yet, because they do not know", function () {
  const b = bag(this);
  assert.equal(session(this).bondReader().bond(b.b!, b.a!).resentment, 0, "the wronged side reacted to a break they never learned of (ORW-597)");
});

When("the breaker then nominates them", function () {
  const b = bag(this);
  const others = session(this).livingIds().filter((id) => id !== PLAYER && id !== b.a && id !== b.b);
  (seam(this).deals as unknown as { reconcile(a: { actor: string; kind: string; targets: string[] }, sink?: unknown): unknown }).reconcile({ actor: b.a!, kind: "nominate", targets: [b.b!, others[0]!] });
});

Then("the one wronged holds a grudge toward the breaker", function () {
  const b = bag(this);
  assert.ok(session(this).bondReader().bond(b.b!, b.a!).resentment > 0, "the wronged party holds no grudge");
});

Then("the breaker holds no grudge, only strain", function () {
  const b = bag(this);
  const v = session(this).bondReader().bond(b.a!, b.b!);
  assert.equal(v.resentment, 0);
  assert.ok(v.strain > 0, "the breaker feels nothing");
});

When("the veto holder saves a nominee", function () {
  const b = bag(this); const live = seam(this).live;
  live.vetoHolder = b.a!; live.saved = b.b!;
});

Then("the saved houseguest owes the veto holder", function () {
  const b = bag(this); const r = session(this).bondReader();
  assert.ok(r.bond(b.b!, b.a!).debt < 0, "the saved houseguest owes nothing");
  assert.ok(r.bond(b.a!, b.b!).debt > 0, "the saver is owed nothing");
});

Then("the bond record survives a save and a restore unchanged", function () {
  const b = bag(this);
  session(this).bondReader(); // fold
  const core = session(this).snapshot();
  const sb2 = new GameSessionRegistry().sandboxFor(`bond0175-r-${n++}`);
  sb2.session.restore(JSON.parse(JSON.stringify(core)));
  const back = (sb2.session as unknown as Seam).live.bonds;
  assert.deepEqual(back, seam(this).live.bonds);
  assert.ok(back?.[`${b.a}|${b.b}`], "the pair's record did not survive");
});

Then("no player or admin view carries the bond record", async function () {
  const sb = bag(this).sb!;
  const out = JSON.stringify([
    await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
    await sb.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
  assert.ok(!/peakResentment|resentment|warmth|"strain"|commitment"|bondsSeen|bondsCursor/.test(out), "a bond field reached a player or admin view");
});

Then("each houseguest's private pecking order follows how close they are, the closest first, and ranks only their top few", function () {
  const b = bag(this); const r = session(this).bondReader();
  const ties = r.ties(b.a!);
  const ranked = ties.filter((t) => t.strength > 0).slice(0, BOND.rankTop);
  ranked.forEach((t, i) => assert.equal(r.bond(b.a!, t.other).rank, i + 1, `rank of the ${i + 1}th closest`));
  for (const t of ties.slice(ranked.length)) assert.equal(r.bond(b.a!, t.other).rank, null);
  assert.ok(ranked.some((t) => t.other === b.b), "the pair's warm scenes did not put them in the holder's top few");
});
