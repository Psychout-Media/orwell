import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EvictionManner } from "../../src/engine/jury";
import { FINALE_APPEALS, appealEffect, bestAppeal } from "../../src/engine/jury";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../support/answerPending";
import { assertNoSentinels } from "../../tests/support/assertions";
import { PLAYER, npc } from "../../src/domain/ids";
import { adv, liveFinale, driveFinaleSeam, JURY9 } from "../support/liveFinale";
import type { Player } from "../support/liveFinale";

// Feature 0037 — the LIVE jury-vote choreography over liveSeason.ts + GameSessionAdapter
// (advanceGame/submitDecision through the MCP player channel). HARD rule: roles only —
// finalist / juror / evictee / player; never houseguest or player names. The vote is
// ENGINE-decided; the player's structured appeal choice sways close jurors, never the prose.

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
  // dominance (AMEND 0037, 2026-11-04): the LEADER is the NPC finalist (strong accumulated jury relationships); the PLAYER is the UNDERDOG finalist and
  // plays EACH legal finale appeal in turn (including the engine's strongest one for these jurors). Jury management must still carry the leader every time.
  const leader = B, underdog = A;
  const runs = 40;
  const rates: Record<string, number> = {};
  for (const appeal of FINALE_APPEALS) {
    let leaderWins = 0;
    for (let seed = 1; seed <= runs; seed++) {
      const { reg } = await liveFinale(`dom-${appeal}-${seed}`, seed, {
        finalists: [underdog, leader], jury: JURY9,
        edgeTo: (_j, f) => (f === leader ? { trust: 0.85, affinity: 0.85, threat: 0.1 } : { trust: 0.3, affinity: 0.3, threat: 0.45 }),
      });
      const p = reg.resolver()("player", `dom-${appeal}-${seed}`) as Player;
      const views = await driveFinaleSeam(p, { appeal });
      const final = views[views.length - 1]!;
      if (final.winner?.id === leader) leaderWins++;
    }
    rates[appeal] = leaderWins / runs;
  }
  this.domRatesByAppeal = rates;
  this.domWinRate = Math.min(...Object.values(rates)); // the leader's WORST case = the underdog's best appeal
});

Then("that juror votes for that finalist in a reduced share of runs", function (this: BbWorld) {
  // AMEND 0037: a stated minimum gap, not a bare `<` (which a 1/60 flip would satisfy): over the 60 runs the respected juror must vote for the finalist
  // at least MANNER_MIN_GAP more often than the betrayed juror does.
  const MANNER_MIN_GAP = 0.15;
  assert.ok(
    this.mannerShareRespected! - this.mannerShareBetrayed! >= MANNER_MIN_GAP,
    `respected share ${this.mannerShareRespected} should exceed betrayed share ${this.mannerShareBetrayed} by at least ${MANNER_MIN_GAP}`,
  );
});

// NOTE: "Then that finalist wins the clear majority of runs" is shared with 0014 (jury_endgame);
// that definition branches on this.domWinRate to assert the LIVE run when 0037 set it.

Then("the player's strongest legal finale appeals do not overturn that clear lead", function (this: BbWorld) {
  // The PLAYER is the underdog finalist here and played every legal appeal; the leader (strong accumulated relationships) wins > 85% against EACH,
  // including the engine's strongest appeal for these jurors (named below so the claim is about the strongest, not just the weakest).
  const rates = this.domRatesByAppeal!;
  const strongest = bestAppeal({ trust: 0.3, affinity: 0.3, threat: 0.45 }, {});
  assert.ok(FINALE_APPEALS.includes(strongest) && appealEffect(strongest, { trust: 0.3, affinity: 0.3, threat: 0.45 }) >= Math.max(...FINALE_APPEALS.map((a) => appealEffect(a, { trust: 0.3, affinity: 0.3, threat: 0.45 }))), "the engine's strongest appeal for these jurors was among those played");
  for (const [appeal, rate] of Object.entries(rates)) {
    assert.ok(rate > 0.85, `the leader must keep a clear lead against the underdog's "${appeal}" appeal (leader win rate ${rate}; strongest is "${strongest}")`);
  }
});

// --- S4b: the player-juror's vote card reflects ONLY what their askJuror tellings surfaced (A-13, #2010/#2013) ----

let jbN = 0;
Given("a live game where the player is a juror at their finale vote card", function (this: BbWorld) {
  for (let seed = 1; seed <= 120; seed++) {
    const sb = new GameSessionRegistry().sandboxFor(`jb${jbN++}`);
    sb.session.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 9000; i++) {
      const v = sb.session.advanceGame();
      if (v.pending?.kind === "juror-vote" && (sb.session.getGameState().juryHouse?.jurors.length ?? 0) >= 1) {
        this.jbSandbox = sb; this.jbPending = v.pending; this.jbTold = [];
        return;
      }
      if (v.pending) resolvePending(v.pending, (req) => void sb.session.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("no seed reached a juror-vote card with a jury house");
});

Then("the vote card carries no juror-held tellings", function (this: BbWorld) {
  assert.equal(this.jbPending!.jurorBrief, undefined, "before any askJuror the card has no brief");
  assert.ok(!("jurorBrief" in this.jbSandbox!.session.advanceGame().pending!), "...and the re-read card is unchanged too");
});

When("the player asks one fellow juror what they know and the juror tells them", function (this: BbWorld) {
  const sb = this.jbSandbox!;
  const [f1] = this.jbPending!.options;
  const [juror] = sb.session.getGameState().juryHouse!.jurors;
  const core = sb.session.snapshot();
  core.live!.mannerByEvictee = { ...(core.live!.mannerByEvictee ?? {}), [juror!.id]: { [PLAYER]: { respected: true } } } as never; // a warm juror always tells
  sb.session.restore(core);
  const seed = (factId: string, content: string): void => { sb.engine.knowledge.seedBelief(juror!.id, { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: juror!.id }, "origin"); };
  seed("jvc:told", `MARK-TOLD ${f1!.name} kept their word`);
  seed("traitors-fury:blame:x", `MARK-BLAME ${f1!.name} voted against them`); // a sealed ballot attribution: must never ride a telling or the card
  let landed = false;
  for (let i = 0; i < 15 && !landed; i++) {
    const r = sb.session.askJuror(juror!.id);
    if (r?.told && r.content) this.jbTold!.push(r.content);
    landed = !!r?.content?.includes("MARK-TOLD");
  }
  assert.ok(landed, "precondition: the marked fact was told through askJuror");
  seed("jvc:held", `MARK-HELD ${f1!.name} did something unspoken`); // held by the juror but never told
  // a `told-by:<juror>` fact that reached the player OUTSIDE the jury-house askJuror (e.g. told earlier in the house) is not "what their askJuror tellings surfaced"
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: `MARK-EARLIER ${f1!.name} was told to me before`, subject: f1!.id, confidence: 0.7 }, `told-by:${juror!.id}`);
  this.jbF1 = f1!.id;
});

Then("the vote card reflects exactly that telling and nothing the juror merely holds", function (this: BbWorld) {
  const card = this.jbSandbox!.session.advanceGame().pending!;
  assert.ok(card.jurorBrief, "the card now carries the brief");
  const heard = card.jurorBrief!.flatMap((b) => b.heard);
  assert.ok(heard.join(" ").includes("MARK-TOLD"), "the told fact is on the card");
  assert.ok(heard.length <= this.jbTold!.length, `the brief holds at most what was actually told (${heard.length} heard vs ${this.jbTold!.length} told)`);
  const blob = JSON.stringify(card);
  assert.ok(!blob.includes("MARK-HELD"), "a fact the juror merely holds never rides the card");
  assert.ok(!blob.includes("MARK-BLAME"), "a sealed blame attribution never rides the card");
  assert.ok(!blob.includes("MARK-EARLIER"), "a telling that did not come through askJuror is not on the card");
  assert.ok(!this.jbTold!.some((c) => c.includes("MARK-BLAME")), "...nor is it ever told");
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
