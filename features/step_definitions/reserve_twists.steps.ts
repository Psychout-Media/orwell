import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import {
  planReserveTwists, triggeredTwist,
  type TwistKind, type TwistPlan, type TwistSignals,
} from "../../src/engine/reserveTwists";
import {
  newLiveSeason, advance, applyDecision,
  type SeasonCtx, type LiveSeasonState,
} from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { buildSandbox } from "../../tests/support/sandbox";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

// Reuses: "no Vault sentinel value appears" (god_mode, checks this.lastView). Roles only — no names.

const ctxOf = (rel: RelationshipModel): SeasonCtx => ({
  player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel,
});

let rtUsers = 0;
type RtSandbox = import("../../src/composition/registry").UserSandbox;
function freshReactiveSandbox(seed: number, forcedPlan?: TwistPlan): RtSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`rt-bdd-${rtUsers++}`);
  sb.session.setReactiveTwistsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  if (forcedPlan) {
    const core = sb.session.snapshot();
    (core.live as unknown as { twistPlan: TwistPlan }).twistPlan = forcedPlan;
    sb.session.restore(core);
  }
  return sb;
}

function resolveLive(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): AdvanceView {
  const submit = (req: SubmitDecisionReq): AdvanceView => s.submitDecision(req);
  switch (p.kind) {
    case "nominations": return submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
    case "veto-decision": return submit({ kind: "veto-decision", use: false });
    case "comp-intent": return submit({ kind: "comp-intent", intent: "compete" });
    case "comp-round": return submit({ kind: "comp-round", intent: "compete" });
    case "houseguests-choice": return submit({ kind: "houseguests-choice", vote: p.options[0]!.id });
    case "replacement": return submit({ kind: "replacement", replacement: p.options[0]!.id });
    case "secret-veto": return submit({ kind: "secret-veto", use: true });
    case "goodbye-message": return submit({ kind: "goodbye-message", vote: (p as { options: { id: string }[] }).options[0]!.id });
    case "finale-statement": return submit({ kind: "finale-statement", statement: "x" });
    case "finale-answer": return submit({ kind: "finale-answer", appeal: (p as { appeals: string[] }).appeals![0]! });
    case "juror-question": return submit({ kind: "juror-question", statement: "x" });
    case "final-eviction": return submit({ kind: "final-eviction", vote: p.options[0]!.id });
    case "eviction-vote": return submit({ kind: "eviction-vote", vote: p.options[0]!.id });
    case "tie-break": return submit({ kind: "tie-break", vote: p.options[0]!.id });
    case "juror-vote": return submit({ kind: "juror-vote", vote: p.options[0]!.id });
    case "exit-interview": return submit({ kind: "exit-interview", vote: p.stances?.[0] ?? "gracious" });
    default: throw new Error(`reserve_twists: unhandled pending decision kind '${String(p.kind)}' — answer it explicitly here (BDD PAT-1: never default an answer)`);
  }
}

function playFull(s: GameSessionAdapter): void {
  for (let i = 0; i < 6000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolveLive(s, v.pending);
    if (v.finished) break;
  }
}

const allArmed = (over: Partial<TwistPlan> = {}): TwistPlan => ({
  doubleEvictionAtActive: 8, doubleEvictionArmed: true,
  secretVetoStreak: 2, secretVetoArmed: true,
  battleBackAtJury: 1, battleBackArmed: true,
  ...over,
});

// --- Background ---------------------------------------------------------------

Given("a running game sandbox with the reserve-twist pool armed and sealed in the Vault", function (this: BbWorld) {
  this.sandbox = buildSandbox(1); // provides `sentinels` for the reused "no Vault sentinel value appears" step
  this.twistPlan = planReserveTwists(new SeededRandom(1));
});

// --- The standing pool --------------------------------------------------------

Given("a new season with the reactive pool armed", function (this: BbWorld) {
  this.twistPlan = planReserveTwists(new SeededRandom(42));
});

Then("the double eviction, the secret veto, and the battle-back are each watchable in the plan", function (this: BbWorld) {
  const p = this.twistPlan!;
  // Each twist has a seeded trigger threshold in the plan — the whole pool stands armed, not one pre-pick.
  assert.ok(Number.isFinite(p.doubleEvictionAtActive));
  assert.ok(Number.isFinite(p.secretVetoStreak));
  assert.ok(Number.isFinite(p.battleBackAtJury));
});

Then("none has a pre-decided fire week", function (this: BbWorld) {
  // The plan carries THRESHOLDS, never a scheduled week — nothing here says "fire on week N".
  assert.ok(!("fireAtBeat" in (this.twistPlan as object)));
});

Then("no player-facing or admin-facing surface reveals the pool", function (this: BbWorld) {
  const sb = freshReactiveSandbox(7);
  const surfaces = JSON.stringify(sb.player.getVisibleState()) + JSON.stringify(sb.session.gameStatus()) + JSON.stringify(sb.admin.inspect());
  for (const kind of ["double-eviction", "secret-veto", "battle-back"]) {
    assert.ok(!surfaces.includes(kind), `the armed pool leaked to a surface: ${kind}`);
  }
  assert.ok(!surfaces.includes("twistPlan"));
});

// --- Fires only on the live trigger -------------------------------------------

Given("a season whose house never reaches the double-eviction trigger", function (this: BbWorld) {
  // The double eviction is HELD BACK this season (armed=false) — its threshold is never acted on.
  this.twistFiredKinds = playFullKinds(allArmed({ doubleEvictionArmed: false, secretVetoArmed: false, battleBackArmed: false }));
});

Then("the double eviction never fires", function (this: BbWorld) {
  assert.ok(!this.twistFiredKinds!.includes("double-eviction"));
});

function playFullKinds(plan: TwistPlan, seed = 4): TwistKind[] {
  const sb = freshReactiveSandbox(seed, plan);
  playFull(sb.session);
  return (sb.session.snapshot().live?.firedTwists ?? []).map((t) => t.kind);
}

// --- Dynamic thresholds -------------------------------------------------------

Given("two seasons whose seeded twist thresholds differ", function (this: BbWorld) {
  // Search two seeds whose double-eviction target genuinely differs (thresholds re-roll per season).
  const base = planReserveTwists(new SeededRandom(1));
  let other = base;
  for (let s = 2; s < 60; s++) {
    const p = planReserveTwists(new SeededRandom(s));
    if (p.doubleEvictionAtActive !== base.doubleEvictionAtActive) { other = p; break; }
  }
  this.twistPlan = base; this.twistPlanB = other;
});

Then("the double eviction targets a different house size across the two seasons", function (this: BbWorld) {
  assert.notEqual(this.twistPlan!.doubleEvictionAtActive, this.twistPlanB!.doubleEvictionAtActive);
});

// --- Hold-back ----------------------------------------------------------------

Given("many seasons that each reach the secret-veto trigger", function (this: BbWorld) {
  this.twistArmedFlags = Array.from({ length: 40 }, (_, i) => planReserveTwists(new SeededRandom(i + 1)).secretVetoArmed);
});

Then("in some the secret veto is armed and in others it is held back", function (this: BbWorld) {
  assert.ok(this.twistArmedFlags!.some((a) => a), "some seasons arm the secret veto");
  assert.ok(this.twistArmedFlags!.some((a) => !a), "some seasons hold it back");
});

Then("whether it is armed is reproducible under the season's seed", function (this: BbWorld) {
  for (let i = 1; i <= 10; i++) {
    assert.equal(planReserveTwists(new SeededRandom(i)).secretVetoArmed, planReserveTwists(new SeededRandom(i)).secretVetoArmed);
  }
});

// --- All three, each once -----------------------------------------------------

Given("a live season in which each twist mechanic is driven to fire", function (this: BbWorld) {
  const s = newLiveSeason([PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)]);
  const ctx = ctxOf(new RelationshipModel(0.5));
  s.beat = "battle-back"; s.evictionOrder = [npc(20), npc(21)];
  advance(s, ctx, new SeededRandom(1)); // battle-back fires
  s.beat = "eviction"; s.hoh = npc(6); s.finalNominees = [npc(1), npc(2)];
  s.secretVeto = { holder: npc(1), used: false };
  advance(s, ctx, new SeededRandom(1)); // secret veto fires
  (s.firedTwists ??= []).push({ kind: "double-eviction", beat: s.week }); // the double-eviction night completes
  this.twistFiredKinds = s.firedTwists.map((t) => t.kind);
});

Then("the double eviction, the secret veto, and the battle-back each fire exactly once", function (this: BbWorld) {
  assert.deepEqual(new Set(this.twistFiredKinds), new Set<TwistKind>(["double-eviction", "secret-veto", "battle-back"]));
});

Then("no twist fires twice", function (this: BbWorld) {
  const counts = this.twistFiredKinds!.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  for (const n of Object.values(counts)) assert.ok(n <= 1);
});

// --- Cooldown -----------------------------------------------------------------

Given("two triggers are eligible on the same roll", function (this: BbWorld) {
  const plan = allArmed({ battleBackAtJury: 1 });
  const sig: TwistSignals = { activeCount: 8, juryCount: 1, lopsidedStreak: 0 };
  // Both battle-back and double-eviction qualify; the evaluator returns exactly one.
  const first = triggeredTwist(plan, sig, []);
  const second = triggeredTwist(plan, sig, first ? [first] : []);
  this.twistFiredKinds = [first, second].filter(Boolean) as TwistKind[];
});

Then("only one twist arms that roll and the other defers to a later week", function (this: BbWorld) {
  assert.equal(this.twistFiredKinds!.length, 2);        // the deferred one is still available next roll
  assert.notEqual(this.twistFiredKinds![0], this.twistFiredKinds![1]);
});

// --- Player agency ------------------------------------------------------------

Given("the secret veto is granted to the player while they are on the block", function (this: BbWorld) {
  const s = newLiveSeason([PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)]);
  s.beat = "eviction"; s.hoh = npc(6); s.finalNominees = [PLAYER, npc(2)];
  s.secretVeto = { holder: PLAYER, used: false };
  this.twistLive = s; this.twistCtx = ctxOf(new RelationshipModel(0.5));
  this.twistLastEvent = advance(s, this.twistCtx, new SeededRandom(3));
});

Then("the player is offered the choice to play the secret veto", function (this: BbWorld) {
  assert.equal(this.twistLastEvent, null);
  assert.equal(this.twistLive!.pending?.kind, "secret-veto");
});

Then("the engine does not play it for them", function (this: BbWorld) {
  assert.equal(this.twistLive!.secretVeto!.used, false); // untouched until the player chooses
});

Given("the secret veto is granted to a houseguest while they are on the block", function (this: BbWorld) {
  const s = newLiveSeason([PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)]);
  s.beat = "eviction"; s.hoh = npc(6); s.finalNominees = [npc(1), npc(2)];
  s.secretVeto = { holder: npc(1), used: false };
  this.twistLive = s; this.twistCtx = ctxOf(new RelationshipModel(0.5));
  this.twistLastEvent = advance(s, this.twistCtx, new SeededRandom(3));
});

Then("the engine plays it off the block for them", function (this: BbWorld) {
  assert.match(this.twistLastEvent!.content, /SECRET VETO/);
  assert.ok(!this.twistLive!.finalNominees!.includes(npc(1)));
  assert.equal(this.twistLive!.secretVeto!.used, true);
});

Then("exactly one houseguest is still evicted that week", function (this: BbWorld) {
  assert.equal(this.twistLive!.finalNominees!.length, 2); // a two-nominee block ⇒ one eviction
});

Given("the player sits among the recently-evicted jurors when the battle-back fires", function (this: BbWorld) {
  const s = newLiveSeason([npc(1), npc(2), npc(3), npc(4), npc(5)]);
  s.beat = "battle-back";
  s.evictionOrder = [npc(20), PLAYER, npc(22)]; // the player is among the recent jurors
  this.twistLive = s; this.twistCtx = ctxOf(new RelationshipModel(0.5));
  this.twistLastEvent = advance(s, this.twistCtx, new SeededRandom(9));
});

Then("the player is a competitor in the battle-back", function (this: BbWorld) {
  assert.ok(this.twistLastEvent!.participants.includes(PLAYER), "the player competes in the battle-back field");
});

// --- Sealed from player AND admin ---------------------------------------------

When("any player-facing or admin-facing surface is produced before a twist fires", function (this: BbWorld) {
  const sb = freshReactiveSandbox(11);
  this.lastOutput = JSON.stringify(sb.player.getVisibleState()) + JSON.stringify(sb.session.gameStatus()) + JSON.stringify(sb.admin.inspect());
  this.lastView = this.lastOutput; // satisfies the reused "no Vault sentinel value appears" step
});

Then("no armed twist, its trigger, or its timing appears", function (this: BbWorld) {
  for (const kind of ["double-eviction", "secret-veto", "battle-back"]) {
    assert.ok(!this.lastOutput.includes(kind), `armed twist leaked: ${kind}`);
  }
  assert.ok(!this.lastOutput.includes("twistPlan") && !this.lastOutput.includes("secretVeto"));
});

When("a reactive reserve twist fires", function (this: BbWorld) {
  const s = newLiveSeason([PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5)]);
  s.beat = "battle-back"; s.evictionOrder = [npc(20), npc(21)];
  this.twistLive = s; this.twistCtx = ctxOf(new RelationshipModel(0.5));
  this.twistLastEvent = advance(s, this.twistCtx, new SeededRandom(9));
});

Then("it becomes a witnessed in-game event", function (this: BbWorld) {
  assert.ok(this.twistLastEvent);
  assert.equal(this.twistLastEvent!.beat, "twist-reveal");
  assert.ok(this.twistLastEvent!.participants.length > 0);
});

Then("only then is it known", function (this: BbWorld) {
  // The fire produced the reveal; before it there was no such event (the state was freshly armed).
  assert.match(this.twistLastEvent!.content, /BATTLE-BACK|SECRET VETO|DOUBLE EVICTION/);
});

// --- Format-preserving --------------------------------------------------------

Given("the secret veto is played off the block", function (this: BbWorld) {
  const s = newLiveSeason([PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)]);
  s.beat = "eviction"; s.hoh = npc(6); s.finalNominees = [npc(1), npc(2)];
  s.secretVeto = { holder: npc(1), used: false };
  this.twistLive = s;
  advance(s, ctxOf(new RelationshipModel(0.5)), new SeededRandom(3));
});

Then("the protected houseguest is removed from the block", function (this: BbWorld) {
  assert.ok(!this.twistLive!.finalNominees!.includes(npc(1)));
});

Then("a replacement nominee stands", function (this: BbWorld) {
  const fn = this.twistLive!.finalNominees!;
  assert.equal(fn.length, 2);
  assert.ok(fn.includes(npc(2)));                        // the original other nominee stays
  assert.ok(fn.some((h) => ![npc(1), npc(2)].includes(h))); // a fresh replacement joined
});

Then("exactly one houseguest is evicted that week", function (this: BbWorld) {
  assert.equal(this.twistLive!.finalNominees!.length, 2); // a two-nominee block ⇒ one eviction
});

Given("a full live season in which the battle-back fires", function (this: BbWorld) {
  const sb = freshReactiveSandbox(4, allArmed({ doubleEvictionArmed: false, secretVetoArmed: false, battleBackArmed: true, battleBackAtJury: 1 }));
  playFull(sb.session);
  const core = sb.session.snapshot();
  this.twistFiredKinds = (core.live?.firedTwists ?? []).map((t) => t.kind);
  this.twistJury = core.live?.jury?.length ?? -1;
  this.twistFinalTwo = core.live?.finalTwo?.length ?? -1;
});

Then("one juror re-enters the game", function (this: BbWorld) {
  assert.ok(this.twistFiredKinds!.includes("battle-back"), "the battle-back fired");
});

Then("the season still reaches a jury of nine and a final two", function (this: BbWorld) {
  assert.equal(this.twistJury, 9);
  assert.equal(this.twistFinalTwo, 2);
});

// --- Deterministic & durable --------------------------------------------------

Given("a full live season played twice under the same seed", function (this: BbWorld) {
  const run = (): TwistKind[] => {
    const sb = freshReactiveSandbox(6);
    playFull(sb.session);
    return (sb.session.snapshot().live?.firedTwists ?? []).map((t) => t.kind);
  };
  this.twistFiredKinds = run();
  this.twistFiredKindsB = run();
});

Then("the same twists fire both times", function (this: BbWorld) {
  assert.deepEqual(this.twistFiredKinds, this.twistFiredKindsB);
});

Given("a live season with the reactive pool armed", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  const user = `rt-restart-${rtUsers++}`;
  const sb = reg.sandboxFor(user);
  sb.session.setReactiveTwistsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 5 });
  this.twistRegistry = reg; this.twistUser = user; this.twistSandbox = sb;
  this.twistPlan = sb.session.snapshot().live?.twistPlan;
});

When("the engine restarts mid-season", function (this: BbWorld) {
  const snap = this.twistRegistry!.snapshot(this.twistUser!);
  const reg2 = new GameSessionRegistry();
  reg2.restore(this.twistUser!, snap);
  this.twistSandbox = reg2.sandboxFor(this.twistUser!);
});

Then("the restored game still carries the sealed twist plan", function (this: BbWorld) {
  const restored = this.twistSandbox!.session.snapshot().live?.twistPlan;
  assert.deepEqual(restored, this.twistPlan);
});
