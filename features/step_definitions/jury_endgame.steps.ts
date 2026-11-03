import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { juryLean, castJuryVote, tallyJuryVote, runFinale } from "../../src/engine/jury";
import { playSeason } from "../../src/engine/calibration";
import type { SeasonHouseguest } from "../../src/engine/season";
import { generateHouse } from "../../src/engine/characterFactory";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import { GameSessionRegistry } from "../../src/composition/registry";
import { LlmNarrativePort } from "../../src/adapters/narrative/LlmNarrativePort";
import type { NarratorTransport } from "../../src/adapters/narrative/LlmNarrativePort";
import { liveFinale, driveFinaleSeam, JURY9 } from "../support/liveFinale";

// Reused (defined in weekly_loop.steps): "the season reaches Final 2", "the earlier evictees
// are pre-jury", "a Final 2 and a jury", "the finalist with the most votes wins".

const A = npc(20);
const B = npc(21);

function build16(seed: number): SeasonHouseguest[] {
  const { npcs } = generateHouse(new SeededRandom(seed));
  return [{ id: PLAYER, stats: { physical: 0.5, mental: 0.5, social: 0.5 } }, ...npcs.map((n) => ({ id: n.id, stats: n.character.stats }))];
}

function voteRateForA(leanA: number, leanB: number, perfA = 0.5, perfB = 0.5, runs = 400): number {
  let a = 0;
  for (let s = 1; s <= runs; s++) {
    const v = castJuryVote([A, B], (f) => (f === A ? leanA : leanB), (f) => (f === A ? perfA : perfB), new SeededRandom(s));
    if (v === A) a++;
  }
  return a / runs;
}

// --- Jury composition ---------------------------------------------------------

Then("the jury is the last nine evicted houseguests", function (this: BbWorld) {
  assert.deepEqual(this.outcome!.jury, this.outcome!.evictionOrder.slice(-9));
  assert.equal(this.outcome!.jury.length, 9);
});

// --- Jury management: blindside reduces the lean ------------------------------

Given("a juror a finalist blindsided or disrespected on eviction", function (this: BbWorld) {
  this.juryRel = { trust: 0.5, affinity: 0.5, threat: 0.2 };
});

When("the jury votes across many seeded runs", function () {
  // The assertions drive the seeded runs.
});

Then("that juror's probability of voting for that finalist is reduced", function (this: BbWorld) {
  const rel = this.juryRel!;
  const leanB = juryLean(rel, {});
  const respected = voteRateForA(juryLean(rel, { respected: true }), leanB);
  const blindsided = voteRateForA(juryLean(rel, { blindsided: true }), leanB);
  const disrespected = voteRateForA(juryLean(rel, { disrespected: true }), leanB);
  assert.ok(blindsided < respected, `blindsided ${blindsided} < respected ${respected}`);
  assert.ok(disrespected < respected, `disrespected ${disrespected} < respected ${respected}`);
});

// --- Jury management dominates; finale sways the margin -----------------------

Given("a finalist with strong accumulated jury relationships", function (this: BbWorld) {
  this.juryRel = { trust: 0.85, affinity: 0.85, threat: 0.1 };
  // 0037 reuses this phrase to drive the LIVE finale; mark the run mode for its live When.
  this.juryRunMode = "dominance";
});

Then("that finalist wins the clear majority of runs", function (this: BbWorld) {
  // 0037 (live seam) records the live win rate; assert on it when present.
  if (this.domWinRate !== undefined) {
    assert.ok(this.domWinRate > 0.85, `live well-managed finalist win rate ${this.domWinRate} should exceed 0.85`);
    return;
  }
  const leanA = juryLean(this.juryRel!, { respected: true });
  const leanB = juryLean({ trust: 0.35, affinity: 0.35, threat: 0.4 }, {});
  assert.ok(voteRateForA(leanA, leanB) > 0.85, "well-managed finalist wins a strong majority");
});

Then("a strong or weak finale shifts close jurors but rarely overturns a clear lead", function (this: BbWorld) {
  const leanA = juryLean(this.juryRel!, { respected: true });
  const leanB = juryLean({ trust: 0.35, affinity: 0.35, threat: 0.4 }, {});
  // Clear lead: even B's best finale vs A's worst rarely flips it.
  assert.ok(voteRateForA(leanA, leanB, 0.0, 1.0) > 0.85, "a clear lead survives the finale");
  // Close jurors: the finale genuinely swings the outcome.
  const tie = juryLean({ trust: 0.5, affinity: 0.5, threat: 0.2 }, {});
  const aFinale = voteRateForA(tie, tie, 1.0, 0.0);
  const bFinale = voteRateForA(tie, tie, 0.0, 1.0);
  assert.ok(aFinale > 0.5 && bFinale < 0.5, "the finale sways close jurors");
});

// --- Final 2 choreography -----------------------------------------------------

Then("each finalist gives an opening statement", function (this: BbWorld) {
  this.finaleScript = runFinale(this.outcome!.finalTwo, this.outcome!.jury);
  assert.equal(this.finaleScript.statements.length, 2);
  assert.deepEqual(this.finaleScript.statements, [this.outcome!.finalTwo[0], this.outcome!.finalTwo[1]]);
});

Then("each juror asks a question of each finalist", function (this: BbWorld) {
  // 18-Q&A (audit A6 ruling): every juror questions BOTH finalists, so the script holds jury × 2 questions.
  assert.equal(this.finaleScript!.questions.length, this.outcome!.jury.length * 2);
  for (const q of this.finaleScript!.questions) assert.ok(this.outcome!.finalTwo.includes(q.finalist));
  for (const juror of this.outcome!.jury) {
    const asked = this.finaleScript!.questions.filter((q) => q.juror === juror).map((q) => q.finalist);
    for (const finalist of this.outcome!.finalTwo) assert.ok(asked.includes(finalist), "each finalist is questioned by the juror");
  }
});

Then("the votes are revealed one at a time", function (this: BbWorld) {
  const reveal = this.finaleScript!.revealOrder;
  assert.equal(reveal.length, this.outcome!.jury.length);
  assert.equal(new Set(reveal).size, reveal.length, "each juror's vote revealed exactly once");
});

// --- Tally + last-juror tie-break --------------------------------------------

When("the jury vote is tallied", function (this: BbWorld) {
  this.outcome = playSeason({ seed: 6, houseguests: build16(6) });
});

Then("a tie is broken by the last-evicted juror", function (this: BbWorld) {
  // 0037 (live seam) drives a real 1–1 finale where the last-evicted juror leans the second
  // finalist; assert the LIVE winner when present.
  if (this.lastAdvance) {
    assert.equal(this.lastAdvance.winner!.id, this.juryFinalists![1], "the last-evicted juror broke the live tie");
    return;
  }
  const w = { relationship: 1, manner: 1, finale: 0, gameRespect: 0, reliability: 0 };
  // Two jurors split 1-1; the last-evicted (npc(2)) leans B → B wins the tie-break.
  const leanTie = (j: string, f: string): number => (j === npc(1) ? (f === A ? 1 : 0) : (f === B ? 1 : 0));
  const winner = tallyJuryVote([npc(1), npc(2)], [A, B], leanTie, () => 0, [npc(1), npc(2)], new SeededRandom(1), w);
  assert.equal(winner, B);
});

// --- Engine decides; the LLM only voices -------------------------------------

Given("the jurors are voiced by the narrative layer", function (this: BbWorld) {
  // A HALLUCINATING narrator: it voices every beat of the finale and insists the OTHER finalist is winning.
  const hallucinating: NarratorTransport = {
    async *stream() {
      yield "The jurors rise as one and crown the rival finalist, unanimously.";
    },
  };
  this.narrator = new LlmNarrativePort(
    { provider: "ollama", endpoint: "http://127.0.0.1:0", model: "m", apiKey: undefined, timeoutMs: 20, maxRetries: 0 },
    hallucinating,
  );
});

/** Play a LIVE Final 2 (player vs one NPC, nine jurors) to its winner, optionally narrating every beat on the way. */
async function playLiveJury(user: string, favored: "player" | "rival", narrate?: (reg: GameSessionRegistry) => Promise<void>) {
  const strong = { trust: 0.9, affinity: 0.9, threat: 0.1 };
  const weak = { trust: 0.1, affinity: 0.1, threat: 0.9 };
  const rival = npc(10);
  const { reg, player } = await liveFinale(user, 5, {
    finalists: [PLAYER, rival], jury: JURY9,
    edgeTo: (_j, f) => ((f === PLAYER) === (favored === "player") ? strong : weak),
  });
  const views = await driveFinaleSeam(player, { onView: async () => { await narrate?.(reg); } });
  const last = views[views.length - 1]!;
  assert.ok(last.finished && last.winner, "the live jury crowned a winner");
  const reveals = views.filter((v) => v.event?.beat === "finale-reveal").map((v) => v.event!.content);
  return { winner: last.winner!.id as string, reveals };
}

When("the jury vote is computed", async function (this: BbWorld) {
  const port = this.narrator!;
  let narrations = 0;
  const narrate = async (reg: GameSessionRegistry): Promise<void> => {
    // Each narration is built from the player's visible state and handed to the hallucinating voicer mid-finale.
    const ctx = reg.sandboxFor("narrated").player.assembleNarrationContext("scene");
    const out = await port.narrate(ctx);
    assert.match(out, /crown the rival/, "the narrator really did contradict the engine");
    narrations++;
  };
  this.juryLive = {
    plain: await playLiveJury("plain", "player"),
    narrated: await playLiveJury("narrated", "player", narrate),
    flipped: await playLiveJury("flipped", "rival"),
    narrations,
  };
});

Then("each vote is decided by the engine from jury relationships and finale performance", function (this: BbWorld) {
  const j = this.juryLive!;
  assert.equal(j.plain.winner, PLAYER, "jurors who trust the player crown the player");
  assert.equal(j.flipped.winner, npc(10), "reverse the relationships and the same jury crowns the rival: the leans decide");
  assert.notDeepEqual(j.plain.reveals, j.flipped.reveals, "the revealed votes follow the relationships");
});

Then("the narrative layer does not change any vote", function (this: BbWorld) {
  const j = this.juryLive!;
  assert.ok(j.narrations > 10, "the narrator voiced the finale beat by beat");
  assert.equal(j.narrated.winner, j.plain.winner, "the winner is the engine's, whatever the narration claims");
  assert.deepEqual(j.narrated.reveals, j.plain.reveals, "every revealed vote is identical with and without narration");
});
