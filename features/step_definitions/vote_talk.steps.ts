import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { SpokenClaim } from "../../src/engine/spokenClaims";
import { VOTE_TALK } from "../../src/engine/voteTalk";
import { resolvePending } from "../support/answerPending";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { playMixGame, mixShares } from "../../tests/support/houseMixDriver";

/**
 * Feature 0154, scenarios 6-8 (theme 2 slice 5b, ORW-330): lying about your vote. Seasons are played through the REAL adapter; the vote claims
 * an eviction produces are read from the engine-only claim log (a test seam). Scenarios 1-5 (the catch) are slice 5a's steps. Roles only.
 */
type Batch = { week: number; claims: SpokenClaim[] };
type World = { seasons: Array<{ s: GameSessionAdapter; batches: Batch[]; views: string[] }>; mix?: { w1: ReturnType<typeof mixShares>; late: ReturnType<typeof mixShares> } };
const w = (x: unknown): World => ((x as { voteTalk?: World }).voteTalk ??= { seasons: [] });
const live = (s: GameSessionAdapter) => (s as unknown as { live?: { claims?: { items: SpokenClaim[] }; voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }> } }).live;
const SEEDS = [3, 5, 8, 11];
let n = 0;

function playSeason(seed: number) {
  const reg = new GameSessionRegistry();
  const user = `vote-talk-${n++}`;
  const sb = reg.sandboxFor(user);
  const orch = new Orchestrator(reg, new FakeClock(), { seed });
  const s = sb.session;
  s.setNpcBeliefsEnabled(true);
  s.setVoteTalkEnabled(true);
  s.createCharacter({ playerName: "The Player", seed });
  const out = { s, batches: [] as Batch[], views: [] as string[] };
  let seen = 0, evictions = 0;
  for (let i = 0; i < 500 && evictions < 6; i++) {
    const v = s.advanceGame();
    out.views.push(JSON.stringify(v));
    if (v.pending) resolvePending(v.pending, (req) => s.submitDecision(req));
    const rec = live(s)?.voteRecord ?? [];
    if (rec.length > evictions) {
      const items = live(s)?.claims?.items ?? [];
      // every claim made inside this advanceGame came from the vote talk (house-life speech is told in the off-screen tick below, after `seen` is read)
      out.batches.push({ week: rec[rec.length - 1]!.week, claims: items.slice(seen) });
      evictions = rec.length;
    }
    if (v.finished) break;
    orch.advance(user, "offscreen-tick");
    seen = live(s)?.claims?.items.length ?? 0;
  }
  out.views.push(JSON.stringify(s.gameStatus()));
  return out;
}

When("an eviction is over and houseguests tell each other how they voted", function () {
  const world = w(this);
  for (const seed of SEEDS) world.seasons.push(playSeason(seed));
  const told = world.seasons.flatMap((x) => x.batches.flatMap((b) => b.claims));
  assert.ok(told.length > 0, "no one told anyone how they voted");
  for (const c of told) assert.equal(c.kind, "voted-to-keep");
});

Then("some of what is told is true and some is a lie, decided by the engine", function () {
  const told = w(this).seasons.flatMap((x) => x.batches.flatMap((b) => b.claims));
  assert.ok(told.some((c) => c.isTrue), "every vote claim was a lie");
  assert.ok(told.some((c) => !c.isTrue), "every vote claim was true");
  // the cap: one telling per speaker per eviction
  for (const x of w(this).seasons) for (const b of x.batches) {
    const per = new Map<string, number>();
    for (const c of b.claims) per.set(c.speaker, (per.get(c.speaker) ?? 0) + 1);
    for (const [who, k] of per) assert.ok(k <= VOTE_TALK.maxPerSpeaker, `${who} told ${k} vote claims in one eviction`);
  }
  // the engine's truth: a claim is true exactly when the speaker's real ballot was not against the nominee they say they kept
  for (const x of w(this).seasons) {
    const rec = live(x.s)!.voteRecord!;
    for (const b of x.batches) for (const c of b.claims) {
      const r = rec.find((q) => q.week === b.week)!;
      assert.equal(c.isTrue, r.voteOf[c.speaker] !== c.object, "a vote claim's truth disagrees with the real ballot");
    }
  }
});

Then("a lie the public count rules out is caught, and one it does not is believed", function () {
  const world = w(this);
  const listenerBelieves = (x: World["seasons"][number], c: SpokenClaim) =>
    ((x.s as unknown as { live: { beliefs?: Record<string, Array<{ id: string; refuted?: boolean }>> } }).live.beliefs?.[c.listener] ?? []).find((b) => b.id.endsWith(`|${c.id}`));
  const told = world.seasons.flatMap((x) => x.batches.flatMap((b) => b.claims.map((c) => ({ x, c }))));
  // believed: a vote claim the count does not rule out is held by its listener
  assert.ok(told.some(({ x, c }) => listenerBelieves(x, c) && !listenerBelieves(x, c)!.refuted), "no vote claim is held by its listener");
  // caught: needs slice 5a's catch (the adapter's `catchLie`); until that branch is merged this half stays pending
  const catcher = (world.seasons[0]!.s as unknown as { catchLie?: unknown }).catchLie;
  if (typeof catcher !== "function") return "pending";
  return "pending"; // MERGE WITH 5a: call catchLie on a lie the public count rules out (a unanimous count) and assert the claim-planted belief is refuted
});

// ---- scenario 7: no ballot ever leaves ----
When("houseguests claim how they voted and lies about votes are caught", function () {
  const world = w(this);
  if (world.seasons.length === 0) for (const seed of SEEDS.slice(0, 2)) world.seasons.push(playSeason(seed));
});

Then("no view shows any houseguest's actual ballot before the retrospective", function () {
  for (const x of w(this).seasons) {
    const rec = live(x.s)!.voteRecord ?? [];
    assert.ok(rec.length > 0, "the season held no eviction");
    const shown = [...x.views, JSON.stringify(x.s.claimsThePlayerHeard())].join("\n");
    assert.ok(!/voteRecord|voteOf|"ballot/i.test(shown), "a view carries a ballot field");
    // the claims themselves carry no ballot
    for (const c of live(x.s)?.claims?.items ?? []) for (const k of Object.keys(c)) assert.ok(!/ballot|voteOf|voteRecord/i.test(k), `a claim carries ${k}`);
    // no real per-voter vote shows up as speaker+voter+evictee in any player view
    for (const r of rec) for (const [voter, target] of Object.entries(r.voteOf)) {
      assert.ok(!shown.includes(`"${voter}":"${target}"`), "a real ballot pair is in a player view");
    }
  }
});

Then("the narrator is handed nothing about a caught lie it was not present for", function () {
  for (const x of w(this).seasons) {
    assert.deepEqual(x.s.claimsThePlayerHeard().filter((h) => h.kind === "voted-to-keep" && h.speaker !== PLAYER && !live(x.s)!.claims!.items.some((c) => c.listener === PLAYER)), [], "the narrator was handed a vote claim told to someone else");
    const shown = x.views.join("\n");
    assert.ok(!/lied-to-me|isTrue|"intent"/.test(shown), "a view carries a lie or its truth");
  }
});

// ---- scenario 8: neutrality of the house mix ----
When("seeded seasons play with caught lies and vote claims on", { timeout: 900_000 }, async function () {
  process.env.ORWELL_VOTE_TALK = "1";
  const week1 = [];
  for (const seed of [3, 5]) week1.push(...(await playMixGame(seed, 360)).scenes);
  const late = [];
  for (const seed of [1, 2, 3, 4, 5]) late.push(...(await playMixGame(seed, 450, { advanceEvery: 4 })).scenes.filter((s) => s.msg >= 250));
  w(this).mix = { w1: mixShares(week1), late: mixShares(late) };
});

Then("the week-one house mix stays within the agreed reference", function () {
  const AGREED = { bonding: 44, strategy: 26, gossip: 19, conflict: 4 } as const;
  const m = w(this).mix!.w1;
  for (const k of Object.keys(AGREED) as Array<keyof typeof AGREED>) assert.ok(Math.abs(m[k] - AGREED[k]) <= 5, `${k} is ${m[k].toFixed(1)} against ${AGREED[k]}`);
});

Then("the late-game guard stays green", function () {
  const m = w(this).mix!.late;
  assert.ok(m.gossip <= 60 && m.bonding >= 10 && m.strategy <= 75 && m.conflict <= 30, `late mix ${JSON.stringify(m)}`);
});
