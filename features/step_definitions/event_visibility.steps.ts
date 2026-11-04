import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { buildSandbox } from "../../tests/support/sandbox";
import { classify } from "../../src/domain/event";
import type { GameEvent } from "../../src/domain/event";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { KnowledgeFact } from "../../src/domain/knowledge";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { simulateOffscreenStretch } from "../../src/engine/offscreen";
import { makeSocialGraph, diffuseGossip } from "../../src/engine/gossip";

let evSeq = 0;
const nextId = (): string => `evt:0002:${++evSeq}`;

function record(world: BbWorld, ev: Omit<GameEvent, "id" | "ts"> & Partial<Pick<GameEvent, "id" | "ts">>): GameEvent {
  const full: GameEvent = { id: ev.id ?? nextId(), ts: ev.ts ?? evSeq, ...ev } as GameEvent;
  world.sandbox.engine.events.record(full);
  return full;
}

// --- Background ---------------------------------------------------------------

Given("a running game sandbox with a single event record", function (this: BbWorld) {
  this.sandbox = buildSandbox(1);
});

// --- Player-witnessed = knowledge, not hidden (scenarios 1 & 7 share this Given) ---

Given("an interaction whose witness set includes the player", function (this: BbWorld) {
  this.firstEvent = record(this, {
    type: "conversation", initiator: PLAYER, witnessSet: [PLAYER, npc(1)],
    hidden: false, content: "player-witnessed kitchen chat",
  });
});

Then("that interaction is part of the player's knowledge", function (this: BbWorld) {
  const witnessed = this.sandbox.engine.events.query({ witnessedBy: PLAYER });
  assert.ok(witnessed.some((e) => e.id === this.firstEvent!.id), "player should have witnessed it");
});

Then("it is not classified as off-screen or hidden", function (this: BbWorld) {
  assert.equal(classify(this.firstEvent!, PLAYER), "VISIBLE");
  assert.equal(this.firstEvent!.hidden, false);
});

// --- Visibility follows the witness set, not the store ------------------------

Given("two interactions with identical content", function (this: BbWorld) {
  this.factContent = "identical interaction content";
});

Given("the first has a witness set that includes the player", function (this: BbWorld) {
  this.firstEvent = record(this, {
    type: "conversation", initiator: PLAYER, witnessSet: [PLAYER, npc(1)],
    hidden: false, content: this.factContent!,
  });
});

Given("the second has a witness set that excludes the player", function (this: BbWorld) {
  this.secondEvent = record(this, {
    type: "conversation", initiator: npc(1), witnessSet: [npc(1), npc(2)],
    hidden: true, content: this.factContent!,
  });
});

Then("the first is visible to the player", function (this: BbWorld) {
  assert.equal(classify(this.firstEvent!, PLAYER), "VISIBLE");
});

Then("the second is hidden from the player", function (this: BbWorld) {
  assert.equal(classify(this.secondEvent!, PLAYER), "HIDDEN");
});

// --- Off-screen simulation ----------------------------------------------------

Given("a stretch of game time in which the player is absent", function (this: BbWorld) {
  this.offscreen = simulateOffscreenStretch({
    events: this.sandbox.engine.events,
    rng: new SeededRandom(123),
    npcs: [npc(1), npc(2), npc(3), npc(4), npc(5)],
    interactions: 10,
  });
});

Then(
  "NPC-to-NPC interactions occur with witness sets that exclude the player",
  function (this: BbWorld) {
    assert.ok(this.offscreen!.length > 0);
    assert.ok(this.offscreen!.every((e) => !e.witnessSet.includes(PLAYER)));
  },
);

Then(
  "they remain hidden from the player until surfaced by an in-game pathway",
  function (this: BbWorld) {
    const witnessed = this.sandbox.engine.events.query({ witnessedBy: PLAYER });
    const known = this.sandbox.engine.knowledge.knownTo(PLAYER);
    for (const e of this.offscreen!) {
      assert.equal(classify(e, PLAYER), "HIDDEN");
      assert.ok(!witnessed.some((w) => w.id === e.id));
      assert.ok(!known.some((k) => k.content === e.content));
    }
  },
);

// --- Propagation (scenarios 4 & 5 share the first Given) ----------------------

Given("a hidden interaction the player did not witness", function (this: BbWorld) {
  this.hiddenEvent = record(this, {
    type: "conversation", initiator: npc(1), witnessSet: [npc(1), npc(2)],
    hidden: true, content: "a secret final-two deal",
  });
});

Given("an NPC who witnessed it", function (this: BbWorld) {
  this.npc = npc(1); // in the hidden event's witness set
});

When("that NPC tells the player about it", function (this: BbWorld) {
  // Anchored (A4): the teller WITNESSED the hidden event, so they may legitimately surface it.
  this.surfaced = this.sandbox.engine.knowledge.surfaceInformationTo(
    PLAYER, { content: this.hiddenEvent!.content }, `told-by:${this.npc}`,
  ) ?? undefined;
});

Then("that fact enters the player's knowledge state", function (this: BbWorld) {
  const known = this.sandbox.engine.knowledge.knownTo(PLAYER);
  assert.ok(known.some((k) => k.content === this.hiddenEvent!.content));
});

Then(
  "the surfacing is itself recorded as an event with a traceable pathway",
  function (this: BbWorld) {
    const fact = this.sandbox.engine.knowledge.knownTo(PLAYER).find(
      (k) => k.content === this.hiddenEvent!.content,
    );
    assert.ok(fact, "surfaced fact should exist");
    assert.equal(fact!.pathway, `told-by:${this.npc}`);
    assert.ok(fact!.sourceEventId, "fact must reference a surfacing event");
    const surfacing = this.sandbox.engine.events.query({ type: "surfacing" });
    assert.ok(surfacing.some((e) => e.id === fact!.sourceEventId), "surfacing event must be queryable");
  },
);

// --- No pathway, no access ----------------------------------------------------

Given("no in-game pathway has surfaced it", function (this: BbWorld) {
  const known = this.sandbox.engine.knowledge.knownTo(PLAYER);
  assert.ok(!known.some((k) => k.content === this.hiddenEvent!.content));
});

Then("the player has no access to that fact", function (this: BbWorld) {
  const witnessed = this.sandbox.engine.events.query({ witnessedBy: PLAYER });
  const known = this.sandbox.engine.knowledge.knownTo(PLAYER);
  assert.ok(!witnessed.some((w) => w.id === this.hiddenEvent!.id));
  assert.ok(!known.some((k) => k.content === this.hiddenEvent!.content));
});

// --- Knowledge vs suspicion ---------------------------------------------------

// AMEND secrets wall item 2 (S12): this scenario now runs on the LIVE game (it used to assert an empty store for a fact that was never recorded, and read back what it had just written).
// Houseguest A and the player talk in the kitchen (a recorded scene); C is elsewhere. A's `npcVoice.knows` carries the fact (the POSITIVE CONTROL - the check can fail), C's never does,
// and C can hold it only as a suspicion.
interface LiveKnowledgeWorld { lkSb?: ReturnType<GameSessionRegistry["sandboxFor"]>; lkA?: EntityId; lkC?: EntityId; lkToken?: string }
const lk = (w: BbWorld): LiveKnowledgeWorld => w as unknown as LiveKnowledgeWorld;

Given("a fact an NPC neither witnessed nor was told", function (this: BbWorld) {
  const sb = new GameSessionRegistry().sandboxFor("lk-0002");
  sb.session.createCharacter({ playerName: "The Player", seed: 11 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const [a, c] = sb.session.livingIds().filter((i) => i !== PLAYER);
  const token = "ZEBRA-QUILL-0002";
  (sb.session as unknown as { presence: Map<string, string> }).presence = new Map<string, string>([[PLAYER, "kitchen"], [a!, "kitchen"], [c!, "bedroom"]]);
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, a!], content: `the player and a houseguest quietly agree about ${token}`, kind: "strategy" });
  // A NPC's knowledge lives in the knowledge service (the recorded event is the witness record, not the NPC's belief store): give the WITNESS the belief through the same sanctioned
  // `witnessed` pathway the live ADR 0019 tests use. C has no pathway to it.
  sb.engine.knowledge.seedBelief(a!, { content: `the player and a houseguest quietly agree about ${token}`, factId: "lk-0002:fact" }, "witnessed");
  Object.assign(lk(this), { lkSb: sb, lkA: a, lkC: c, lkToken: token });
});

Then("that NPC does not know the fact", function (this: BbWorld) {
  const { lkSb, lkA, lkC, lkToken } = lk(this);
  const knowsOf = (id: EntityId): string[] => lkSb!.session.npcVoice(id)?.knows ?? [];
  assert.ok(knowsOf(lkA!).some((k) => k.includes(lkToken!)), "positive control: the houseguest who WITNESSED it knows it");
  assert.ok(!knowsOf(lkC!).some((k) => k.includes(lkToken!)), "the houseguest who neither witnessed nor was told does not know it");
  assert.ok(!lkSb!.engine.knowledge.knownTo(lkC!).some((k) => k.content.includes(lkToken!)));
});

Then(
  "the NPC may hold it only as a suspicion, never as knowledge",
  function (this: BbWorld) {
    const { lkSb, lkC, lkToken } = lk(this);
    lkSb!.engine.knowledge.addSuspicion(lkC!, { content: `a hunch about ${lkToken}` });
    assert.ok(lkSb!.engine.knowledge.suspicionsOf(lkC!).some((s) => s.content.includes(lkToken!)), "should be a suspicion");
    assert.ok(!lkSb!.engine.knowledge.knownTo(lkC!).some((k) => k.content.includes(lkToken!)), "must never be knowledge");
  },
);

// --- Regression guard: a witnessed event is never written as hidden -----------

When("the event record is classified", function (this: BbWorld) {
  this.classification = classify(this.firstEvent!, PLAYER);
});

// regex (not a Cucumber Expression) because the step text contains "/".
Then(
  /^it is never written to the hidden \/ off-screen classification$/,
  function (this: BbWorld) {
    assert.equal(this.classification, "VISIBLE");
    assert.equal(this.firstEvent!.hidden, false);
    // Structural: persisting a player-witnessed event as hidden is rejected.
    assert.throws(() =>
      this.sandbox.engine.events.record({ ...this.firstEvent!, id: "mislabeled", hidden: true }),
    );
  },
);

// --- Diary Room reaches no NPC ------------------------------------------------

Given("the player speaks privately in the Diary Room", function (this: BbWorld) {
  this.factContent = "my secret plan to backdoor the Head of Household";
  this.sandbox.engine.knowledge.recordDiaryRoom(this.factContent);
});

Then("that content is part of the player's own knowledge", function (this: BbWorld) {
  const known = this.sandbox.engine.knowledge.knownTo(PLAYER);
  assert.ok(known.some((k) => k.content === this.factContent));
});

Then("no NPC's knowledge state gains a pathway to it", function (this: BbWorld) {
  for (let i = 1; i <= 8; i++) {
    const known = this.sandbox.engine.knowledge.knownTo(npc(i));
    assert.ok(!known.some((k) => k.content === this.factContent), `npc:${i} must not know the DR content`);
  }
  // No event carrying the DR content has any non-player witness.
  const leaked = this.sandbox.engine.events
    .queryAll()
    .filter((e) => e.content.includes(this.factContent!) && e.witnessSet.some((w) => w !== PLAYER));
  assert.equal(leaked.length, 0, "DR content must not reach any NPC via an event");
});

// --- Gossip diffusion through the social graph --------------------------------

const beliefsOfFact = (world: BbWorld): KnowledgeFact[] =>
  (world.gossipNodes ?? [])
    .map((e) => world.sandbox.engine.knowledge.knownTo(e).find((k) => k.factId === world.factId))
    .filter((b): b is KnowledgeFact => b !== undefined);

Given("a hidden fact known to one NPC", function (this: BbWorld) {
  // A small social graph; the player is reachable only via NPC(3).
  this.graph = makeSocialGraph([
    [npc(1), npc(2)], [npc(2), npc(3)], [npc(3), npc(4)], [npc(4), npc(5)], [npc(3), PLAYER],
  ]);
  this.gossipNodes = [npc(1), npc(2), npc(3), npc(4), npc(5), PLAYER];
  this.gossipOrigin = npc(1);
  this.factContent = "the alliance plans to backdoor the Head of Household";
});

When("game time passes", function (this: BbWorld) {
  const res = diffuseGossip({
    knowledge: this.sandbox.engine.knowledge,
    graph: this.graph!,
    rng: new SeededRandom(7),
    origin: this.gossipOrigin!,
    fact: { content: this.factContent! },
    rounds: 6,
    transmitProb: 1,
  });
  this.factId = res.factId;
  this.gossipOriginal = res.original;
});

Then(
  "the fact may spread to other NPCs along their relationship edges",
  function (this: BbWorld) {
    const others = (this.gossipNodes ?? []).filter(
      (e) => e !== this.gossipOrigin && e !== PLAYER &&
        this.sandbox.engine.knowledge.knownTo(e).some((k) => k.factId === this.factId),
    );
    assert.ok(others.length >= 1, "the fact should reach at least one other NPC");
  },
);

Then(
  "each retelling is recorded as its own event with a traceable source",
  function (this: BbWorld) {
    const gossipEvents = this.sandbox.engine.events.query({ type: "gossip" });
    assert.ok(gossipEvents.length >= 1, "retellings should be recorded as events");
    for (const belief of beliefsOfFact(this)) {
      if (belief.source === this.gossipOrigin && belief.hops === 0) continue; // origin seed
      assert.ok(belief.sourceEventId, "belief must reference its telling event");
      const ev = gossipEvents.find((g) => g.id === belief.sourceEventId);
      assert.ok(ev, "telling event must exist and be queryable");
      assert.ok(ev!.witnessSet.includes(belief.source!), "event is witnessed by its source (the teller)");
    }
  },
);

Then(
  "each recipient holds the fact with a provenance and a confidence",
  function (this: BbWorld) {
    for (const belief of beliefsOfFact(this)) {
      if (belief.hops === 0) continue; // origin
      assert.ok(belief.pathway.startsWith("told-by"), "recipient has a provenance pathway");
      assert.ok(belief.source, "recipient records who told them");
      assert.ok(
        typeof belief.confidence === "number" && belief.confidence! > 0 && belief.confidence! <= 1,
        "recipient holds a confidence in (0, 1]",
      );
    }
  },
);

Then(
  "it reaches the player only if a chain of pathways terminates at the player",
  function (this: BbWorld) {
    const playerHas = this.sandbox.engine.knowledge.knownTo(PLAYER).some((k) => k.factId === this.factId);
    const chainTerminatesAtPlayer = this.sandbox.engine.events
      .query({ type: "gossip" })
      .some((g) => g.witnessSet.includes(PLAYER));
    assert.equal(playerHas, chainTerminatesAtPlayer);
  },
);

Given("a hidden fact that has spread across several hops", function (this: BbWorld) {
  // A path so the fact travels many hops in order.
  this.graph = makeSocialGraph([
    [npc(1), npc(2)], [npc(2), npc(3)], [npc(3), npc(4)], [npc(4), npc(5)],
  ]);
  this.gossipNodes = [npc(1), npc(2), npc(3), npc(4), npc(5)];
  this.gossipOrigin = npc(1);
  const res = diffuseGossip({
    knowledge: this.sandbox.engine.knowledge,
    graph: this.graph,
    rng: new SeededRandom(11),
    origin: npc(1),
    fact: { content: "a secret vote-flip is coming" },
    rounds: 6,
    transmitProb: 1,
  });
  this.factId = res.factId;
  this.gossipOriginal = res.original;
});

Then("a version far from the source may differ from the original", function (this: BbWorld) {
  const far = beliefsOfFact(this).filter((b) => (b.hops ?? 0) >= 2);
  assert.ok(far.length > 0, "there should be beliefs several hops out");
  assert.ok(far.some((b) => b.content !== this.gossipOriginal), "a far version should differ from the original");
});

Then("distortion tends to grow with the number of hops", function (this: BbWorld) {
  const sorted = beliefsOfFact(this).sort((a, b) => (a.hops ?? 0) - (b.hops ?? 0));
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i]!.hops ?? 0) > (sorted[i - 1]!.hops ?? 0)) {
      assert.ok(
        (sorted[i]!.distortion ?? 0) > (sorted[i - 1]!.distortion ?? 0),
        "more hops should mean more distortion",
      );
    }
  }
});

Given("the player is told a fact second-hand", function (this: BbWorld) {
  // npc(1) -> npc(2) -> player: the player learns it at the second hop.
  this.graph = makeSocialGraph([[npc(1), npc(2)], [npc(2), PLAYER]]);
  this.gossipNodes = [npc(1), npc(2), PLAYER];
  this.gossipOrigin = npc(1);
  const res = diffuseGossip({
    knowledge: this.sandbox.engine.knowledge,
    graph: this.graph,
    rng: new SeededRandom(5),
    origin: npc(1),
    fact: { content: "the Head of Household is targeting you" },
    rounds: 4,
    transmitProb: 1,
  });
  this.factId = res.factId;
  this.gossipOriginal = res.original;
});

Then(
  "it enters the player's knowledge as a belief carrying its source and confidence",
  function (this: BbWorld) {
    const belief = this.sandbox.engine.knowledge.knownTo(PLAYER).find((k) => k.factId === this.factId);
    assert.ok(belief, "the player should hold the second-hand belief");
    assert.ok(belief!.source, "belief carries its source");
    assert.ok(typeof belief!.confidence === "number", "belief carries a confidence");
    assert.ok((belief!.hops ?? 0) >= 2, "the player heard it second-hand (>= 2 hops)");
  },
);

Then(
  "that belief may be inaccurate, so the player acts on imperfect information",
  function (this: BbWorld) {
    const belief = this.sandbox.engine.knowledge.knownTo(PLAYER).find((k) => k.factId === this.factId);
    assert.ok(belief, "the player should hold the belief");
    assert.ok(belief!.confidence! < 1, "second-hand confidence is below certainty");
    assert.ok(belief!.content !== this.gossipOriginal, "the belief has drifted from the original (may be wrong)");
  },
);
