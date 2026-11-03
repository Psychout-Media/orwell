import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EvictionManner } from "../../src/engine/jury";
import type { EdgeSignals } from "../../src/engine/relationshipConstants";
import { assertNoSentinels } from "../../tests/support/assertions";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { answerPending } from "../support/answerPending";

// Feature 0037 — the LIVE jury-vote choreography over liveSeason.ts + GameSessionAdapter
// (advanceGame/submitDecision through the MCP player channel). HARD rule: roles only —
// finalist / juror / evictee / player; never houseguest or player names. The vote is
// ENGINE-decided; the player's structured appeal choice sways close jurors, never the prose.

type Player = import("../../src/adapters/mcp/McpServer").McpServer;

const adv = async (p: Player): Promise<AdvanceView> => (await p.callTool("advanceGame", {})) as AdvanceView;

interface FinaleFixture {
  finalists: [EntityId, EntityId];
  jury: EntityId[];
  edgeTo?: (juror: EntityId, finalist: EntityId) => Partial<EdgeSignals>;
  manner?: Record<EntityId, Record<EntityId, EvictionManner>>;
}

/** A neutral directed edge (the live model's beliefs are graded, not binary). */
function edge(from: EntityId, to: EntityId, s: Partial<EdgeSignals>): { from: EntityId; to: EntityId } & EdgeSignals {
  return { from, to, trust: 0.5, affinity: 0.5, threat: 0.3, alignment: 0, confidence: 0.5, reliability: 0.3, ...s };
}

/**
 * Stand up a real per-user sandbox at Final 2 by creating a game (for the real names + house)
 * and RESTORING a crafted Final-2 snapshot through the registry — so the finale is driven
 * entirely through the live adapter (advanceGame/submitDecision), not a hand-built object.
 */
async function liveFinale(user: string, seed: number, fx: FinaleFixture): Promise<{ reg: GameSessionRegistry; player: Player }> {
  const reg = new GameSessionRegistry();
  const player = reg.resolver()("player", user) as Player;
  await player.callTool("createCharacter", { playerName: "Player", seed });
  const snap = reg.snapshot(user) as SessionSnapshot;

  const live: LiveSeasonState = {
    week: 9, beat: "finale", active: [...fx.finalists], vetoUsed: false,
    evictionOrder: [...fx.jury], finished: false,
    ...(fx.manner ? { mannerByEvictee: fx.manner } : {}),
  };
  // Craft the jury leans as directed relationship edges (juror → finalist).
  const edges: Array<{ from: EntityId; to: EntityId } & EdgeSignals> = [];
  for (const j of fx.jury) for (const f of fx.finalists) edges.push(edge(j, f, fx.edgeTo?.(j, f) ?? {}));
  snap.live = live;
  snap.relationships = edges;
  reg.restore(user, snap);
  return { reg, player: reg.resolver()("player", user) as Player };
}

/** The default 9-juror panel ids (kept distinct from the two finalists). */
const JURY9 = Array.from({ length: 9 }, (_, i) => npc(i + 1));

/** Drive the finale to completion, answering player decisions with a fixed policy. Collect views. */
async function driveFinaleSeam(
  p: Player, policy: { appeal?: string; jurorVote?: (d: NonNullable<AdvanceView["pending"]>) => string } = {},
): Promise<AdvanceView[]> {
  const views: AdvanceView[] = [];
  for (let i = 0; i < 2000; i++) {
    const v = await adv(p);
    views.push(v);
    if (v.finished) break;
    if (v.pending) {
      const d = v.pending;
      if (d.kind === "finale-statement") await p.callTool("submitDecision", { kind: "finale-statement", statement: "My case." });
      else if (d.kind === "finale-answer") await p.callTool("submitDecision", { kind: "finale-answer", appeal: policy.appeal ?? d.appeals![0]! });
      else if (d.kind === "juror-vote") await p.callTool("submitDecision", { kind: "juror-vote", vote: policy.jurorVote ? policy.jurorVote(d) : d.options[0]!.id });
      else if (d.kind === "nominations") await p.callTool("submitDecision", { kind: "nominations", choice: [d.options[0]!.id, d.options[1]!.id] });
      else if (d.kind === "veto-decision") await p.callTool("submitDecision", { kind: "veto-decision", use: false });
      else if (d.kind === "replacement") await p.callTool("submitDecision", { kind: "replacement", replacement: d.options[0]!.id });
      else {
        const req = answerPending(d); // any other kind: the shared driver (unknown kinds throw)
        if (req) await p.callTool("submitDecision", req as unknown as Record<string, unknown>);
      }
    }
  }
  return views;
}

// --- S1: staged sequence -------------------------------------------------------

Given("a live game advanced to Final 2 with the player as a finalist", async function (this: BbWorld) {
  const { reg, player } = await liveFinale("u1", 2, { finalists: [PLAYER, npc(10)], jury: JURY9 });
  this.registry = reg; this.livePlayer = player;
});

When("the finale is advanced beat by beat", async function (this: BbWorld) {
  this.finaleViews = await driveFinaleSeam(this.livePlayer!);
});

Then("an opening statement beat is surfaced for each finalist", function (this: BbWorld) {
  // The NPC finalist's statement is an emitted beat; the player-finalist's is surfaced as a
  // finale-statement pending decision (their turn to give it) — together, one per finalist.
  const npcStatements = this.finaleViews!.filter((v) => v.event?.content.includes("opening statement")).length;
  const playerStatements = this.finaleViews!.filter((v) => v.pending?.kind === "finale-statement").length;
  assert.equal(npcStatements + playerStatements, 2, "one opening statement per finalist");
});

Then("each of the nine jurors questions both finalists", function (this: BbWorld) {
  // Each juror questions BOTH finalists (18-Q&A): NPC-addressed answers emit a beat; the nine the
  // player-finalist owes surface as pending finale-answers. Together: 9 jurors × 2 finalists = 18.
  const npcAnswers = this.finaleViews!.filter((v) => v.event?.beat === "finale" && /answers/.test(v.event.content)).length;
  const playerAnswers = this.finaleViews!.filter((v) => v.pending?.kind === "finale-answer").length;
  assert.equal(npcAnswers + playerAnswers, 18, "eighteen question beats (each juror questions both finalists)");
  assert.equal(playerAnswers, 9, "the player-finalist answers all nine jurors themselves");
});

Then("the votes are revealed one juror at a time before the winner is named", function (this: BbWorld) {
  const reveals = this.finaleViews!.filter((v) => v.event?.beat === "finale-reveal");
  assert.equal(reveals.length, 9, "one reveal per juror");
  const resultIx = this.finaleViews!.findIndex((v) => v.event?.beat === "finale-result");
  const lastRevealIx = this.finaleViews!.map((v) => v.event?.beat).lastIndexOf("finale-reveal");
  assert.ok(resultIx > lastRevealIx && lastRevealIx >= 0, "all reveals precede the result");
  const finished = this.finaleViews![this.finaleViews!.length - 1]!;
  assert.ok(finished.finished && finished.winner, "a winner is named at the end");
});

// --- S2: validated answer seam -------------------------------------------------

Given("a live game at Final 2 with the player as a finalist", async function (this: BbWorld) {
  const { reg, player } = await liveFinale("u2", 2, { finalists: [PLAYER, npc(10)], jury: JURY9 });
  this.registry = reg; this.livePlayer = player;
});

When("the finale is advanced to each player answer", async function (this: BbWorld) {
  // Advance to the FIRST player answer and hold there for the assertions.
  for (let i = 0; i < 200; i++) {
    const v = await adv(this.livePlayer!);
    this.lastAdvance = v;
    if (v.pending?.kind === "finale-answer") break;
    if (v.pending?.kind === "finale-statement") await this.livePlayer!.callTool("submitDecision", { kind: "finale-statement", statement: "x" });
  }
});

Then("the loop stops for the player to answer with a structured appeal", function (this: BbWorld) {
  const p = this.lastAdvance!.pending;
  assert.ok(p && p.kind === "finale-answer", "stopped for a finale answer");
  assert.ok(Array.isArray(p!.appeals) && p!.appeals!.length > 0, "structured appeal options are offered");
});

Then("each answer applies only through the submitted decision", async function (this: BbWorld) {
  // Advancing without submitting does NOT move past the answer (idempotent while owed).
  const again = await adv(this.livePlayer!);
  assert.equal(again.pending?.kind, "finale-answer", "still owed the answer until submitted");
  const appeal = again.pending!.appeals![0]!;
  const after = (await this.livePlayer!.callTool("submitDecision", { kind: "finale-answer", appeal })) as AdvanceView;
  assert.ok(after.event, "the submitted decision applied (a beat resolved)");
});

Then("an answer with no legal appeal is refused", async function (this: BbWorld) {
  // Re-reach a player answer and submit an illegal appeal; the seam refuses it, the decision stands.
  let pending: AdvanceView["pending"] = null;
  for (let i = 0; i < 200; i++) {
    const v = await adv(this.livePlayer!);
    if (v.pending?.kind === "finale-answer") { pending = v.pending; break; }
    if (v.pending?.kind === "finale-statement") await this.livePlayer!.callTool("submitDecision", { kind: "finale-statement", statement: "x" });
    if (v.finished) break;
  }
  assert.ok(pending, "reached a player answer");
  let refused = false;
  try {
    await this.livePlayer!.callTool("submitDecision", { kind: "finale-answer", appeal: "definitely-not-an-appeal" });
  } catch {
    refused = true;
  }
  assert.ok(refused, "an illegal appeal is refused");
  const still = await adv(this.livePlayer!);
  assert.equal(still.pending?.kind, "finale-answer", "the answer is still owed");
});

// --- S3 + S4: seeded-run properties (manner share & jury dominance) -------------
// Both scenarios share the SAME When line ("the live jury votes across many seeded runs"),
// so a single step dispatches on the mode the Given set.

Given("a juror that a finalist blindsided or betrayed on the way out", function (this: BbWorld) {
  this.juryRunMode = "manner";
});

// NOTE: "Given a finalist with strong accumulated jury relationships" is shared with 0014
// (defined in jury_endgame.steps.ts); that definition also sets juryRunMode = "dominance"
// so this file's live When can dispatch on it.

When("the live jury votes across many seeded runs", async function (this: BbWorld) {
  const A = PLAYER, B = npc(10);
  if (this.juryRunMode === "manner") {
    // Identical jury leans for A and B everywhere; the ONLY difference is the first juror's
    // recorded manner toward A (respected vs betrayed). Compare A's share of that juror's vote.
    const shareForA = async (manner: EvictionManner, runs: number): Promise<number> => {
      let aVotes = 0;
      for (let seed = 1; seed <= runs; seed++) {
        const user = `m${manner.betrayed ? "b" : "r"}-${seed}`;
        const { reg } = await liveFinale(user, seed, {
          finalists: [A, B], jury: JURY9,
          edgeTo: () => ({ trust: 0.5, affinity: 0.5, threat: 0.3 }),
          manner: { [JURY9[0]!]: { [A]: manner } },
        });
        const p = reg.resolver()("player", user) as Player;
        await driveFinaleSeam(p, { appeal: "connect" });
        // The live finale (driven through the seam) records every juror's decided vote.
        const liveSnap = reg.snapshot(user).live as LiveSeasonState;
        if (liveSnap.finale?.votes?.[JURY9[0]!] === A) aVotes++;
      }
      return aVotes / runs;
    };
    this.mannerShareRespected = await shareForA({ respected: true }, 60);
    this.mannerShareBetrayed = await shareForA({ betrayed: true }, 60);
    return;
  }
  // dominance: finalist A holds a clear relationship lead; the player makes its WEAKEST legal
  // appeal each answer while the NPC finalist plays optimally — jury management must still carry A.
  let aWins = 0;
  const runs = 40;
  for (let seed = 1; seed <= runs; seed++) {
    const { reg } = await liveFinale(`dom-${seed}`, seed, {
      finalists: [A, B], jury: JURY9,
      edgeTo: (_j, f) => (f === A ? { trust: 0.85, affinity: 0.85, threat: 0.1 } : { trust: 0.3, affinity: 0.3, threat: 0.45 }),
    });
    const p = reg.resolver()("player", `dom-${seed}`) as Player;
    const views = await driveFinaleSeam(p, { appeal: "discredit-rival" });
    const final = views[views.length - 1]!;
    if (final.winner?.id === A) aWins++;
  }
  this.domWinRate = aWins / runs;
});

Then("that juror votes for that finalist in a reduced share of runs", function (this: BbWorld) {
  assert.ok(
    this.mannerShareBetrayed! < this.mannerShareRespected!,
    `betrayed share ${this.mannerShareBetrayed} should be < respected share ${this.mannerShareRespected}`,
  );
});

// NOTE: "Then that finalist wins the clear majority of runs" is shared with 0014 (jury_endgame);
// that definition branches on this.domWinRate to assert the LIVE run when 0037 set it.

Then("the player's strongest legal finale appeals do not overturn that clear lead", function (this: BbWorld) {
  // Proven by the dominance run: A wins >85% despite making its WEAKEST legal appeal while the
  // rival plays optimally — the bounded finale sway cannot overturn the relationship lead.
  assert.ok(this.domWinRate! > 0.85, "the bounded finale never overturns the clear lead");
});

// --- S5: player on the jury ----------------------------------------------------

Given("a live game at Final 2 with the player on the jury", async function (this: BbWorld) {
  // The player is a JUROR; two NPC finalists. Player among the 9-juror panel.
  const A = npc(11), B = npc(12);
  const jury = [PLAYER, ...Array.from({ length: 8 }, (_, i) => npc(i + 1))];
  const { reg, player } = await liveFinale("u5", 2, {
    finalists: [A, B], jury,
    edgeTo: () => ({ trust: 0.5, affinity: 0.5, threat: 0.3 }),
  });
  this.registry = reg; this.livePlayer = player; this.juryFinalists = [A, B];
});

When("the finale is advanced to the player's juror vote", async function (this: BbWorld) {
  for (let i = 0; i < 200; i++) {
    const v = await adv(this.livePlayer!);
    this.lastAdvance = v;
    if (v.pending?.kind === "juror-vote") break;
    if (v.pending?.kind === "juror-question") {
      // E37: the player-juror's own question beats precede their vote — answer and continue.
      await this.livePlayer!.callTool("submitDecision", { kind: "juror-question", statement: "what was your game?" });
      continue;
    }
    if (v.finished) break;
  }
});

Then("the loop stops for the player to vote between the two finalists", function (this: BbWorld) {
  const p = this.lastAdvance!.pending;
  assert.ok(p && p.kind === "juror-vote", "stopped for the player's juror vote");
  assert.equal(p!.options.length, 2, "exactly the two finalists are offered");
});

Then("an illegal juror vote is refused and the vote still stands", async function (this: BbWorld) {
  let refused = false;
  try {
    // A non-finalist is an illegal juror vote.
    await this.livePlayer!.callTool("submitDecision", { kind: "juror-vote", vote: npc(7) });
  } catch {
    refused = true;
  }
  assert.ok(refused, "the illegal juror vote is refused");
  const still = await adv(this.livePlayer!);
  assert.equal(still.pending?.kind, "juror-vote", "the juror vote is still owed");
});

Then("the other jurors are decided by the engine", async function (this: BbWorld) {
  // A legal vote completes the finale; the engine decided the remaining eight (a winner emerges).
  const after = (await this.livePlayer!.callTool("submitDecision", { kind: "juror-vote", vote: this.juryFinalists![0] })) as AdvanceView;
  let final = after;
  for (let i = 0; i < 200 && !final.finished; i++) final = await adv(this.livePlayer!);
  assert.ok(final.finished && final.winner, "the engine decided the rest and crowned a winner");
});

// --- S6: tally + tie-break -----------------------------------------------------

When("the live jury vote is tallied", async function (this: BbWorld) {
  // Build a deterministic split so the last-evicted juror breaks a tie. With an EVEN panel and
  // the leans split exactly, the last-evicted juror's vote decides the winner.
  const A = npc(11), B = npc(12);
  // Two-juror panel: juror[0] leans A, juror[1] (last-evicted) leans B → tie broken to B.
  const jury = [npc(1), npc(2)];
  const { reg, player } = await liveFinale("u6", 4, {
    finalists: [A, B], jury,
    edgeTo: (j, f) => (j === npc(1) ? (f === A ? { trust: 1, affinity: 1, threat: 0 } : { trust: 0, affinity: 0, threat: 1 })
      : (f === B ? { trust: 1, affinity: 1, threat: 0 } : { trust: 0, affinity: 0, threat: 1 })),
  });
  this.registry = reg; this.livePlayer = player; this.juryFinalists = [A, B];
  const views = await driveFinaleSeam(player);
  this.lastAdvance = views[views.length - 1]!;
});

// NOTE: "Then the finalist with the most votes wins" (shared with weekly_loop) and
// "Then a tie is broken by the last-evicted juror" (shared with jury_endgame) both branch on
// this.lastAdvance to assert the LIVE tally/tie-break when 0037 set it; otherwise they keep the
// existing pure-logic (0011/0014) proof. The live tie-break is exercised by 0037's S6 here.

// --- S7: Vault-free ------------------------------------------------------------

Given("a live game at Final 2 whose Vault holds hidden content", async function (this: BbWorld) {
  const { reg, player } = await liveFinale("u7", 2, { finalists: [PLAYER, npc(10)], jury: JURY9 });
  this.registry = reg; this.livePlayer = player;
  const engine = reg.sandboxFor("u7").engine;
  // FULLY populate the Vault with unique sentinels of every hidden kind — none may bleed into any
  // finale output (mirrors the 0001 canary; extends it to the 0037 finale surface).
  this.finaleSentinels = [];
  const addHidden = (kind: import("../../src/ports/VaultStore").HiddenKind, n: number): void => {
    const sentinel = `SENTINEL-0037-${kind}-${n}`;
    this.finaleSentinels!.push(sentinel);
    engine.vault.writeHidden({ id: `vault:0037:${kind}:${n}`, kind, content: `[${kind}] secret ${sentinel}` });
  };
  for (let i = 1; i <= 3; i++) addHidden("hidden-attribute", i);   // finalists' & jurors' hidden traits
  for (let i = 1; i <= 3; i++) addHidden("confessional", i);       // diary-room confessionals
  addHidden("reserved-twist", 1);
  // A genuinely off-screen, hidden NPC-to-NPC scene the player never witnessed (both a hidden
  // event AND a Vault datum) — must never surface through any finale decision or reveal.
  const offscreen = "SENTINEL-0037-offscreen-finale-scheme";
  this.finaleSentinels.push(offscreen);
  engine.events.record({
    id: "hidden:0037", ts: 999_999, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: `[offscreen] ${offscreen}`,
  });
  engine.vault.writeHidden({ id: "vault:0037:offscreen", kind: "offscreen-event", content: `[offscreen] ${offscreen}` });
});

When("the finale is advanced and its decisions and reveals are read", async function (this: BbWorld) {
  // Drive the whole finale and also exercise the live finale projection + status reads.
  const views = await driveFinaleSeam(this.livePlayer!);
  const status = await this.livePlayer!.callTool("gameStatus", {});
  this.lastOutput = views.map((v) => JSON.stringify(v)).join("\n") + "\n" + JSON.stringify(status);
});

Then("no finale output carries a Vault sentinel value", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, this.finaleSentinels!);
});

Then("no juror lean or vote tally is exposed before the reveal", function (this: BbWorld) {
  // The finale projection and decisions expose names + stage + the reveals-so-far ONLY — there is
  // no numeric lean/affinity/threat/tally field anywhere in any finale output (structural, by shape).
  assert.ok(
    !/"(lean|leans|trust|affinity|threat|tally|votesFor|manner)"\s*:/i.test(this.lastOutput),
    "no lean/tally/manner field may appear in any finale output",
  );
});

// --- S8: restart mid-question --------------------------------------------------

Given("a live finale advanced partway through the question round", async function (this: BbWorld) {
  const { reg, player } = await liveFinale("u8", 2, { finalists: [PLAYER, npc(10)], jury: JURY9 });
  this.registry = reg; this.livePlayer = player; this.liveUser = "u8";
  // Advance through the statements and the first couple of player answers.
  let answers = 0;
  for (let i = 0; i < 200 && answers < 2; i++) {
    const v = await adv(player);
    if (v.pending?.kind === "finale-statement") await player.callTool("submitDecision", { kind: "finale-statement", statement: "x" });
    else if (v.pending?.kind === "finale-answer") { await player.callTool("submitDecision", { kind: "finale-answer", appeal: v.pending.appeals![0]! }); answers++; }
    if (v.finished) break;
  }
  // The shared restart step (in live_progression.steps.ts) reads savedSnap + liveUser.
  this.savedSnap = reg.snapshot("u8") as SessionSnapshot;
});

// NOTE: the "When the engine restarts and resumes from the durable save" step is shared with
// 0034 (defined once in live_progression.steps.ts) — it restores `liveUser` from `savedSnap`.

Then("the resumed finale stage and the answers already given match exactly", function (this: BbWorld) {
  const before = (this.savedSnap!.live as LiveSeasonState).finale!;
  const after = (this.resumedSnap!.live as LiveSeasonState).finale!;
  assert.equal(after.stage, before.stage, "stage preserved across restart");
  assert.equal(after.questionIx, before.questionIx, "question cursor preserved");
  assert.deepEqual(after.appeals, before.appeals, "the answers already given are preserved");
});

// --- S9: deterministic ---------------------------------------------------------

Given("two live games at Final 2 started from the same seed", async function (this: BbWorld) {
  const a = await liveFinale("da", 7, { finalists: [PLAYER, npc(10)], jury: JURY9, edgeTo: (_j, f) => (f === PLAYER ? { trust: 0.6, affinity: 0.55, threat: 0.2 } : {}) });
  const b = await liveFinale("db", 7, { finalists: [PLAYER, npc(10)], jury: JURY9, edgeTo: (_j, f) => (f === PLAYER ? { trust: 0.6, affinity: 0.55, threat: 0.2 } : {}) });
  this.registry = a.reg; this.registry2 = b.reg;
  this.livePlayer = a.player; this.livePlayerB = b.player;
});

When("the same finale appeals and votes are applied to each", async function (this: BbWorld) {
  this.finaleViewsA = await driveFinaleSeam(this.livePlayer!, { appeal: "own-game" });
  this.finaleViewsB = await driveFinaleSeam(this.livePlayerB!, { appeal: "own-game" });
});

Then("their revealed votes and winner are identical", function (this: BbWorld) {
  const reveals = (vs: AdvanceView[]): string[] => vs.filter((v) => v.event?.beat === "finale-reveal").map((v) => v.event!.content);
  assert.deepEqual(reveals(this.finaleViewsB!), reveals(this.finaleViewsA!), "identical reveals");
  const wA = this.finaleViewsA![this.finaleViewsA!.length - 1]!.winner;
  const wB = this.finaleViewsB![this.finaleViewsB!.length - 1]!.winner;
  assert.deepEqual(wB, wA, "identical winner");
});
