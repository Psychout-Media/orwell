import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { resolvePending } from "../support/answerPending";
import { buildWorldSnapshot, renderZeitgeist } from "../../src/engine/zeitgeist";
import type { HouseguestCard } from "../../src/ports/GameSession";

// Feature 0062 — the move-in zeitgeist snapshot. The cast moves in carrying ONE frozen, shared picture
// of the real-world moment, recalled all season, coloring BOTH the player's scenes AND off-screen NPC
// life, growing stale as the weeks pass — and FLAVOR ONLY (a third state category: public, shared,
// real-world context — never Vault, never game truth). HARD rule: roles only — no fixture names.

/** Map a string seed LABEL to a stable numeric seed (createCharacter takes a number). */
function seedOf(label: string): number {
  let seed = 0;
  for (let i = 0; i < label.length; i++) seed = (Math.imul(seed, 31) + label.charCodeAt(i)) >>> 0;
  return seed;
}

/**
 * A registry-built fixture, one started season (the production object graph), keyed off the label. Each
 * call builds its OWN isolated registry/orchestrator, so a CONSTANT user id is safe — and it is REQUIRED
 * for the §6 outcome-invariance test: the per-user off-screen-tick RNG is keyed `seed:user`, so the two
 * arms (with vs. without the snapshot) MUST share both seed AND user to differ ONLY by the snapshot.
 */
function wsStart(label: string): { reg: GameSessionRegistry; sb: UserSandbox; orch: Orchestrator; user: string } {
  const seed = seedOf(label);
  const reg = new GameSessionRegistry();
  const orch = new Orchestrator(reg, { now: () => seed }, { seed, turnDriven: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  const user = "player";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { reg, sb, orch, user };
}

/** Advance the live loop `beats` times, resolving any player decision legally (deterministic). */
function drive(sb: UserSandbox, beats: number): void {
  for (let i = 0; i < beats; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => sb.session.submitDecision(req));
    if (v.finished) break;
  }
}

// --- §3 / §10 — seeded, persisted, frozen byte-stable -------------------------------------------

Given("a season started with seed {string} and a world snapshot captured at move-in", function (this: BbWorld, label: string) {
  this.wsFix = wsStart(label);
  this.wsView = this.wsFix.sb.session.worldSnapshotView();
  assert.ok(this.wsView, "no world snapshot was captured at move-in");
});

Then("the world snapshot carries a frozen move-in date", function (this: BbWorld) {
  assert.ok(typeof this.wsView!.capturedFor === "string" && this.wsView!.capturedFor.length > 0, "no frozen move-in marker");
});

Then("the world snapshot survives snapshot and restore byte-identical", function (this: BbWorld) {
  const sb = this.wsFix!.sb;
  const before = JSON.stringify(sb.session.snapshot().worldSnapshot);
  assert.ok(before && before !== "undefined", "the world snapshot was not in the durable snapshot");
  const core = sb.session.snapshot();
  sb.session.restore(core);
  const after = JSON.stringify(sb.session.snapshot().worldSnapshot);
  assert.equal(after, before, "the world snapshot changed across snapshot→restore");
  // And the public projection round-trips byte-identical too.
  assert.equal(JSON.stringify(sb.session.worldSnapshotView()), JSON.stringify(this.wsView), "the world snapshot view changed across restore");
});

Then("the world snapshot never regenerates while the season runs", function (this: BbWorld) {
  const sb = this.wsFix!.sb;
  const before = JSON.stringify(sb.session.worldSnapshotView());
  drive(sb, 12); // run real beats — comps, ceremonies, evictions
  const after = JSON.stringify(sb.session.worldSnapshotView());
  assert.equal(after, before, "the world snapshot drifted as the season ran (it must be FROZEN)");
});

// --- §6 / §10 — the headline guard: FLAVOR ONLY, never game truth -------------------------------

Given("a season started with seed {string} with a world snapshot present", function (this: BbWorld, label: string) {
  this.wsFix = wsStart(label);
  assert.ok(this.wsFix.sb.session.worldSnapshotView(), "no world snapshot present");
});

Given("the same season started with seed {string} with no world snapshot", function (this: BbWorld, label: string) {
  // The §8 ABSENT tier: a present-but-empty snapshot renders nothing and reads as no snapshot — the
  // degraded path. Same seed as the "with" arm, so the deterministic core MUST stay byte-identical.
  this.wsFixB = wsStart(label);
  const sb = this.wsFixB.sb;
  const core = sb.session.snapshot();
  core.worldSnapshot = buildWorldSnapshot({ seed: seedOf(label), capturedFor: "move-in day", source: "absent" });
  sb.session.restore(core);
  // Re-baseline the non-degradation checkpoint to THIS (absent-snapshot) state — establishing a season
  // that simply has no snapshot from here. (Mutating an already-committed FROZEN snapshot would, by
  // design, trip the 0007 freeze guard — that guard working is itself part of the feature.)
  this.wsFixB.orch.seedBaseline(this.wsFixB.user);
  assert.equal(sb.session.worldSnapshotView(), null, "the no-snapshot arm still reads a snapshot");
});

When("both seasons are advanced through a competition, a nomination, and an eviction vote", function (this: BbWorld) {
  drive(this.wsFix!.sb, 14);
  drive(this.wsFixB!.sb, 14);
});

/** The deterministic-core projection (everything the snapshot must NEVER touch), minus the snapshot. */
function coreOutcome(sb: UserSandbox): string {
  const core = sb.session.snapshot();
  return JSON.stringify({
    // Competition/ceremony OUTCOMES: who won, who was nominated, who was evicted, the winner.
    week: core.week, beat: core.live?.beat,
    hoh: core.live?.hoh, nominees: core.live?.nominees, vetoHolder: core.live?.vetoHolder,
    evictionOrder: core.live?.evictionOrder, evictee: core.live?.evictee, winner: core.live?.winner,
    // The eviction-vote ballots (the secret per-voter record).
    voteRecord: core.live?.voteRecord,
    // The relationship FOLDS — the full hidden edge set (trust/affinity/threat) the consequence loop wrote.
    relationships: sb.engine.relationships.serialize(),
    // The soul FOLDS — each houseguest's evolving emotional state + the persisted season arc (0041).
    souls: core.house ? [core.house.player, ...core.house.npcs].map((h) => [h.id, h.soul.emotionalState, h.soul.emotionalHistory]) : [],
  });
}

Then("the competition results are byte-identical between the two seasons", function (this: BbWorld) {
  // One projection captures comp results, votes, and folds — the spec's three Thens share the same
  // proof: the snapshot never reaches the core, so the WHOLE deterministic outcome is byte-identical.
  this.wsOutcomeA = coreOutcome(this.wsFix!.sb);
  this.wsOutcomeB = coreOutcome(this.wsFixB!.sb);
  assert.equal(this.wsOutcomeB, this.wsOutcomeA, "the deterministic outcome differed with vs. without the world snapshot");
});

Then("the eviction votes are byte-identical between the two seasons", function (this: BbWorld) {
  assert.equal(this.wsOutcomeB, this.wsOutcomeA, "the eviction votes differed with vs. without the world snapshot");
});

Then("the relationship and soul folds are byte-identical between the two seasons", function (this: BbWorld) {
  assert.equal(this.wsOutcomeB, this.wsOutcomeA, "the relationship/soul folds differed with vs. without the world snapshot");
});

// --- §5 — reach channel one: the player's moment prompt -----------------------------------------

When("a player moment prompt is built", function (this: BbWorld) {
  // A non-social moment ⇒ the player-channel framing.
  this.wsPrompt = this.wsFix!.sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
});

Then("the moment prompt carries the world the cast moved in with", function (this: BbWorld) {
  assert.match(this.wsPrompt!, /world you all moved in with/i, "the moment prompt carries no world block");
});

Then("the moment prompt states the world is frozen as of the move-in date", function (this: BbWorld) {
  assert.match(this.wsPrompt!, /frozen as of move-in/i, "the moment prompt does not state the world is frozen at move-in");
});

// --- §5 — reach channel two: off-screen NPC-to-NPC life (the C32-beyond delta) -------------------

When("an off-screen society prompt is built for an NPC-to-NPC scene", function (this: BbWorld) {
  // The off-screen channel: the `social` moment carries the NPC-to-NPC framing, and the dedicated
  // projection exposes the same block for an off-screen scene the FE colors.
  this.wsPrompt = this.wsFix!.sb.session.getMomentPrompt({ moment: "social" }).systemPrompt;
  this.wsOffscreen = this.wsFix!.sb.session.worldSnapshotView()!.offscreenPrompt;
});

Then("the off-screen prompt carries the world the cast moved in with", function (this: BbWorld) {
  assert.match(this.wsPrompt!, /world you all moved in with/i, "the social moment prompt carries no world block");
  assert.match(this.wsOffscreen!, /world you all moved in with/i, "the off-screen projection carries no world block");
  // The C32-beyond delta: the off-screen block explicitly colors NPC-to-NPC life.
  assert.match(this.wsOffscreen!, /off-screen life too/i, "the off-screen block does not extend to NPC-to-NPC life");
});

// --- §4 — per-NPC interest filtering (shared baseline, individual color) -------------------------

Given("two active houseguests with different personas", function (this: BbWorld) {
  const house: HouseguestCard[] = this.wsFix!.sb.session.getGameState().house.filter((h) => h.status === "active");
  assert.ok(house.length >= 2, "fewer than two active houseguests");
  // Pick two houseguests whose public persona facets differ (so the emphasis can legitimately diverge).
  const facets = (h: HouseguestCard): string => [h.archetype, h.strategyStyle, h.background, h.vocation, h.demeanor].join("|");
  let a = house[0]!, b = house[1]!;
  outer: for (const h of house) for (const k of house) if (facets(h) !== facets(k)) { a = h; b = k; break outer; }
  this.wsPairA = a; this.wsPairB = b;
});

Then("each houseguest is handed a different slice emphasis of the same world snapshot", function (this: BbWorld) {
  // The per-NPC emphasis is a READ-TIME projection from the PUBLIC persona facets — proved by building
  // each houseguest's persona-refracted block and showing they differ (a different lead slice ordering).
  const sb = this.wsFix!.sb;
  const snap = sb.session.worldSnapshotView()!;
  // Re-derive the emphasis through the public engine helper (the same the prompt uses), on each persona.
  const emphasisLine = (h: HouseguestCard): string =>
    // The slice emphasis is reflected in the persona-refracted block's lead bullet ordering.
    renderZeitgeist(
      { capturedFor: snap.capturedFor, capturedAt: "x", lagDays: 7, source: "model-framed", slices: snap.slices },
      { week: 1, persona: h },
    );
  const ea = emphasisLine(this.wsPairA!);
  const eb = emphasisLine(this.wsPairB!);
  assert.notEqual(ea, eb, "two different personas drew the IDENTICAL slice emphasis (no individual color)");
});

Then("the world snapshot itself remains one byte-stable artifact", function (this: BbWorld) {
  // The emphasis is read-time only — the underlying snapshot is ONE shared artifact, unchanged by reads.
  const sb = this.wsFix!.sb;
  const a = JSON.stringify(sb.session.worldSnapshotView()!.slices);
  // A couple more reads through different personas must not mutate it.
  sb.session.getMomentPrompt({ moment: "social" });
  sb.session.getMomentPrompt({ moment: "premiere" });
  const b = JSON.stringify(sb.session.worldSnapshotView()!.slices);
  assert.equal(b, a, "the shared world snapshot mutated under per-NPC reads (it must stay one byte-stable artifact)");
});

// --- §7 — the played freeze-drift: increasingly out of the loop ---------------------------------

When("the season has run several weeks since move-in", function (this: BbWorld) {
  // Drive real beats until the week advances a few HOH reigns past move-in (week 1).
  const sb = this.wsFix!.sb;
  for (let i = 0; i < 200 && sb.session.gameStatus().week < 4; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => sb.session.submitDecision(req));
    if (v.finished) break;
  }
  this.wsWeek = sb.session.gameStatus().week;
  this.wsPrompt = sb.session.getMomentPrompt({}).systemPrompt;
});

Then("the moment prompt carries the elapsed in-house duration", function (this: BbWorld) {
  assert.ok((this.wsWeek ?? 1) >= 2, `the season did not advance past move-in (week ${this.wsWeek})`);
  assert.match(this.wsPrompt!, /sealed in for about \d+ week/i, "the prompt does not carry the elapsed in-house duration");
});

Then("the moment prompt instructs that anything after the move-in date is unknowable to the house", function (this: BbWorld) {
  assert.match(this.wsPrompt!, /unknowable to the whole house/i, "the prompt does not instruct that post-move-in events are unknowable");
});

// --- §8 / §9 — fail-soft: no provider, never break ----------------------------------------------

Given("a season started with seed {string} and no search provider configured", function (this: BbWorld, label: string) {
  // No FE search provider is ever wired in tests — the engine seeds the deterministic `model-framed`
  // fallback at creation (§8). That IS the "no provider" path: a snapshot framed from the model's own
  // knowledge, never a live search.
  this.wsFix = wsStart(label);
});

Then("the world snapshot is seeded from framed knowledge", function (this: BbWorld) {
  // ORW-286 item 9: the old step passed whether the snapshot was present or absent (`if (view) ...`). With no search provider the deterministic model-framed
  // snapshot MUST stand (spec 0062 sections 8 and 11): assert it is there and has real content.
  const view = this.wsFix!.sb.session.worldSnapshotView();
  assert.ok(view, "a no-provider season has no world snapshot at all (the model-framed fallback did not stand)");
  assert.equal(view!.source, "model-framed", "a no-provider snapshot was not the model-framed fallback");
  assert.ok(JSON.stringify(view).length > 40, "the model-framed snapshot is empty");
});

Then("an absent world snapshot round-trips as absent", function (this: BbWorld) {
  // Force the ABSENT tier and prove it round-trips as absent (the §8 skip).
  const sb = this.wsFix!.sb;
  const core = sb.session.snapshot();
  core.worldSnapshot = buildWorldSnapshot({ seed: 1, capturedFor: "move-in day", source: "absent" });
  sb.session.restore(core);
  // Re-baseline to the absent state (so the following "advances unchanged" step plays from here without
  // the FROZEN-snapshot guard firing on the model-framed→absent swap — that guard is correct).
  this.wsFix!.orch.seedBaseline(this.wsFix!.user);
  assert.equal(sb.session.worldSnapshotView(), null, "an absent snapshot did not read as absent");
  const core2 = sb.session.snapshot();
  sb.session.restore(core2);
  assert.equal(sb.session.worldSnapshotView(), null, "an absent snapshot did not round-trip as absent");
});

Then("the season advances unchanged with no world snapshot present", function (this: BbWorld) {
  // With the snapshot absent, the game still runs — and the moment prompt carries no world block.
  const sb = this.wsFix!.sb;
  const prompt = sb.session.getMomentPrompt({}).systemPrompt;
  assert.doesNotMatch(prompt, /world you all moved in with/i, "an absent snapshot still injected a world block");
  drive(sb, 10);
  assert.ok(sb.session.gameStatus().week >= 1, "the season did not advance with no world snapshot");
});
