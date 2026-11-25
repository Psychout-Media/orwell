import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { PLAYER } from "../../src/domain/ids";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { Played } from "../../tests/support/favorsSeam";
import { triadSession, seamOf, flatten, set, close, runDays } from "../../tests/support/triadsSeam";

/**
 * Feature 0174 - triads, swing votes, kingmakers. Drives the REAL adapter through a registry sandbox (tests/support/triadsSeam.ts); every step carries the "triads:" prefix
 * or a "triads season" Given, so no wording collides with another feature. Roles only.
 */
type Bag = {
  sessions?: Array<{ p: Played; ids: string[] }>; one?: { p: Played; nominees: [string, string]; swing: string; others: string[] };
  runs?: string[]; off?: string; saved?: unknown; loaded?: Played; before?: string;
  pairA?: string; pairB?: string; center?: string; weaker?: string; closer?: string;
};
const bag = (w: unknown): Bag => ((w as { t0174?: Bag }).t0174 ??= {});
const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const aff = (p: Played, a: string, b: string): number => p.seam.rel.edge(a, b).affinity;

/** A flat house with the first six NPCs free for a scenario to colour. */
function house(seed: number): { p: Played; n: string[] } {
  const p = triadSession(seed); flatten(p); return { p, n: p.npcs };
}
/** How many seeds the pair `a`,`b` ended warmer in after `days`, and how many ended colder (the daily drift never cools a pair that is not strained). */
function warmerAfter(setup: (h: { p: Played; n: string[] }) => [string, string], days = 14): { warmer: number; colder: number } {
  let warmer = 0, colder = 0;
  for (const seed of SEEDS) {
    const h = house(seed); const [a, b] = setup(h);
    const before = aff(h.p, a, b) + aff(h.p, b, a);
    runDays(h.p, days);
    const after = aff(h.p, a, b) + aff(h.p, b, a);
    if (after > before + 1e-9) warmer++; else if (after < before - 1e-9) colder++;
  }
  return { warmer, colder };
}

Given("a triads season where two houseguests share an enemy", function () { bag(this); });
Then("triads: they grow warmer toward each other, across seeds", function () {
  const r = warmerAfter(({ p, n }) => { set(p, n[0]!, n[2]!, { threat: 0.8, trust: 0.05 }); set(p, n[1]!, n[2]!, { threat: 0.8, trust: 0.05 }); return [n[0]!, n[1]!]; });
  assert.ok(r.warmer >= SEEDS.length * 0.7, `only ${r.warmer} of ${SEEDS.length} seeds warmed`);
  assert.equal(r.colder, 0, "a shared enemy never cools the pair");
});

Given("a triads season where a houseguest is close to two others who barely know each other", function () { bag(this); });
Then("triads: the two others grow closer over time", function () {
  const r = warmerAfter(({ p, n }) => { close(p, n[0]!, n[1]!); close(p, n[0]!, n[2]!); return [n[1]!, n[2]!]; });
  assert.ok(r.warmer >= SEEDS.length * 0.7, `only ${r.warmer} of ${SEEDS.length} seeds drifted together`);
  assert.equal(r.colder, 0);
});

Given("a triads season where a houseguest is close to two others who are enemies of each other", function () { bag(this); });
Then("triads: the bond to the one they like less strains while the closer one holds", function () {
  let cooled = 0;
  for (const seed of SEEDS) {
    const { p, n } = house(seed); const [c, closer, weaker] = [n[0]!, n[1]!, n[2]!];
    close(p, c, closer, 0.95); close(p, c, weaker, 0.7);
    set(p, closer, weaker, { threat: 0.8 }); set(p, weaker, closer, { threat: 0.8 });
    const wBefore = aff(p, c, weaker), cBefore = aff(p, c, closer);
    runDays(p, 14);
    if (aff(p, c, weaker) < wBefore - 1e-9) cooled++;
    assert.ok(aff(p, c, closer) >= cBefore - 1e-9, "the closer bond must hold");
  }
  assert.ok(cooled >= SEEDS.length * 0.6, `only ${cooled} of ${SEEDS.length} seeds strained`);
});

/** A vote one ballot decides: six NPC voters split 3-2 with the softest on the leading side, two NPC nominees, everyone else a voter. Pitchers are close to the swing voter. */
function closeVote(seed: number, withPlayer = false): { p: Played; nominees: [string, string]; swing: string; others: string[]; view: Parameters<ReturnType<typeof seamOf>["swingAtVote"]>[0] } {
  const { p, n } = house(seed);
  const nominees: [string, string] = [n[0]!, n[1]!];
  const swing = n[2]!, others = [n[3]!, n[4]!, n[5]!, n[6]!];
  // each nominee has an ally who votes, and everyone reads the swing voter warmly enough to pitch to
  close(p, nominees[0], others[0]!); close(p, nominees[1], others[1]!);
  for (const x of [...nominees, others[0]!, others[1]!]) close(p, x, swing, 0.8);
  const previews = [
    { voter: swing, pick: nominees[0], gap: 0.01 }, { voter: others[0]!, pick: nominees[0], gap: 0.9 }, { voter: others[2]!, pick: nominees[0], gap: 0.6 },
    { voter: others[1]!, pick: nominees[1], gap: 0.8 }, { voter: others[3]!, pick: nominees[1], gap: 0.7 },
  ];
  const voters = [swing, ...others, ...(withPlayer ? [PLAYER] : [])];
  return { p, nominees, swing, others, view: { nominees, voters, previews } };
}
const courtedFor = (p: Played, swing: string) => seamOf(p).live.triads?.courted?.filter((c) => c.voter === swing) ?? [];

Given("a triads season where one houseguest's vote decides an eviction", function () {
  const b = bag(this); b.sessions = [];
  for (const seed of SEEDS) { const v = closeVote(seed); seamOf(v.p).swingAtVote(v.view); b.sessions.push({ p: v.p, ids: [v.swing, ...v.nominees, ...v.others] }); }
});
Then("triads: both camps pitch them, and the price is higher with a rival bidder than without", function () {
  const rows = bag(this).sessions!.map(({ p, ids }) => ({ p, c: courtedFor(p, ids[0]!)[0] })).filter((r) => r.c);
  const two = rows.filter((r) => r.c!.bidders.length >= 2 && r.c!.tier >= 2), one = rows.filter((r) => r.c!.tier === 1);
  assert.ok(two.length > 0, "no seed had both camps pitch the swing voter");
  assert.ok(one.length > 0, "no seed had a lone camp pitch");
  for (const r of two) {
    const swing = r.c!.voter;
    for (const pitcher of r.c!.bidders) assert.equal(r.p.session.favorLedger().filter((f) => f.owedBy === pitcher && f.owedTo === swing && f.origin.startsWith("courted")).length, r.c!.tier, "each pitcher owes one favor per tier");
  }
  assert.ok(Math.min(...two.map((r) => r.c!.tier)) > Math.max(...one.map((r) => r.c!.tier)), "the price must be higher with a rival bidder");
});
Then("triads: that houseguest holds the read that they decide it, and their read of each pitcher moved", function () {
  let moved = 0;
  for (const seed of SEEDS) {
    const v = closeVote(seed);
    const before = new Map(v.nominees.concat(v.others).map((x) => [x, aff(v.p, v.swing, x)] as const));
    seamOf(v.p).swingAtVote(v.view);
    const c = courtedFor(v.p, v.swing)[0];
    if (!c) continue;
    assert.ok(c.bidders.length > 0 && !c.bidders.includes(v.swing));
    for (const b of c.bidders) { assert.ok(aff(v.p, v.swing, b) > before.get(b)!, "a landed pitch warms the swing voter's read of the pitcher"); moved++; }
  }
  assert.ok(moved > 0, "no pitch landed in any seed");
});

Given("a triads season where the player's own vote could decide an eviction", function () { bag(this); });
Then("triads: the camps pitch the player and one stands as an offer they may decline, and no ballot is set for them", function () {
  let offered = 0;
  for (const seed of SEEDS) {
    const v = closeVote(seed, true);
    const heard: string[] = [];
    seamOf(v.p).setOnPlayerEvent((c, w) => { if (w.includes(PLAYER)) heard.push(c); return undefined; });
    // an even NPC split: the player's ballot decides
    const view = { ...v.view, previews: [{ voter: v.others[0]!, pick: v.nominees[0], gap: 0.5 }, { voter: v.others[1]!, pick: v.nominees[1], gap: 0.5 }] };
    seamOf(v.p).swingAtVote(view);
    const s = seamOf(v.p).live;
    assert.equal(s.pending, undefined, "the player's ballot must not be decided or pended by the courting");
    if (s.votePitch) {
      offered++;
      assert.equal(s.votePitch.kind, "vote");
      assert.ok(heard.length > 0, "the player witnesses the pitch");
      (v.p.seam as unknown as { resolveDealOffer(a: boolean, slot: string): unknown }).resolveDealOffer(false, "pitch"); // the player may decline
      assert.equal(s.votePitch, undefined);
      assert.equal(s.pending, undefined);
    }
    assert.ok(courtedFor(v.p, PLAYER).length > 0 || !heard.length, "a pitch to the player is recorded as a courting of the player");
  }
  assert.ok(offered > 0, "no seed offered the player a pitch");
});

Given("a triads season where the player's vote could decide an eviction while another offer already stands", function () { bag(this); });
Then("triads: the vote pitch lands in its own slot, the other offer stays, each is answered on its own, and the flag off keeps today's single slot", function () {
  const resolve = (p: Played, accept: boolean, slot: string) => (p.seam as unknown as { resolveDealOffer(a: boolean, s: string): unknown }).resolveDealOffer(accept, slot);
  let both = 0;
  for (const seed of SEEDS) {
    const v = closeVote(seed, true);
    const s = seamOf(v.p).live;
    const other = { id: `offer:${v.others[3]}:${s.week}`, from: v.others[3]!, kind: "safety", terms: "an ordinary approach", madeWeek: s.week };
    s.dealOffer = other; s.lastDealOfferWeek = s.week; // another approach already stands, and this week's approach is spent
    seamOf(v.p).swingAtVote({ ...v.view, previews: [{ voter: v.others[0]!, pick: v.nominees[0], gap: 0.5 }, { voter: v.others[1]!, pick: v.nominees[1], gap: 0.5 }] });
    if (!s.votePitch) continue;
    both++;
    assert.equal(s.dealOffer, other, "the pitch must not displace the other approach");
    assert.equal(s.lastDealOfferWeek, s.week);
    assert.equal(s.votePitch.kind, "vote");
    assert.notEqual(s.votePitch.id, other.id);
    const before = JSON.stringify(s.votePitch);
    seamOf(v.p).swingAtVote({ ...v.view, previews: [{ voter: v.others[0]!, pick: v.nominees[0], gap: 0.5 }, { voter: v.others[1]!, pick: v.nominees[1], gap: 0.5 }] });
    assert.equal(JSON.stringify(s.votePitch), before, "one pitch per vote: the cap holds");
    resolve(v.p, false, "pitch");
    assert.equal(s.votePitch, undefined);
    assert.equal(s.dealOffer, other, "answering the pitch leaves the other offer standing");
  }
  assert.ok(both > 0, "no seed raised a pitch beside a standing offer");
  // flag off: nothing is raised in either slot
  for (const seed of SEEDS.slice(0, 6)) {
    const v = closeVote(seed, true);
    v.p.session.setTriadsEnabled(false);
    seamOf(v.p).swingAtVote({ ...v.view, previews: [{ voter: v.others[0]!, pick: v.nominees[0], gap: 0.5 }, { voter: v.others[1]!, pick: v.nominees[1], gap: 0.5 }] });
    assert.equal(seamOf(v.p).live.votePitch, undefined);
    assert.equal(seamOf(v.p).live.dealOffer, undefined);
  }
});

Given("a triads season where two houseguests both hold the player as an enemy, and two others hold the player as a friend", function () { bag(this); });
Then("triads: the first two grow warmer toward each other and so do the others", function () {
  const enemy = warmerAfter(({ p, n }) => { set(p, n[0]!, PLAYER, { threat: 0.8, trust: 0.05 }); set(p, n[1]!, PLAYER, { threat: 0.8, trust: 0.05 }); return [n[0]!, n[1]!]; });
  assert.ok(enemy.warmer >= SEEDS.length * 0.7, `only ${enemy.warmer} seeds warmed against the player`);
  const friend = warmerAfter(({ p, n }) => { set(p, n[2]!, PLAYER, { trust: 0.9, affinity: 0.9, threat: 0.05 }); set(p, n[3]!, PLAYER, { trust: 0.9, affinity: 0.9, threat: 0.05 }); return [n[2]!, n[3]!]; });
  assert.ok(friend.warmer >= SEEDS.length * 0.7, `only ${friend.warmer} seeds drifted together through the player`);
});

Given("a triads season where a close eviction was courted and decided", function () {
  const b = bag(this); const v = closeVote(3); const s = seamOf(v.p);
  s.swingAtVote(v.view);
  const voteOf: Record<string, string> = {};
  for (const p of v.view.previews) voteOf[p.voter] = p.pick;
  s.triadsAtResult({ evictee: v.nominees[0], voteOf, hoh: v.others[3] });
  b.one = { p: v.p, nominees: v.nominees, swing: v.swing, others: v.others };
});
Then("triads: the deciding ballot is the kingmaker, history only, and it unseals in the retrospective", function () {
  const { p, swing, nominees } = bag(this).one!; const s = seamOf(p);
  const km = s.live.triads!.kingmakers!;
  assert.equal(km.length, 1);
  assert.equal(km[0]!.voter, swing, "the softest ballot on the winning side decided it");
  assert.equal(km[0]!.evictee, nominees[0]);
  const story = (s.buildVaultUnseal().hiddenStory ?? []).filter((r) => r.type === "Kingmaker");
  assert.equal(story.length, 1);
  assert.ok(!/[a-z]+:[a-z0-9]+/i.test(story[0]!.content.replace(/week \d+/g, "")), "no raw id in the retrospective line");
});

Given("a triads season where a swing houseguest is courted by both sides", function () {
  const b = bag(this);
  for (const seed of SEEDS) { const v = closeVote(seed); seamOf(v.p).swingAtVote(v.view); if ((courtedFor(v.p, v.swing)[0]?.bidders.length ?? 0) >= 2) { b.one = { p: v.p, nominees: v.nominees, swing: v.swing, others: v.others }; break; } }
  assert.ok(b.one, "no seed courted a swing voter");
});
Then("triads: no player or admin view shows a courted flag, a price, a swing marker or a triad", async function () {
  const p = bag(this).one!.p;
  runDays(p, 3);
  const out = JSON.stringify([
    await p.sb.mcp.player.callTool("getGameState", {}), await p.sb.mcp.player.callTool("gameStatus", {}), await p.sb.mcp.player.callTool("getMomentPrompt", {}),
    await p.sb.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
  assert.ok(!/courted|"triads"|kingmaker|lastGaps|"drift"|"tier"|swing/i.test(out), "a triad or swing field reached a player or admin view");
});
Then("triads: the player may overhear a pitch only when it is made to them", function () {
  const heard: string[] = [];
  const v = closeVote(4); seamOf(v.p).setOnPlayerEvent((c) => { heard.push(c); return undefined; });
  seamOf(v.p).swingAtVote(v.view);
  assert.equal(heard.filter((c) => /case/.test(c)).length, 0, "an NPC-to-NPC pitch must leave no player-visible event");
});

function snapshotRun(seed: number, triads: boolean): string {
  const v = closeVote(seed); v.p.session.setTriadsEnabled(triads);
  const s = seamOf(v.p);
  runDays(v.p, 6); s.swingAtVote(v.view);
  const voteOf: Record<string, string> = {}; for (const p of v.view.previews) voteOf[p.voter] = p.pick;
  s.triadsAtResult({ evictee: v.nominees[0], voteOf, hoh: v.others[3] });
  return JSON.stringify([s.live.triads ?? null, v.p.session.favorLedger(), [...v.nominees, v.swing, ...v.others].map((a) => [...v.nominees, v.swing, ...v.others].map((b) => (a === b ? 0 : aff(v.p, a, b))))]);
}
Given("a triads season played twice from the same seed", function () { const b = bag(this); b.runs = [snapshotRun(7, true), snapshotRun(7, true)]; b.off = snapshotRun(7, false); });
Then("triads: both runs hold the same drift, pitches and kingmaker in the same order", function () {
  const r = bag(this).runs!; assert.equal(r[0], r[1]); assert.ok(JSON.parse(r[0]!)[0] !== null, "the run kept nothing");
});
Then("triads: with the flag off nothing moves and nothing is kept", function () {
  const off = JSON.parse(bag(this).off!) as [unknown, unknown[], number[][]];
  assert.equal(off[0], null, "the flag off kept a triad record"); assert.equal(off[1].length, 0, "the flag off wrote a favor");
});

Given("a triads season where a swing vote was courted and cast", function () {
  const b = bag(this); const v = closeVote(5); const s = seamOf(v.p);
  runDays(v.p, 8); s.swingAtVote(v.view);
  const voteOf: Record<string, string> = {}; for (const p of v.view.previews) voteOf[p.voter] = p.pick;
  s.triadsAtResult({ evictee: v.nominees[0], voteOf, hoh: v.others[3] });
  b.one = { p: v.p, nominees: v.nominees, swing: v.swing, others: v.others };
});
When("triads: the season is saved and loaded into a fresh session", function () {
  const b = bag(this); const { p } = b.one!;
  b.saved = JSON.parse(JSON.stringify(p.session.snapshot()));
  const fresh = new GameSessionRegistry().sandboxFor(`bdd-triads-fixed`);
  fresh.session.restore(b.saved as never);
  (fresh.session as unknown as { rel: { load(e: unknown): void } }).rel.load(JSON.parse(JSON.stringify((p.seam as unknown as { rel: { serialize(): { edges: unknown } } }).rel.serialize().edges))); // the edges ride the relationship store's own save, as every fold's do
  b.loaded = { sb: fresh, session: fresh.session, seam: fresh.session as never, npcs: p.npcs, seed: p.seed };
});
Then("triads: the loaded session holds the swing history and the drifted bonds the saved one held", function () {
  const b = bag(this); const a = b.one!; const l = b.loaded!;
  assert.deepEqual(seamOf(l).live.triads, seamOf(a.p).live.triads);
  assert.ok((seamOf(l).live.triads?.courted?.length ?? 0) > 0 && (seamOf(l).live.triads?.kingmakers?.length ?? 0) > 0);
  for (const x of a.p.npcs) for (const y of a.p.npcs) if (x !== y) assert.ok(Math.abs(aff(l, x, y) - aff(a.p, x, y)) < 1e-9);
});
