import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import { hashSeed } from "../../src/engine/characterFactory";
import { HOH_COURT, courtPull, thirdPersonImpact, deriveStatus } from "../../src/engine/hohCourt";
import { A, B, C, D, priv, played, setEdge, courtShare, type Boxed } from "../support/hohCourtHelpers";

/** Feature 0173 (Theme 3 slice 11): status, the HOH court, vacuums, ORW-610 and ORW-577. Roles only; every step is status:-prefixed or has its own unique Given. */
type Bag = { sb?: Boxed; other?: Boxed; leader?: string; saved?: string; reloaded?: Boxed; runs?: string[] };
const bag = (w: unknown): Bag => ((w as { st0173?: Bag }).st0173 ??= {});
const ties = (pairs: Array<[string, string, number]>) => (a: string, b: string): number => pairs.find(([x, y]) => (x === a && y === b) || (x === b && y === a))?.[2] ?? 0;
const MEMBERS = [A, B, C, D, "npc:5"];

/** A played house where the first NPC leads: strong two-way bonds to three others and the most wins. */
function leaderHouse(seed = 11): { sb: Boxed; ids: string[] } {
  const sb = played(seed, true, { hours: 6 });
  const s = priv(sb.session);
  const ids = s.house.npcs.map((x) => x.id);
  for (const y of ids.slice(1, 4)) { setEdge(sb.session, ids[0]!, y, { trust: 0.95, affinity: 0.95 }); setEdge(sb.session, y, ids[0]!, { trust: 0.95, affinity: 0.95 }); }
  s.live.resume = { [ids[0]!]: 6 };
  s.live.dayNumber = (s.live.dayNumber ?? 1) + 1;
  s.statusTickNow();
  return { sb, ids };
}

Given("a status season where a houseguest wins comps and keeps strong allies", function () { bag(this).sb = leaderHouse().sb; });
Then("status: the house holds them higher than a houseguest with neither, across seeds", function () {
  for (const seed of [3, 7, 11, 19]) {
    const { sb, ids } = leaderHouse(seed);
    const t = priv(sb.session).statusRead()!.tiers;
    assert.ok(t[ids[0]!]! > t[ids[ids.length - 1]!]!, `seed ${seed}`);
  }
});

Given("a status season with a new HOH", function () { bag(this).sb = played(7, true, { hours: 3 }); });
Then("status: houseguests seek the HOH out more than before, the ones in danger most", function () {
  const none = courtShare({}), calm = courtShare({ court: { pull: courtPull(false), danger: false } }), danger = courtShare({ court: { pull: courtPull(true), danger: true } });
  assert.ok(calm > none && danger > calm * 2, `${none} ${calm} ${danger}`);
  const s = priv(bag(this).sb!.session), hoh = s.house.npcs[0]!.id, other = s.house.npcs[1]!.id;
  s.live.hoh = hoh; s.live.nominees = [other];
  assert.ok((bag(this).sb!.session as unknown as { courtView(o: string, h: string): { danger: boolean } | undefined }).courtView(other, hoh)!.danger);
});

Given("a status season where one houseguest is held highest by their group", function () { const h = leaderHouse(); bag(this).sb = h.sb; bag(this).leader = h.ids[0]; });
Then("status: that houseguest holds lieutenants who follow their lead", function () {
  const st = priv(bag(this).sb!.session).statusRead()!;
  assert.equal(st.leader, bag(this).leader);
  assert.ok(st.lieutenants.length >= HOH_COURT.leaderMinFollowers && st.lieutenants.length <= HOH_COURT.lieutenantMax);
});

Given("a status season where the house's informal leader is evicted", function () {
  const h = leaderHouse(); const s = priv(h.sb.session);
  s.alliances.add("the four", h.ids[0]!, h.ids.slice(0, 4), 1);
  s.statusTickNow();
  s.live.evictionOrder.push(h.ids[0]!);
  const seed = (h.sb.session as unknown as { gameSeed?: number }).gameSeed ?? 0;
  let day = (s.live.dayNumber ?? 1) + 1;
  while ((hashSeed(`${seed}:status-vacuum:${day}`) % 10000) / 10000 >= HOH_COURT.splitChance) day++;
  s.live.dayNumber = day;
  s.statusTickNow();
  bag(this).sb = h.sb; bag(this).leader = h.ids[0];
});
Then("status: their lieutenants compete to lead, and their group may split", function () {
  const st = priv(bag(this).sb!.session).statusRead()!;
  const v = st.history.find((h) => h.kind === "vacuum");
  assert.ok(v && v.who === bag(this).leader);
  assert.ok(st.history.some((h) => h.kind === "split"));
  assert.ok(priv(bag(this).sb!.session).alliances.history().some((h) => h.kind === "left"));
});

Given("a status season where a rising houseguest outwins the informal leader twice", function () { bag(this).sb = undefined; });
Then("status: the house's hold on the leader weakens, and on the challenger strengthens", function () {
  const g = { members: MEMBERS, tie: ties([[A, B, 0.6], [A, C, 0.6], [A, D, 0.6], [B, C, 0.6], [B, D, 0.6], [B, "npc:5", 0.6]]), respect: () => 0.8, hubs: new Set([A, B]), prevLeader: A };
  const before = deriveStatus({ ...g, wins: (id) => (id === A ? 4 : 0) });
  const after = deriveStatus({ ...g, wins: (id) => (id === A ? 4 : id === B ? 6 : 0) });
  assert.ok(after.score.get(A)! <= before.score.get(A)!);
  assert.ok(after.tiers[B]! > before.tiers[B]!);
  assert.notEqual(after.leader, A);
});

Given("a status season with a leader, lieutenants and a court at the HOH room", function () { const h = leaderHouse(21); priv(h.sb.session).live.hoh = h.ids[0]!; bag(this).sb = h.sb; });
Then("status: no player or admin view shows a status figure, a rank, a leader marker or a lieutenant list", async function () {
  const sb = bag(this).sb!;
  const blob = JSON.stringify([await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("getMomentPrompt", {}), await sb.mcp.player.callTool("whereabouts", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {})]).toLowerCase();
  for (const k of ["lieutenant", "pecking", "vacuumsince", "informal leader", "\"status\":{", "hohcourt"]) assert.equal(blob.includes(k), false, k);
});

Given("a status season played twice from the same seed", function () {
  bag(this).runs = [0, 1].map(() => { const { sb } = leaderHouse(13); return JSON.stringify([priv(sb.session).statusRead(), sb.session.snapshot()]); });
});
Then("status: both runs hold the same leaders and vacuums in the same order", function () { assert.equal(bag(this).runs![0], bag(this).runs![1]); });
Then("status: with the flag off a played game keeps no record and a headless game is byte-identical", function () {
  const off = played(7, false, { hours: 6 }); priv(off.session).statusTickNow();
  assert.equal(priv(off.session).statusRead(), undefined);
  const snap = (flag: boolean): string => { const x = new GameSessionRegistry().sandboxFor(`st0173-h-${flag}`); x.session.setHohCourtEnabled(flag); x.session.createCharacter({ playerName: "The Player", seed: 3 }); x.session.advanceGame({}); return JSON.stringify(x.session.snapshot()); };
  assert.equal(snap(true), snap(false));
});

Given("a status season where a leader fell and a new one rose", function () {
  const h = leaderHouse(); const s = priv(h.sb.session);
  s.live.evictionOrder.push(h.ids[0]!); s.live.dayNumber = (s.live.dayNumber ?? 1) + 1; s.statusTickNow();
  bag(this).sb = h.sb;
});
When("status: the season is saved and loaded into a fresh session", function () {
  const b = bag(this); b.saved = JSON.stringify(priv(b.sb!.session).statusRead());
  const fresh = played(99, true); fresh.session.restore(JSON.parse(JSON.stringify(b.sb!.session.snapshot()))); b.reloaded = fresh;
});
Then("status: the loaded session holds the order and its history the saved one held, and a later save never holds less", function () {
  const b = bag(this);
  assert.equal(JSON.stringify(priv(b.reloaded!.session).statusRead()), b.saved);
  const s = priv(b.reloaded!.session), count = s.statusRead()!.count;
  s.live.dayNumber = (s.live.dayNumber ?? 1) + 1; s.statusTickNow();
  assert.ok(s.statusRead()!.count >= count);
  assert.ok(s.statusRead()!.history.length >= Math.min(count, HOH_COURT.historyMax) - 0);
});

Given("a status season where the player is the one in danger", function () { bag(this).sb = played(9, true, { hours: 3 }); });
Then("status: the player is not pitched for automatically, and their own talk to the HOH counts as a pitch", function () {
  const sb = bag(this).sb!, s = priv(sb.session), hoh = s.house.npcs[0]!.id;
  s.live.hoh = hoh; setEdge(sb.session, hoh, "player", { threat: 0.8, trust: 0.9 });
  assert.equal(s.derivePitches(hoh).some((p) => p.from === "player"), false);
  (sb.session as unknown as { notePlayerTalk(w: string[], k: string, n?: string): void }).notePlayerTalk([hoh], "strategy");
  assert.equal(s.derivePitches(hoh).find((p) => p.from === "player")?.protects, "player");
  assert.ok(s.pitchTiltFor("player", hoh) < 0);
});
Then("status: when the player is HOH the houseguests who would lobby come to them as approaches", function () {
  const sb = bag(this).sb!, s = priv(sb.session);
  for (const n of s.house.npcs) setEdge(sb.session, "player", n.id, { threat: 0.7 });
  s.live.hoh = "player"; s.recordLobbyPitches("player");
  const court = Object.values(s.live.goalApproaches ?? {}).filter((g) => g.goalId === "court");
  assert.ok(court.length > 0);
});

Given("a status season where one houseguest campaigns against a third person to a listener", function () { bag(this).sb = played(5, true); });
Then("status: the listener's read of the third person turns by a bounded step, and a lobby for them turns it the other way", function () {
  const s = priv(bag(this).sb!.session), [a, b, c] = s.house.npcs.map((x) => x.id);
  const e0 = { ...s.rel.edge(b!, c!) };
  s.foldThirdPerson({ actor: a, kind: "campaign-against", with: [b], about: c }, b!, 3, 14);
  const e1 = { ...s.rel.edge(b!, c!) };
  assert.ok(e1.threat > e0.threat && e1.threat - e0.threat < 0.08);
  s.foldThirdPerson({ actor: a, kind: "lobby-for", with: [b], about: c }, b!, 4, 14);
  assert.ok(s.rel.edge(b!, c!).threat < e1.threat);
  assert.ok(thirdPersonImpact("lobby-for", 0.5, 0.5)!.affinity > 0);
});

Given("a status season where a houseguest's agenda holds a get-them-out goal", function () {
  const sb = played(5, true, { hours: 3 }); const s = priv(sb.session); const [a, b] = s.house.npcs.map((x) => x.id);
  (sb.session as unknown as { setCampaignsEnabled(on: boolean): void }).setCampaignsEnabled(true);
  s.live.agendas = { [a!]: { goals: [{ id: "g1", owner: a, horizon: "week", kind: "get-them-out", target: b, why: [], test: { kind: "wins" }, commitment: 0.9, status: "active", formedDay: 1, formedWeek: 1 }, { id: "g2", owner: a, horizon: "week", kind: "win-power", why: [], test: { kind: "wins" }, commitment: 0.9, status: "active", formedDay: 1, formedWeek: 1 }] } } as never;
  bag(this).sb = sb; bag(this).leader = a;
});
Then("status: their campaign, their drive and their competition intent follow the goal", function () {
  const s = priv(bag(this).sb!.session), a = bag(this).leader!, [, b, c] = s.house.npcs.map((x) => x.id);
  s.campaignTick();
  assert.ok(s.campaigns.some((x) => x.owners[0] === a && x.goal === "evict" && x.status === "active"));
  const drives = (bag(this).sb!.session as unknown as { drives: Map<string, { motivation: string; target?: string }> }).drives;
  assert.equal(drives.get(a)?.motivation, "target");
  assert.equal(drives.get(a)?.target, s.campaigns.find((x) => x.owners[0] === a)!.target);
  assert.equal(s.deriveCompIntent(a, [a, b!, c!]), "compete");
});
