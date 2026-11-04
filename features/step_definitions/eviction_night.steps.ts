import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, EvictionView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { juryLean } from "../../src/engine/jury";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { PLAYER, npc } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";
import { liveGameAtPlayerPending, cloneSnapshot, resumeFrom, edgeIn, freshScratch } from "../support/liveEvictionNight";

// Feature 0047 — eviction night live. Driven through the live MCP seam (createCharacter →
// advanceGame / submitDecision). HARD rule: roles only — no names.

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): AdvanceView {
  // `self-evict` is intentionally never auto-answered; the eviction-night scenarios never raise it.
  return resolvePending(p, (req) => s.submitDecision(req)) as AdvanceView;
}

/** Drive a fresh game to the FIRST staging eviction (stage "votes"); collect the advance views from there. */
/** Ballots the surface showed on the read just BEFORE the step that staged the eviction (PO ruling 2026-11-04: must be 0 — no ballot before the reveal / the player's card). */
let preRevealBallots = -1;
function driveToEvictionStaging(s: GameSessionAdapter): AdvanceView {
  for (let i = 0; i < 3000; i++) {
    preRevealBallots = s.getGameState().eviction?.votesRevealed.length ?? 0;
    const v = s.advanceGame();
    if (v.eviction?.stage === "votes") return v;
    if (v.pending) {
      preRevealBallots = s.getGameState().eviction?.votesRevealed.length ?? 0;
      const sv = resolve(s, v.pending);
      if (sv.eviction?.stage === "votes") return sv;
    }
    if (v.finished) throw new Error("the game finished before an eviction staged");
  }
  throw new Error("no eviction staged within bound");
}

let enUsers = 0;
function newGame(w: BbWorld, seed: number): GameSessionAdapter {
  const reg = new GameSessionRegistry();
  const user = `en${enUsers++}`;
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "P", seed });
  w.enRegistry = reg; w.enUser = user; w.enSandbox = sb;
  return sb.session;
}

const revealOrder = (views: AdvanceView[]): string =>
  views.filter((v) => v.event?.beat === "eviction-reveal").map((v) => v.event!.content).join("|");

// --- Scenario: votes revealed one at a time, deterministic order -----------------

Given("a started game at an eviction with a decided vote", function (this: BbWorld) {
  const s = newGame(this, 2);
  this.enViews = [driveToEvictionStaging(s)];
  this.enPreReveal = preRevealBallots;
  // T2: capture the ELECTORATE size from the engine's own staged state — the honest bound the
  // revealed-ballot assertions are measured against (never derived from the surface under test).
  this.enElectorate = s.snapshot().live!.eviction!.revealOrder.length;
});

When("the eviction is advanced through the seam", function (this: BbWorld) {
  const s = this.enSandbox!.session;
  // Step the reveal to the end of the votes stage, collecting each advance view.
  for (let i = 0; i < 60 && (this.enViews![this.enViews!.length - 1].eviction?.stage === "votes"); i++) {
    const v = s.advanceGame();
    this.enViews!.push(v);
    if (v.pending) resolve(s, v.pending); // a player-HOH tie-break, if any
  }
});

Then("the eviction votes are revealed in ONE round", function (this: BbWorld) {
  // PO ruling (Ryne, 2026-11-04): the vote reveal is ALL IN ONE TURN. The single reveal advance reads EVERY ballot (the whole electorate) at once; there is no
  // partial state to see. (Supersedes the 2026-06-27 batched-rounds shape; the seeded order, anonymity and the engine-decided tally are unchanged.)
  const electorate = this.enElectorate!;
  const reveals = this.enViews!.filter((v) => v.event?.beat === "eviction-reveal");
  assert.equal(reveals.length, 1, "exactly one reveal beat");
  const counts = this.enViews!
    .filter((v) => v.eviction && v.eviction.stage === "votes")
    .map((v) => v.eviction!.votesRevealed.length);
  assert.ok(counts.includes(electorate), "that one reveal shows every ballot of the electorate");
  assert.ok(counts.every((c) => c === 0 || c === electorate), "no view ever shows a partial reveal");
});

Then("the reveal order is the same for the same seed", function (this: BbWorld) {
  this.enRevealOrderA = revealOrder(this.enViews!);
  const s2 = newGame(this, 2);
  const views: AdvanceView[] = [driveToEvictionStaging(s2)];
  for (let i = 0; i < 60 && (views[views.length - 1].eviction?.stage === "votes"); i++) {
    const v = s2.advanceGame();
    views.push(v);
    if (v.pending) resolve(s2, v.pending);
  }
  assert.equal(revealOrder(views), this.enRevealOrderA, "same seed ⇒ same reveal order");
});

Then("the surface shows no ballot before the reveal and every ballot, naming only nominees, after it", function (this: BbWorld) {
  // T2: honest, ELECTORATE-derived bounds. Before the reveal advance the surface shows NO ballot; the reveal view shows exactly the electorate's ballots.
  const electorate = this.enElectorate!;
  assert.ok(electorate >= 2, "a real electorate");
  const staging = this.enViews!.filter((v) => v.eviction?.stage === "votes");
  assert.equal(this.enPreReveal, 0, "before the reveal (incl. while the player's card is open): no ballot shown");
  assert.equal(staging.length, 1, "exactly one view in the votes stage — there is no partial reveal to observe");
  assert.equal(staging[0]!.eviction!.votesRevealed.length, electorate, "the reveal shows every ballot");
  for (const v of staging) {
    for (const r of v.eviction!.votesRevealed) {
      assert.ok([v.eviction!.nominees[0]!.id, v.eviction!.nominees[1]!.id].includes(r.votedFor.id), "a revealed ballot names a nominee");
    }
  }
});

// --- Scenario: the evictee is not knowable before the last vote ------------------

Given("an eviction before the result has landed", function (this: BbWorld) {
  const s = newGame(this, 2);
  const first = driveToEvictionStaging(s);
  this.enViews = [first]; // the single reveal beat has read every ballot; the RESULT has not landed yet
});

When("the eviction surface is read before the result", function (this: BbWorld) {
  this.enSentinel = "SENTINEL-0047-bdd-eviction";
  this.enSandbox!.engine.events.record({
    id: "hidden:0047-bdd", ts: 10_000_003, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: this.enSentinel,
  });
  // Read only (no advance - that would land the result): the reveal view + the live state.
  this.lastOutput = JSON.stringify(this.enViews![this.enViews!.length - 1]) + "\n" + JSON.stringify(this.enSandbox!.session.getGameState());
});

Then("it shows the whole anonymized ballot list and no tally", function (this: BbWorld) {
  // PO ruling 2026-11-04: the one reveal reads EVERY ballot. T2: no self-guarding `if` — the Given staged exactly that BY CONSTRUCTION.
  const view = this.enViews![this.enViews!.length - 1]!;
  const ev: EvictionView | null | undefined = view.eviction;
  assert.ok(ev && ev.stage === "votes", "between the reveal and the result, by construction");
  const electorate = this.enSandbox!.session.snapshot().live!.eviction!.revealOrder.length;
  assert.equal(ev.votesRevealed.length, electorate, "every ballot of the electorate is shown (electorate-derived bound)");
  assert.ok(!Object.keys(ev).includes("tally"), "no tally field");
  // E12: secret ballots — no entry carries a voter; the surface holds no attribution at all.
  for (const r of ev.votesRevealed) assert.deepEqual(Object.keys(r), ["votedFor"]);
  assert.ok(!JSON.stringify(view).includes('"voter"'), "no voter attribution on the surface");
});

Then("it does not name the evictee until the result beat lands", function (this: BbWorld) {
  // Before the result beat, the projection has no evictee field, and the house roster still lists everyone as active
  // (no one is marked evicted before the result lands).
  const view = this.enViews![this.enViews!.length - 1];
  assert.ok(!(view.eviction && Object.keys(view.eviction).includes("evictee")), "EvictionView never names the evictee");
});

Then("no Vault sentinel value appears on the eviction surface", function (this: BbWorld) {
  assert.ok(!this.lastOutput.includes(this.enSentinel!), "no Vault sentinel crosses onto the eviction surface");
});

// --- Scenario: vote secrecy (E12 + T2) --------------------------------------------

Then("every revealed ballot is anonymized", function (this: BbWorld) {
  // E12: eviction votes are SECRET BALLOTS — every reveal beat reads "a vote to evict …" and the
  // projection's entries carry the nominee only; no voter attribution exists on any surface.
  const reveals = this.enViews!.filter((v) => v.event?.beat === "eviction-reveal");
  assert.equal(reveals.length, 1, "ballots were revealed - in the one reveal beat");
  // The reveal is BATCHED (live-verify 2026-06-27): a round reads "a vote to evict X" (one ballot) or
  // "N votes to evict X" (a batch) — anonymized either way (the nominee, never the voter).
  for (const v of reveals) assert.match(v.event!.content, /(^|, )(a|\d+) votes? to evict /, "the ballot reads anonymized");
  for (const v of this.enViews!) {
    if (!v.eviction) continue;
    for (const r of v.eviction.votesRevealed) assert.deepEqual(Object.keys(r), ["votedFor"]);
    assert.ok(!JSON.stringify(v.eviction).includes('"voter"'), "no voter key on the eviction surface");
  }
});

Then("the post-season retrospective unseals the season's ballots", function (this: BbWorld) {
  const s = this.enSandbox!.session;
  // Sealed while the season lives (0048's structural gate).
  assert.equal(s.seasonRetrospective(), null, "sealed while the season lives");
  // Play the season out (first legal option per pending), then unseal.
  for (let i = 0; i < 5000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (v.finished) break;
  }
  const retro = s.seasonRetrospective();
  assert.ok(retro, "the finished season unseals");
  assert.ok(retro!.evictionVotes && retro!.evictionVotes.length > 0, "the weekly ballots are unsealed");
  for (const wk of retro!.evictionVotes!) {
    assert.ok(wk.votes.length > 0, "each unsealed week carries its ballots");
    for (const b of wk.votes) assert.ok(b.voter.name.length > 0, "the unsealed ballot names its voter");
  }
});

// --- Scenario: the evicted houseguest gets a goodbye beat ------------------------

Given("an eviction whose result has landed", function (this: BbWorld) {
  const s = newGame(this, 2);
  driveToEvictionStaging(s);
  this.enViews = [];
  // Drive to the end of the votes stage (the result lands; the goodbye stage opens).
  for (let i = 0; i < 60; i++) {
    const v = s.advanceGame();
    this.enViews.push(v);
    if (v.pending) resolve(s, v.pending);
    if (v.eviction?.stage === "goodbye" || v.event?.beat === "eviction") break;
  }
});

When("the staging continues", function (this: BbWorld) {
  const s = this.enSandbox!.session;
  for (let i = 0; i < 60; i++) {
    const v = s.advanceGame();
    this.enViews!.push(v);
    if (v.pending) resolve(s, v.pending);
    if (v.event?.beat === "eviction-result") break;
  }
});

Then("an evictee goodbye beat occurs", function (this: BbWorld) {
  assert.ok(this.enViews!.some((v) => v.event?.beat === "eviction-goodbye"), "a goodbye beat was surfaced");
});

Then("goodbye messages from the house are recorded", function (this: BbWorld) {
  const goodbyes = this.enSandbox!.engine.events.queryAll().filter((e) => /goodbye message/.test(e.content));
  assert.ok(goodbyes.length > 0, "goodbye messages are recorded as events");
});

// --- Scenario: a warm vs a cold goodbye move the jury differently ----------------
// AMEND 0047 (2026-11-03): this used to call `juryLean`/`goodbyeMannerFor` directly after an EMPTY When. It now plays two
// same-seed live games from one shared snapshot taken AT the player's goodbye pending - one real warm goodbye, one real cold
// one, each submitted through `submitDecision` - and reads the evictee's hidden lean toward the player from the live state.

Given("the same live evictee about to hear the player's goodbye", function (this: BbWorld) {
  const n = freshScratch();
  const found = liveGameAtPlayerPending("goodbye-message");
  n.game = found.game; n.pending = found.pending;
  n.snap = cloneSnapshot(found.game);
  n.facts.evictee = found.pending.evictee!.id;
  this.night = n;
});

When("the player sends a warm goodbye in one game and a cold one in a same-seed game", function (this: BbWorld) {
  const n = this.night!;
  for (const tone of ["warm", "cold"] as const) {
    const g = resumeFrom(n.snap!, n.game!.seed, `goodbye-${tone}`);
    // The restored game stands at the very same decision (same seed, same state) before the player chooses.
    const standing = g.session.advanceGame();
    assert.equal(standing.pending?.kind, "goodbye-message");
    assert.equal(standing.pending?.evictee?.id, n.facts.evictee);
    const submitted = g.session.submitDecision({ kind: "goodbye-message", vote: tone });
    const snap = cloneSnapshot(g); // the hidden state right after the goodbye lands
    const views: AdvanceView[] = [];
    for (let i = 0; i < 6; i++) {
      const v = g.session.advanceGame();
      views.push(v);
      if (v.event?.beat === "eviction-result") break;
    }
    assert.equal(views[views.length - 1]!.event?.beat, "eviction-result", `the ${tone} night reaches its result`);
    n.branches[tone] = { views, submitted, snap, stateJson: JSON.stringify(g.session.getGameState()) };
  }
});

/** The evictee's hidden lean toward the sender, from the live state exactly as the finale reads it (relationship + grudge cooling + recorded manner). */
function leanTowardPlayer(snap: SessionSnapshot, evictee: string): number {
  const e = edgeIn(snap, evictee as never, PLAYER);
  const grudge = snap.live?.juryGrudge?.[evictee as never]?.[PLAYER] ?? 0;
  const cool = (x: number): number => Math.max(0, Math.min(1, x - grudge));
  const manner = snap.live?.mannerByEvictee?.[evictee as never]?.[PLAYER];
  assert.ok(manner, "the evictee holds a recorded manner toward the player after the goodbye");
  return juryLean(
    { trust: cool(e.trust), affinity: cool(e.affinity), threat: e.threat, reliability: (e.reliability ?? RELATIONSHIP_CONSTANTS.baseline.reliability) - RELATIONSHIP_CONSTANTS.baseline.reliability },
    manner,
  );
}

Then("the evictee's hidden lean toward the player is measurably more favorable after the warm one", function (this: BbWorld) {
  const n = this.night!;
  const evictee = n.facts.evictee as string;
  const warm = n.branches.warm!.snap;
  const cold = n.branches.cold!.snap;
  assert.equal(warm.live!.mannerByEvictee![evictee as never]![PLAYER]!.goodbye, "warm", "the warm goodbye is on file");
  assert.equal(cold.live!.mannerByEvictee![evictee as never]![PLAYER]!.goodbye, "cold", "the cold goodbye is on file");
  // Isolate the cause: the goodbye moves ONLY the recorded manner - every relationship edge is identical across the two games.
  assert.deepEqual(warm.relationships, cold.relationships, "the two games differ in nothing but the goodbye tone");
  const warmLean = leanTowardPlayer(warm, evictee);
  const coldLean = leanTowardPlayer(cold, evictee);
  assert.ok(warmLean - coldLean > 0.01, `a warm send-off lifts the juror lean measurably above a cold one (warm ${warmLean}, cold ${coldLean})`);
});

Then("nothing the player can see tells the two games apart beyond the tone they chose", function (this: BbWorld) {
  const n = this.night!;
  const warm = n.branches.warm!;
  const cold = n.branches.cold!;
  // The rest of the night plays out identically on every player-facing view, and the lean never rides a view.
  assert.equal(JSON.stringify(warm.views), JSON.stringify(cold.views), "the interview and result views are identical either way");
  const mask = (j: string): string => j.replace(/\b(warm|cold)\b/g, "TONE");
  assert.equal(mask(JSON.stringify(warm.submitted)), mask(JSON.stringify(cold.submitted)), "the goodbye beat differs only by the tone the player picked");
  assert.equal(mask(warm.stateJson), mask(cold.stateJson), "the public game state differs only by the tone the player picked");
  for (const b of [warm, cold]) {
    assert.ok(!/"[^"]*(lean|manner|grudge)[^"]*"\s*:|"goodbye"\s*:/i.test(JSON.stringify(b.views) + b.stateJson), "no hidden lean or manner crosses to the player");
  }
});

// --- Scenario: the staging runs through the seam and survives a restart ----------

Given("an eviction staged through the advance seam", function (this: BbWorld) {
  const s = newGame(this, 2);
  driveToEvictionStaging(s); // the single reveal beat has read every ballot; the result has not landed yet
});

When("the engine restarts between the reveal and the result", function (this: BbWorld) {
  const user = this.enUser!;
  const snap = this.enRegistry!.snapshot(user);
  const reg2 = new GameSessionRegistry();
  reg2.restore(user, snap);
  const resumed = reg2.sandboxFor(user).session;
  // Finish the eviction from the restored state; record the engine-decided evictee.
  let evictee = "";
  for (let i = 0; i < 200; i++) {
    const v = resumed.advanceGame();
    if (v.event?.beat === "eviction") evictee = v.event.content;
    if (v.pending) resolve(resumed, v.pending);
    if (v.event?.beat === "eviction-result" || v.finished) break;
  }
  this.enResumedEvictee = evictee;
  // Finish the ORIGINAL too, for comparison.
  let origEvictee = "";
  const orig = this.enSandbox!.session;
  for (let i = 0; i < 200; i++) {
    const v = orig.advanceGame();
    if (v.event?.beat === "eviction") origEvictee = v.event.content;
    if (v.pending) resolve(orig, v.pending);
    if (v.event?.beat === "eviction-result" || v.finished) break;
  }
  this.enOriginalEvictee = origEvictee;
});

Then("the eviction resumes from where it left off", function (this: BbWorld) {
  assert.ok(this.enResumedEvictee!.length > 0, "the restored game finished the eviction");
  assert.equal(this.enResumedEvictee, this.enOriginalEvictee, "the resumed eviction reaches the same result");
});
