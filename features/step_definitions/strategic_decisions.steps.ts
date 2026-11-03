import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BbWorld } from "../support/world";
import { nominationStrategy, chooseNominations } from "../../src/engine/season";
import { voteChoice } from "../../src/engine/liveSeason";
import type { SeasonCtx } from "../../src/engine/liveSeason";
import { DECISION } from "../../src/engine/decisionConstants";
import { detectBlocs } from "../../src/engine/blocs";
import { RelationshipModel } from "../../src/engine/relationships";
import { DealLedger } from "../../src/engine/deals";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";

// Feature 0044 — strategic nomination & vote refinements. HARD rule: roles only — no names.

const sdHoh = npc(7);

/** A QUIET house with distinct HOH threat reads: target > bait > bait > pawn. */
function sdHouse(): { rel: RelationshipModel; active: EntityId[] } {
  const rel = new RelationshipModel(0.5);
  const active = [sdHoh, npc(1), npc(2), npc(3), npc(4)];
  rel.edge(sdHoh, npc(1)).threat = 0.6;
  rel.edge(sdHoh, npc(2)).threat = 0.5;
  rel.edge(sdHoh, npc(3)).threat = 0.4;
  rel.edge(sdHoh, npc(4)).threat = 0.15;
  return { rel, active };
}

const sdVoteCtx = (rel: RelationshipModel, extra: Partial<SeasonCtx> = {}): SeasonCtx => ({
  player: PLAYER,
  statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }),
  rel,
  ...extra,
});

// --- Scenario: Nominations go beyond raw threat ----------------------------------------

Given("an HOH whose disposition favors a strategic game", function (this: BbWorld) {
  const { rel, active } = sdHouse();
  this.sdRel = rel;
  this.sdActive = active;
  this.sdDisposition = "clash"; // the schemer archetype family — gated to the backdoor tactic
});

When("they nominate", function (this: BbWorld) {
  this.sdNoms = nominationStrategy(sdHoh, this.sdActive!, this.sdRel!, { disposition: this.sdDisposition! });
});

Then("their two nominees are not simply the two highest threats", function (this: BbWorld) {
  assert.notDeepEqual([...this.sdNoms!].sort(), [...chooseNominations(sdHoh, this.sdActive!, this.sdRel!)].sort());
});

Then("the choice reflects a pawn, a backdoor, or bloc protection", function (this: BbWorld) {
  // The schemer's read: the TOP threat is deliberately left off the block — the backdoor plan.
  assert.ok(!this.sdNoms!.includes(npc(1)), "the real target stays off the block as veto bait goes up");
});

Then("the nominations remain legal under the eligibility rules", function (this: BbWorld) {
  const [a, b] = this.sdNoms!;
  assert.notEqual(a, b);
  assert.notEqual(a, sdHoh);
  assert.notEqual(b, sdHoh);
  assert.ok(this.sdActive!.includes(a) && this.sdActive!.includes(b));
});

// --- Scenario: Different HOHs nominate differently --------------------------------------

Given("a loyal HOH and a ruthless HOH facing the same house", function (this: BbWorld) {
  const { rel, active } = sdHouse();
  this.sdRel = rel;
  this.sdActive = active;
});

When("each nominates", function (this: BbWorld) {
  this.sdNomsLoyal = nominationStrategy(sdHoh, this.sdActive!, this.sdRel!, { disposition: "bond" });
  this.sdNoms = nominationStrategy(sdHoh, this.sdActive!, this.sdRel!, { disposition: "clash" });
});

Then("their nominations differ in a way consistent with their disposition", function (this: BbWorld) {
  assert.notDeepEqual([...this.sdNomsLoyal!].sort(), [...this.sdNoms!].sort());
  // The loyalist confronts the target directly but spends the second seat on a pawn…
  assert.ok(this.sdNomsLoyal!.includes(npc(1)) && this.sdNomsLoyal!.includes(npc(4)));
  // …while the schemer leaves the target off the block entirely (the backdoor).
  assert.ok(!this.sdNoms!.includes(npc(1)));
});

// --- Scenario: A rattled houseguest votes differently than a calm one ---------------------

Given("the same voter rattled versus settled", function (this: BbWorld) {
  const rel = new RelationshipModel(0.5);
  this.sdVoter = npc(5);
  this.sdNominees = [npc(1), npc(2)];
  rel.edge(this.sdVoter, npc(1)).threat = 0.6;  // the personally-scarier nominee — deal-protected
  rel.edge(this.sdVoter, npc(2)).threat = 0.38;
  const ledger = new DealLedger();
  ledger.make([this.sdVoter, npc(1)], "vote", "vote-protection");
  this.sdLedger = ledger;
  this.sdRel = rel;
});

When("each casts an eviction vote", function (this: BbWorld) {
  const dealsOf = (id: EntityId): ReturnType<DealLedger["open"]> =>
    this.sdLedger!.open().filter((d) => d.condition.promisors.includes(id));
  const fn = this.sdNominees as [EntityId, EntityId];
  this.sdCalmVote = voteChoice(this.sdVoter!, fn, sdVoteCtx(this.sdRel!, { dealsOf, emotionalOf: () => 0.5 }));
  this.sdRattledVote = voteChoice(this.sdVoter!, fn, sdVoteCtx(this.sdRel!, {
    dealsOf, emotionalOf: (id) => (id === this.sdVoter ? 0 : 0.5),
  }));
});

Then("the rattled voter's choice can differ, weighting self-protection", function (this: BbWorld) {
  assert.notEqual(this.sdCalmVote, this.sdRattledVote);
  // Self-protection: the rattled voter moves on the nominee THEY read as the bigger personal threat.
  assert.equal(this.sdRattledVote, npc(1));
});

// --- Scenario: Bloc and deal shape the vote ------------------------------------------------

Given("a voter aligned with a bloc and bound by a vote deal", function (this: BbWorld) {
  const rel = new RelationshipModel(0.5);
  const trio = [npc(1), npc(2), npc(3)];
  for (const x of trio) for (const y of trio) if (x !== y) {
    const e = rel.edge(x, y); e.trust = 0.85; e.affinity = 0.85;
  }
  const enemy = npc(8);
  for (const m of trio) rel.edge(m, enemy).threat = 0.9; // the bloc's shared enemy
  this.sdVoter = trio[0]!;
  this.sdRel = rel;
  this.sdActive = [...trio, enemy, npc(9)];
  this.sdNominees = [enemy, npc(9)];
  rel.edge(this.sdVoter, enemy).threat = 0.2;  // privately, the voter reads the other nominee as scarier…
  rel.edge(this.sdVoter, npc(9)).threat = 0.3;
  const ledger = new DealLedger();
  ledger.make([this.sdVoter, npc(9)], "vote", "vote-protection"); // …and is deal-bound to protect them
  this.sdLedger = ledger;
});

When("they cast their eviction vote", function (this: BbWorld) {
  const blocs = detectBlocs({ rel: this.sdRel!, active: this.sdActive!, loyaltyOf: () => 0.9 });
  const dealsOf = (id: EntityId): ReturnType<DealLedger["open"]> =>
    this.sdLedger!.open().filter((d) => d.condition.promisors.includes(id));
  this.sdBlocVote = voteChoice(this.sdVoter!, this.sdNominees as [EntityId, EntityId], sdVoteCtx(this.sdRel!, { dealsOf }), blocs);
});

Then("they lean to vote with their bloc", function (this: BbWorld) {
  assert.equal(this.sdBlocVote, npc(8), "the bloc's shared enemy takes the vote over the voter's raw read");
});

Then("they honor or break the deal with its consequence — decided by the engine", function (this: BbWorld) {
  // The vote honored the deal here (the protected party was spared) — the ledger marks it KEPT.
  const { kept, broken } = this.sdLedger!.reconcile({ actor: this.sdVoter!, kind: "vote-evict", targets: [this.sdBlocVote!] });
  assert.equal(kept.length, 1);
  assert.equal(broken.length, 0);
  // And a break, when the engine decides one, carries the betrayal consequence — never prose.
  const ledger2 = new DealLedger();
  const deal2 = ledger2.make([this.sdVoter!, npc(8)], "vote", "vote-protection");
  const { broken: b2 } = ledger2.reconcile({ actor: this.sdVoter!, kind: "vote-evict", targets: [npc(8)] });
  assert.equal(b2[0]?.id, deal2.id);
  assert.equal(deal2.status, "broken");
});

/** Play a live game's first weeks and return each week's HOH + nominee pair (the engine's nomination decisions). */
function nominationTrail(s: ReturnType<GameSessionRegistry["sandboxFor"]>["session"]): string[] {
  const trail: string[] = [];
  for (let i = 0; i < 160; i++) {
    const v = s.advanceGame();
    if (v.pending) {
      resolvePending(v.pending, (req) => s.submitDecision(req));
    }
    const status = s.gameStatus();
    if (status.nominees.length === 2) {
      trail.push(`${status.week}:${status.hoh?.id}:${status.nominees.map((n) => n.id).sort().join("+")}`);
    }
    if (v.status.week >= 4 || v.finished) break;
  }
  return trail;
}

// --- Scenario: The engine decides every nomination and vote ---------------------------------

Given("any nomination or eviction vote", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("sd-engine");
  sb.session.createCharacter({ playerName: "The Player", seed: 9 });
  this.sdSandbox = sb;
});

Then("it is computed from the hidden signals and seeded temperature", function (this: BbWorld) {
  // The hidden signals are the ONLY input: swap the HOH's threat reads and the nominations follow them...
  const { rel, active } = sdHouse();
  const before = nominationStrategy(sdHoh, active, rel, {});
  const flipped = sdHouse();
  flipped.rel.edge(sdHoh, npc(1)).threat = 0.15;
  flipped.rel.edge(sdHoh, npc(4)).threat = 0.6;
  const after = nominationStrategy(sdHoh, flipped.active, flipped.rel, {});
  assert.notDeepEqual([...before].sort(), [...after].sort(), "nominations ignore the hidden threat reads");
  assert.ok(before.includes(npc(1)) && !before.includes(npc(4)), "the top-threat houseguest is nominated");
  assert.ok(after.includes(npc(4)) && !after.includes(npc(1)), "...and when the reads swap, so does the block");
  // ...and so does a voter's choice of who goes home.
  const voter = npc(5);
  const v = sdHouse();
  v.rel.edge(voter, npc(1)).threat = 0.9; v.rel.edge(voter, npc(2)).threat = 0.1;
  const voteBefore = voteChoice(voter, [npc(1), npc(2)], sdVoteCtx(v.rel));
  v.rel.edge(voter, npc(1)).threat = 0.1; v.rel.edge(voter, npc(2)).threat = 0.9;
  const voteAfter = voteChoice(voter, [npc(1), npc(2)], sdVoteCtx(v.rel));
  assert.equal(voteBefore, npc(1));
  assert.equal(voteAfter, npc(2), "a vote ignores the voter's hidden threat reads");
  // The seeded part: a season's signals (and the temperature rolls that shaped them) come from its seed — the same
  // seed makes the same nominations, a different seed makes different ones.
  const trail = (seed: number): string[] => {
    const sb = new GameSessionRegistry().sandboxFor(`sd-seed-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    return nominationTrail(sb.session);
  };
  const t9 = trail(9);
  assert.ok(t9.length > 0, "nominations were made");
  assert.deepEqual(trail(9), t9, "the same seed reproduces the same nominations");
  assert.notDeepEqual(trail(10), t9, "a different seed produces different nominations");
});

Then("it is never decided or altered by narration", function (this: BbWorld) {
  // The narrator has no seam into the read: the strategy modules import no narrative port.
  for (const f of ["src/engine/season.ts", "src/engine/liveSeason.ts", "src/engine/decisionConstants.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/NarrativePort|narrate|prompt/i.test(src), `${f} carries no narrative dependency`);
  }
});

Then("the player is shown no score or number", function (this: BbWorld) {
  const s = this.sdSandbox!.session;
  for (let i = 0; i < 30; i++) {
    const v = s.advanceGame();
    if (v.pending) {
      resolvePending(v.pending, (req) => s.submitDecision(req));
    }
    if (v.status.week >= 2) break;
  }
  const surface = JSON.stringify([s.getGameState(), s.gameStatus()]);
  assert.ok(!/backdoor|tactic|paranoia|dealHonor|juryManagement|runaway/i.test(surface));
  assert.ok(!/"score"|"threat"|"trust"|"affinity"|"loyalty/.test(surface));
});

// --- Scenario: The refinements are deterministic and tunable ---------------------------------

// The Given ("two games started from the same seed") is the canonical 0031 step
// (game_orchestrator.steps.ts); this When builds the 0044 fixture it needs itself.
When("the same weeks are played in each", function (this: BbWorld) {
  this.sdRegistryA = new GameSessionRegistry();
  this.sdRegistryB = new GameSessionRegistry();
  this.sdRegistryA.sandboxFor("sd-det-a").session.createCharacter({ playerName: "The Player", seed: 21 });
  this.sdRegistryB.sandboxFor("sd-det-b").session.createCharacter({ playerName: "The Player", seed: 21 });
  this.sdTrailA = nominationTrail(this.sdRegistryA!.sandboxFor("sd-det-a").session);
  this.sdTrailB = nominationTrail(this.sdRegistryB!.sandboxFor("sd-det-b").session);
});

Then("the same nominations and votes result", function (this: BbWorld) {
  assert.ok(this.sdTrailA!.length > 0, "the games actually played nominations");
  assert.deepEqual(this.sdTrailA, this.sdTrailB);
});

Then("every magnitude comes from a single tunable constants module", function (this: BbWorld) {
  assert.ok(DECISION.nomination.paranoiaWeight > 0);
  assert.ok(DECISION.nomination.runawaySpread > 0);
  assert.ok(DECISION.vote.moodSelfProtectWeight > 0);
  assert.ok(DECISION.vote.dealHonorWeight > 0);
  assert.ok(DECISION.vote.juryManagementWeight > 0);
  // And the call sites import the module rather than inlining numbers (the B59 grep gate).
  assert.ok(readFileSync("src/engine/season.ts", "utf8").includes("decisionConstants"));
  assert.ok(readFileSync("src/engine/liveSeason.ts", "utf8").includes("decisionConstants"));
});
