import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { liveGameAtPending, liveReplacementLegalSet, liveStateOf } from "../support/liveDecision";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { RelationshipModel } from "../../src/engine/relationships";
import { assertNoSentinels } from "../../tests/support/assertions";
import { PLAYER, npc } from "../../src/domain/ids";

// --- Binding decision only via the validated path -----------------------------
// Audit 2026-10-25: these steps used to run against `src/engine/decisions.ts`, a seam production replaced
// with `liveSeason.applyDecision`. They now park a REAL game at the player's decision (see
// `features/support/liveDecision.ts`) and bind it through the session's own `submitDecision`.

Given("a pending eviction vote", function (this: BbWorld) {
  this.liveDecision = liveGameAtPending("eviction-vote");
  this.liveBefore = liveStateOf(this.liveDecision.sb);
  this.decisionResult = undefined;
});

When("the player says in free-text that they would probably vote out the nominee", function (this: BbWorld) {
  // Free-text lobbying is recorded as a scene through the live command seam — it does NOT cast a vote.
  const { sb, pending } = this.liveDecision!;
  sb.commands.recordInteraction({
    initiator: PLAYER, witnessSet: [PLAYER, pending.options[0]!.id], content: "Honestly I'd probably vote out that nominee.",
  });
});

Then("no vote is recorded", function (this: BbWorld) {
  const { sb, pending } = this.liveDecision!;
  assert.equal(this.decisionResult, undefined);
  const still = sb.session.gameStatus().pending;
  assert.equal(still?.kind, "eviction-vote", "the eviction vote is still pending");
  assert.deepEqual(still?.options.map((o) => o.id), pending.options.map((o) => o.id), "the same ballot is still open");
});

When("the player makes the choice through the validated decision path", function (this: BbWorld) {
  const { sb, pending } = this.liveDecision!;
  this.liveBeatSeq = sb.session.gameStatus().beatSeq;
  this.liveTapped = pending.options[0]!.id;
  this.liveSubmitted = sb.session.submitDecision({ kind: "eviction-vote", vote: this.liveTapped });
  this.decisionResult = { recorded: true, choice: [this.liveTapped] };
});

Then("the vote is recorded", function (this: BbWorld) {
  const { sb } = this.liveDecision!;
  assert.ok(sb.session.gameStatus().beatSeq > this.liveBeatSeq!, "the ballot committed (beatSeq advanced)");
  assert.notEqual(sb.session.gameStatus().pending?.kind, "eviction-vote", "the player's ballot is no longer open");
  // The ballot itself: the engine stored exactly the player's choice.
  assert.equal(sb.session.snapshot().live!.eviction?.voteOf[PLAYER], this.liveTapped, "the stored ballot is the player's pick");
});

// --- Presented options equal the engine's legal set ---------------------------

Given("a pending replacement-nominee decision", function (this: BbWorld) {
  this.liveDecision = liveGameAtPending("replacement");
  this.liveBefore = liveStateOf(this.liveDecision.sb);
});

When("the agent surfaces the options", function (this: BbWorld) {
  // The agent reads the pending off the session's own status view — the same view the FE renders.
  this.liveOptions = this.liveDecision!.sb.session.gameStatus().pending!.options.map((o) => o.id);
});

Then("the options are exactly the engine's legal set", function (this: BbWorld) {
  assert.deepEqual([...this.liveOptions!].sort(), liveReplacementLegalSet(this.liveDecision!.sb).sort());
});

Then("the veto winner is not among them", function (this: BbWorld) {
  const holder = this.liveDecision!.sb.session.snapshot().live!.vetoHolder;
  assert.ok(holder, "a replacement decision follows a used veto");
  assert.ok(!this.liveOptions!.includes(holder));
});

// --- Illegal choice rejected --------------------------------------------------

Given("a pending decision with a known legal option set", function (this: BbWorld) {
  // The player is HOH, so the player can never be named a nominee.
  this.liveDecision = liveGameAtPending("nominations");
  this.liveBefore = liveStateOf(this.liveDecision.sb);
  this.decisionRejected = undefined;
  this.decisionResult = undefined;
});

When("the player attempts a choice outside that set", function (this: BbWorld) {
  const { sb, pending } = this.liveDecision!;
  // HOH naming themself → the engine's own eligibility refusal (and ONLY that error counts as a rejection).
  assert.throws(
    () => sb.session.submitDecision({ kind: "nominations", choice: [PLAYER, pending.options[0]!.id] }),
    /illegal nominee/,
  );
  this.decisionRejected = true;
});

Then("the engine rejects it", function (this: BbWorld) {
  assert.equal(this.decisionRejected, true);
});

Then("the game state is unchanged", function (this: BbWorld) {
  // 0061 (self-eviction cancel): the season state is byte-identical apart from the cleared
  // confirmation flag — the cancel folded nothing and evicted no one.
  if (this.svSandbox && this.svStateBefore !== undefined) {
    const live = this.svSandbox.session.snapshot().live;
    const after = JSON.stringify({ ...live, selfEvictPending: undefined });
    const before = JSON.stringify({ ...JSON.parse(this.svStateBefore), selfEvictPending: undefined });
    assert.equal(after, before, "the game state is otherwise unchanged");
    assert.ok(!live?.selfEvictPending, "the confirmation was cleared");
    return;
  }
  // A live decision game: the refused choice left the season exactly as it was.
  if (this.liveDecision && this.liveBefore !== undefined) {
    assert.equal(liveStateOf(this.liveDecision.sb), this.liveBefore, "the refused choice changed nothing");
    return;
  }
  assert.equal(this.decisionResult, undefined); // nothing was executed
});

// --- The agent cannot fabricate an outcome ------------------------------------
// T7: re-pointed at the LIVE seam (B55 pattern). The old gate slotted nothing the world ever
// wrote, accepted any winner (`typeof winner.name === "string"`), and its fixture OMITTED the
// relationship model — so the consequence fold it claimed to verify was impossible there. Now:
//  - the winner is the LIVE engine's, drawn from the live roster, and re-runs identically;
//  - there is no agent-settable winner field — the engine is the sole authority;
//  - recording that result as a witnessed scene FOLDS its hidden impact into a real relationship
//    model (the fold the old fixture could not exercise), proving the live consequence seam.

Given("a competition is resolved by the engine", function (this: BbWorld) {
  const game = new GameSessionAdapter();
  game.createCharacter({ playerName: "Player One", seed: 9 });
  this.compResult = game.runCompetition({ type: "endurance" });
  // Determinism per moment: the engine yields the same winner; there is no agent-set winner API.
  const again = game.runCompetition({ type: "endurance" });
  assert.deepEqual(again.winner, this.compResult.winner, "the engine's winner is reproducible, not the agent's to pick");

  // The winner is a REAL living houseguest from the live roster — not a free-text label the agent
  // could have invented.
  const roster = new Set<string>([game.getGameState().player!.id, ...game.getGameState().house.map((h) => h.id)]);
  assert.ok(roster.has(this.compResult.winner!.id), "the winner is a real houseguest the engine chose");
  this.liveCompGame = game;
});

Then("the agent narrates the engine's result", function (this: BbWorld) {
  assert.ok(this.compResult!.winner, "the engine produced the winner the agent must voice");
  // Drive the consequence fold over the live seam WITH a relationship model wired in (B55) — the
  // result becomes a witnessed scene whose hidden impact moves the relationship layer. (The agent
  // only voices the beat; recording it is what carries real consequence.)
  const rel = new RelationshipModel(0.5);
  const winner = this.compResult!.winner!.id;
  // The fold moves how the OTHER party feels about the INITIATOR — the directed edge winner→PLAYER.
  const before = rel.edge(winner, PLAYER).threat;
  const commands = new EngineCommandsAdapter(this.sandbox!.engine.events, this.sandbox!.engine.knowledge, rel);
  commands.recordInteraction({
    initiator: PLAYER,
    witnessSet: [PLAYER, winner],
    content: "The HOH comp settled — the player clashes with the new HOH, who reads them as a threat.",
    kind: "conflict",
    toward: [winner],
  });
  this.rel = rel;
  this.threatBefore = before;
});

Then("the agent cannot produce a different winner", function (this: BbWorld) {
  // The only outcome available is the engine's; there is no tool/field by which the agent sets one.
  // Re-running the SAME live competition yields the SAME winner (the engine owns it), and the
  // recorded result genuinely folded into the relationship layer — a real, hidden consequence.
  const again = this.liveCompGame!.runCompetition({ type: "endurance" });
  assert.deepEqual(again.winner, this.compResult!.winner, "no path lets the agent settle a different winner");
  const after = this.rel!.edge(this.compResult!.winner!.id, PLAYER).threat;
  assert.notEqual(after, this.threatBefore, "recording the engine's result folded a real hidden consequence");
});

// --- Free-text social play is not a binding decision --------------------------

Given("no decision is pending", function (this: BbWorld) {
  // A live game just after casting: the season is set up and nothing binding is open.
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("decision-none");
  sb.session.createCharacter({ playerName: "The Player", seed: 1 });
  assert.equal(sb.session.gameStatus().pending ?? null, null, "no decision is open");
  this.liveDecision = { sb, pending: undefined as never };
  this.liveBefore = liveStateOf(sb);
  this.decisionResult = undefined;
});

When("the player engages in free-text social conversation", function (this: BbWorld) {
  const { sb } = this.liveDecision!;
  const mate = sb.session.getGameState().house[0]!.id;
  this.liveMate = mate;
  this.liveEdgeBefore = JSON.stringify(sb.engine.relationships.edge(mate, PLAYER));
  this.ack = sb.commands.recordInteraction({
    initiator: PLAYER, witnessSet: [PLAYER, mate], content: "A warm kitchen chat.", kind: "bonding", toward: [mate],
  });
});

Then("the conversation is recorded as a witnessed event", function (this: BbWorld) {
  const visible = this.liveDecision!.sb.player.getVisibleState().visibleEvents.some((e) => e.id === this.ack!.eventId);
  assert.ok(visible, "the scene is in the player's visible projection");
});

Then("relationships may shift", function (this: BbWorld) {
  const { sb } = this.liveDecision!;
  assert.notEqual(JSON.stringify(sb.engine.relationships.edge(this.liveMate!, PLAYER)), this.liveEdgeBefore, "the hidden edge moved");
});

Then("no binding decision is made", function (this: BbWorld) {
  const { sb } = this.liveDecision!;
  assert.equal(sb.session.gameStatus().pending ?? null, null, "still no decision open");
  assert.equal(liveStateOf(sb), this.liveBefore, "the season state did not move");
  assert.equal(this.decisionResult, undefined);
});

// --- Every tool result the loop consumes is Vault-free ------------------------

When("the agent runs a full turn over the engine tools", async function (this: BbWorld) {
  const sb = this.sandbox!;
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const session = new GameSessionAdapter();
  session.createCharacter({ playerName: "Player One", seed: 1 });
  const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  const sample: Record<string, Record<string, unknown>> = {
    getVisibleStateFor: { entity: PLAYER },
    renderScene: { mode: "scene" },
    socialRead: {},
    getGameState: {},
    getMomentPrompt: { moment: "nominations" },
    runCompetition: { type: "endurance" },
    recordInteraction: { initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "turn" },
  };
  const out: string[] = [];
  for (const t of server.listTools()) {
    if (t.name in sample) out.push(JSON.stringify(await server.callTool(t.name, sample[t.name]!)));
  }
  this.lastOutput = out.join("\n");
});

Then("no tool result contains a Vault sentinel value", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, this.sandbox!.sentinels);
});
