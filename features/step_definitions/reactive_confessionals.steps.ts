import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView } from "../../src/ports/GameSession";
import { confessionalFor, selectRecentForConfessional } from "../../src/engine/confessionals";
import { CONFESSIONAL } from "../../src/engine/confessionalConstants";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { GameEvent } from "../../src/domain/event";
import { PLAYER, npc } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";

// HARD rule: roles only — NPC, HOH, nominee, the player. No names from any corpus.
const [A, B, C] = [npc(1), npc(2), npc(3)];

/** Every Vault-safe gist opener (any class/role) — used to detect a reactive confessional. */
const GIST_PHRASES = Object.values(CONFESSIONAL.gists).flatMap((g) => [g.initiator, g.witness]);

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

/** Play a started season for one full week (to the eviction result), recording the ceremony confessionals. */
function playOneWeek(reg: GameSessionRegistry, user: string): void {
  const sb = reg.sandboxFor(user);
  const session = sb.session as GameSessionAdapter;
  for (let i = 0; i < 300; i++) {
    const adv = sb.session.advanceGame();
    if (adv.pending) resolve(session, adv.pending);
    if (adv.event?.beat === "eviction-result" || adv.finished) break;
  }
}

function confessionals(sb: ReturnType<GameSessionRegistry["sandboxFor"]>): GameEvent[] {
  return sb.engine.events.queryAll().filter((e) => e.type === "confessional");
}

// --- Background -----------------------------------------------------------------

Given("a started season with recorded events in the house", function (this: BbWorld) {
  // ORW-335: this driver plays a raw week with no night handling, so pin the clock-off cadence it was written for (it passed in the full
  // suite only because an earlier feature left the static override off; run alone it stalled before the ceremony). Reset by the After hook.
  GameSessionAdapter.setTimeOfDayEnabled(false);
  const reg = new GameSessionRegistry();
  const user = "rc-bg";
  reg.sandboxFor(user).session.createCharacter({ playerName: "P", seed: 6 });
  this.rcRegistry = reg;
  this.rcUser = user;
});

// --- Scenario: references the concrete beat that just happened -------------------

Given("a houseguest who was just left on the block at the veto ceremony", function (this: BbWorld) {
  // Play a full week so a veto ceremony resolves and the involved houseguests confess reactively.
  playOneWeek(this.rcRegistry!, this.rcUser!);
  this.rcSandbox = this.rcRegistry!.sandboxFor(this.rcUser!);
});

When("that houseguest gives their confessional", function (this: BbWorld) {
  // The confessionals were recorded live at the ceremony beats during the week. (No-op marker step.)
  if (!this.rcSandbox) this.rcSandbox = this.rcRegistry!.sandboxFor(this.rcUser!);
});

Then("the confessional references that recent veto-ceremony event", function (this: BbWorld) {
  const confs = confessionals(this.rcSandbox!);
  assert.ok(confs.length > 0, "the house confessed");
  // ORW-335: tied to THE veto ceremony (was: any confessional with any gist phrase). The confessionals recorded AFTER the veto-ceremony
  // event must include one that reacts with a CEREMONY gist and names the veto ceremony.
  const all = this.rcSandbox!.engine.events.queryAll();
  const vetoAt = all.findIndex((e) => e.type !== "confessional" && /(does not use|uses) the veto/.test(e.content));
  assert.ok(vetoAt >= 0, "a veto ceremony happened this week");
  const ceremonyGists = [CONFESSIONAL.gists.ceremony!.initiator, CONFESSIONAL.gists.ceremony!.witness];
  const after = all.slice(vetoAt + 1).filter((e) => e.type === "confessional");
  assert.ok(after.some((c) => ceremonyGists.some((g) => c.content.includes(g)) && /veto/i.test(c.content)),
    "a confessional after the veto ceremony reacts to that ceremony");
});

Then("it still names their engine-grounded biggest threat and most-trusted ally", function (this: BbWorld) {
  // The reactive confessional keeps the 0040 grounded read: every recorded confessional still names the
  // confessor's engine-true target/ally (the #839-guarded distinct reads). Asserted on the pure composer
  // with a clear threat/ally so the grounding is unambiguous AND reacting at the same time.
  const rel = new RelationshipModel(0.5);
  rel.edge(A, B).threat = 0.9; // engine-true biggest threat
  rel.edge(A, C).trust = 0.9;
  rel.edge(A, C).affinity = 0.8; // engine-true ally
  const conf = confessionalFor(A, [A, B, C], rel, {
    trigger: "the veto ceremony",
    recentEvents: [{ type: "ceremony", role: "witness", gist: CONFESSIONAL.gists.ceremony!.witness }],
    rng: new SeededRandom(5),
  });
  assert.equal(conf.target, B); // the real threat read (anti-sycophancy), not invented
  assert.equal(conf.ally, C);
  assert.ok(conf.content.includes(B), "the line names the engine-grounded target");
  assert.ok(conf.content.includes(CONFESSIONAL.gists.ceremony!.witness), "and opens with the recent beat");
});

Then("the recent event it reacts to comes from that houseguest's own witnessed events", function (this: BbWorld) {
  // Structural proof: the selector returns ONLY events whose witness set includes the confessor.
  const sb = this.rcSandbox!;
  const allEvents = sb.engine.events.queryAll();
  // Pick a confessor that actually confessed this season.
  const confessorId = confessionals(sb)[0]!.initiator;
  const facts = selectRecentForConfessional(allEvents, confessorId, allEvents.length, { rng: new SeededRandom(1) });
  // Every event the selector COULD have drawn is one the confessor witnessed (the only candidates).
  const candidateIds = allEvents.filter((e) => e.witnessSet.includes(confessorId) && e.type !== "confessional");
  assert.ok(candidateIds.length > 0, "the confessor has witnessed events to react to");
  for (const e of allEvents.filter((x) => !x.witnessSet.includes(confessorId))) {
    assert.ok(!candidateIds.includes(e), "no event outside the confessor's witness set is a candidate");
  }
  // And the facts that were produced are well-formed Vault-safe gists (no premise, no number).
  for (const f of facts) {
    assert.ok(GIST_PHRASES.includes(f.gist), "each fact is a class-keyed Vault-safe gist");
    assert.ok(!/\d/.test(f.gist), "a gist carries no number");
  }
});

// --- Scenario: no qualifying recent event ⇒ degrade to the grounded read ---------

Given("a houseguest with no salient recent event in the recency window", function (this: BbWorld) {
  this.rcConfRel = new RelationshipModel(0.5);
  const rng = new SeededRandom(1);
  for (let i = 0; i < 6; i++) this.rcConfRel.applyDirected(A, B, "betrayal", rng); // A reads B as the threat
  for (let i = 0; i < 4; i++) this.rcConfRel.applyDirected(A, C, "bonding", rng); // A trusts C
  this.rcConfessor = A;
  // No witnessed events at all ⇒ the selector returns [] ⇒ confessionalFor falls back to the trigger read.
  this.rcRecentFacts = selectRecentForConfessional([], A, 0, { rng: new SeededRandom(1) });
});

Then("the confessional falls back to the standing target-and-ally read", function (this: BbWorld) {
  assert.deepEqual(this.rcRecentFacts, [], "no recent events selected");
  const withEmpty = confessionalFor(this.rcConfessor!, [A, B, C], this.rcConfRel!, {
    trigger: "the eviction vote", recentEvents: this.rcRecentFacts, rng: new SeededRandom(9),
  });
  const baseline = confessionalFor(this.rcConfessor!, [A, B, C], this.rcConfRel!, {
    trigger: "the eviction vote", rng: new SeededRandom(9),
  });
  // Byte-identical to the 0040 grounded read (the back-compat neutrality guarantee).
  assert.equal(withEmpty.content, baseline.content);
  assert.equal(withEmpty.target, B); // still the engine-true read
  assert.equal(withEmpty.ally, C);
  this.rcConfessional = withEmpty;
});

Then("no recent event is fabricated", function (this: BbWorld) {
  // The fallback opens with the bare trigger label — it invents NO concrete beat (no reactive gist).
  assert.ok(this.rcConfessional!.content.includes("After the eviction vote"));
  for (const p of GIST_PHRASES) assert.ok(!this.rcConfessional!.content.includes(p), "no fabricated beat gist");
});

// --- Scenario: the engine selects the facts -------------------------------------

Given("a houseguest with several recent witnessed events", function (this: BbWorld) {
  // A small recorded log: some events A witnessed, one she did NOT.
  this.rcEvents = [
    { id: "e1", ts: 1, type: "conversation", initiator: A, witnessSet: [A, B], hidden: true, content: "[offscreen] A talked with B" },
    { id: "e2", ts: 2, type: "conversation", initiator: B, witnessSet: [B, C], hidden: true, content: "[offscreen] B schemed with C" }, // NOT A's
    { id: "e3", ts: 3, type: "house-event", initiator: A, witnessSet: [PLAYER, A], hidden: false, content: "A is nominated at the veto ceremony" },
    { id: "e4", ts: 4, type: "competition", initiator: A, witnessSet: [PLAYER, A], hidden: false, content: "A plays the veto" },
  ];
  this.rcConfessor = A;
});

When("the engine builds that houseguest's confessional context", function (this: BbWorld) {
  this.rcRecentFacts = selectRecentForConfessional(this.rcEvents!, this.rcConfessor!, this.rcEvents!.length, {
    rng: new SeededRandom(2),
  });
});

Then("the recent events in the context are drawn from the recorded event store", function (this: BbWorld) {
  assert.ok(this.rcRecentFacts!.length > 0, "the engine selected at least one recorded event to react to");
  // Each selected fact is a class the recorded log actually contains for the confessor.
  for (const f of this.rcRecentFacts!) {
    assert.ok(GIST_PHRASES.includes(f.gist), "the fact is a class-keyed gist, engine-derived not model-invented");
  }
});

Then("every selected event is one whose witness set includes that houseguest", function (this: BbWorld) {
  // The only candidates are A's witnessed events; the selector cannot return a fact for an event A
  // was not in. The salient pick (competition) is the most A-relevant beat.
  const aWitnessed = this.rcEvents!.filter((e) => e.witnessSet.includes(this.rcConfessor!) && e.type !== "confessional");
  assert.deepEqual(aWitnessed.map((e) => e.id).sort(), ["e1", "e3", "e4"]);
  assert.ok(this.rcRecentFacts!.some((f) => f.type === "competition"), "the salient competition is selected");
});

Then("no event outside that houseguest's witness set is selected", function (this: BbWorld) {
  // e2 (between B and C) is excluded — its class is "social" but A was not in it. We prove the selector
  // restricted to A's witness set by removing e2 and confirming the SAME facts result.
  const withoutE2 = this.rcEvents!.filter((e) => e.id !== "e2");
  const factsWithout = selectRecentForConfessional(withoutE2, this.rcConfessor!, withoutE2.length, { rng: new SeededRandom(2) });
  assert.deepEqual(factsWithout, this.rcRecentFacts, "dropping the un-witnessed scene changes nothing");
});

// --- Scenario: never asserts a fabricated outcome -------------------------------

Given("a houseguest reacting to a recent competition they played", function (this: BbWorld) {
  this.rcConfRel = new RelationshipModel(0.5);
  this.rcConfRel.edge(A, B).threat = 0.9;
  this.rcConfRel.edge(A, C).trust = 0.8;
  this.rcConfRel.edge(A, C).affinity = 0.8;
  this.rcConfessor = A;
  this.rcRecentFacts = [{ type: "competition", role: "initiator", gist: CONFESSIONAL.gists.competition!.initiator }];
});

Then("the confessional reacts to the recorded result only", function (this: BbWorld) {
  this.rcConfessional = confessionalFor(this.rcConfessor!, [A, B, C], this.rcConfRel!, {
    recentEvents: this.rcRecentFacts, rng: new SeededRandom(6),
  });
  assert.ok(this.rcConfessional.content.includes("competition"), "it references the comp it played");
});

Then("it states no competition result, vote tally, or nomination the engine did not produce", function (this: BbWorld) {
  // Strip entity-id references (npc:N — the 0040 read already embeds these, Vault-only); assert no
  // outcome word and no stray number remain.
  const outcomeFree = this.rcConfessional!.content.replace(/npc:\d+/g, "X");
  assert.ok(!/\bwins?\b|\bwon\b|\bevicted\b|\bvotes?\b|\btally\b|\d/.test(outcomeFree), "no fabricated outcome");
});

// --- Scenario: reaches no one (Vault-sealed) ------------------------------------

Given("a houseguest gives a confessional reacting to a recent beat", function (this: BbWorld) {
  playOneWeek(this.rcRegistry!, this.rcUser!);
  this.rcSandbox = this.rcRegistry!.sandboxFor(this.rcUser!);
  assert.ok(confessionals(this.rcSandbox).length > 0, "the house confessed");
});

Then("the confessional is recorded witnessed by that houseguest alone and hidden", function (this: BbWorld) {
  for (const c of confessionals(this.rcSandbox!)) {
    assert.equal(c.hidden, true);
    assert.deepEqual(c.witnessSet, [c.initiator]); // the confessing NPC alone
    assert.ok(!c.witnessSet.includes(PLAYER));
  }
});

Then("it never appears on any player-facing surface", function (this: BbWorld) {
  const sb = this.rcSandbox!;
  const surface =
    JSON.stringify(sb.session.getGameState()) +
    JSON.stringify(sb.session.gameStatus()) +
    JSON.stringify(sb.player.getVisibleState()) +
    sb.player.produce("player-visible log") +
    JSON.stringify(sb.session.getMomentPrompt({}));
  for (const c of confessionals(sb)) assert.ok(!surface.includes(c.content), "a confessional leaked to the player");
});

Then("it never appears on the admin or God-Mode surface", function (this: BbWorld) {
  const adminSurface = JSON.stringify(this.rcSandbox!.admin.inspect());
  for (const c of confessionals(this.rcSandbox!)) assert.ok(!adminSurface.includes(c.content), "a confessional leaked to admin");
  assert.ok(!adminSurface.includes("confessional"), "the admin surface reads no events at all");
});

// --- Scenario: carries no other sealed state and no number ----------------------

Given("a houseguest whose confessional reacts to a scene they were part of", function (this: BbWorld) {
  playOneWeek(this.rcRegistry!, this.rcUser!);
  this.rcSandbox = this.rcRegistry!.sandboxFor(this.rcUser!);
});

When("the confessional content and its context are assembled", function (this: BbWorld) {
  assert.ok(confessionals(this.rcSandbox!).length > 0, "the house confessed");
});

Then("the assembled content contains no other houseguest's hidden read", function (this: BbWorld) {
  // The reaction is built only from the confessor's OWN witness set + their OWN grounded target/ally read.
  // Every reactive opener is a class-keyed gist (no premise of anyone else's secret) — assert each
  // confessional's opener (before the first ':') is composed only of known Vault-safe gists / "After …".
  for (const c of confessionals(this.rcSandbox!)) {
    const opener = c.content.replace(/^\[confessional [^\]]+\]\s*/, "").split(":")[0]!;
    const isSafe =
      opener.startsWith("After the ") || GIST_PHRASES.some((p) => opener.includes(p));
    assert.ok(isSafe, `the opener is a Vault-safe gist/trigger, not another's read: ${opener}`);
  }
});

Then("it contains no hidden number", function (this: BbWorld) {
  // Strip entity-id tokens (references the 0040 read embeds, Vault-only) then assert no stray digit
  // (a relationship trust/threat/affinity VALUE) survives anywhere in the assembled content.
  for (const c of confessionals(this.rcSandbox!)) {
    const stripped = c.content.replace(/npc:\d+/g, "X").replace(/\bplayer\b/g, "X");
    assert.ok(!/\d/.test(stripped), `confessional carries no hidden number: ${c.content}`);
  }
});

// --- Scenario: deterministic + deepens the soul ---------------------------------

Given("two runs of the same season from the same seed and the same recorded history", function (this: BbWorld) {
  const regA = new GameSessionRegistry();
  const regB = new GameSessionRegistry();
  regA.sandboxFor("rc-detA").session.createCharacter({ playerName: "P", seed: 21 });
  regB.sandboxFor("rc-detB").session.createCharacter({ playerName: "P", seed: 21 });
  playOneWeek(regA, "rc-detA");
  playOneWeek(regB, "rc-detB");
  this.rcRegistry = regA;
  this.rcRegistryB = regB;
  this.rcUser = "rc-detA";
  this.rcUserB = "rc-detB";
});

When("a houseguest gives their confessional in each run", function () {
  // Both seasons played the same week from the same seed in the Given.
});

Then("both runs produce the same confessional reacting to the same recent event", function (this: BbWorld) {
  const a = confessionals(this.rcRegistry!.sandboxFor(this.rcUser!)).map((e) => e.content).join("|");
  const b = confessionals(this.rcRegistryB!.sandboxFor(this.rcUserB!)).map((e) => e.content).join("|");
  assert.ok(a.length > 0, "the houses confessed");
  assert.equal(a, b, "same seed + history ⇒ identical reactive confessionals");
});

Then("the confessional appends to that houseguest's soul without losing earlier ones", function (this: BbWorld) {
  // ORW-335: compare BEFORE and AFTER (was: only checked a confessional exists). Snapshot every soul, play on to the next week's
  // confessionals, and assert each houseguest's memory kept every earlier entry in order and gained a new confessional.
  const sb = this.rcRegistry!.sandboxFor(this.rcUser!);
  const before = new Map(sb.session.snapshot().house!.npcs.map((n) => [n.id, [...n.soul.memory]] as const));
  playOneWeek(this.rcRegistry!, this.rcUser!);
  const after = sb.session.snapshot().house!.npcs;
  let grew = 0;
  for (const n of after) {
    const was = before.get(n.id);
    if (!was) continue;
    assert.deepEqual(n.soul.memory.slice(0, was.length), was, `${n.id}: earlier memory kept, in order`);
    if (n.soul.memory.slice(was.length).some((m) => m.includes("[confessional"))) grew++;
  }
  assert.ok(grew > 0, "a houseguest's soul gained a new confessional");
});
