import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import {
  eligibleForHOH, vetoParticipants, selectableReplacements, evictionVoters, breaksTie,
} from "../../src/domain/eligibility";
import type { WeekState } from "../../src/domain/eligibility";
import { PLAYER, npc } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import { newLiveSeason, advance, applyDecision, autoDecision } from "../../src/engine/liveSeason";
import type { SeasonCtx } from "../../src/engine/liveSeason";
import { buildSandbox } from "../../tests/support/sandbox";
import { assertHardRulesSurviveTemperature } from "../support/eligibilityUnderTemperature";

interface DeployTrace {
  crowns: { hoh: string; outgoing: string | undefined; active: number }[];
  replacements: { replacement: string; vetoHolder: string }[];
  fired: string[];
}

const PULLERS = [npc(1), npc(2), npc(3)];

function makeWeek(over: Partial<WeekState> = {}): WeekState {
  const houseguests = [PLAYER, ...Array.from({ length: 15 }, (_, i) => npc(i + 1))];
  return { houseguests, player: PLAYER, hoh: npc(1), nominees: [npc(2), npc(3)], ...over };
}

// --- Outgoing HOH -------------------------------------------------------------

Given("a houseguest is the outgoing HOH for the current week", function (this: BbWorld) {
  this.week = makeWeek({ outgoingHoh: npc(4) });
});

When("the next HOH competition begins", function (this: BbWorld) {
  this.eligible = eligibleForHOH(this.week!);
});

Then("that houseguest is not in the eligible participant set", function (this: BbWorld) {
  assert.ok(!this.eligible!.includes(this.week!.outgoingHoh!));
});

// --- Veto winner cannot be a replacement --------------------------------------

Given("a houseguest has won the Power of Veto this week", function (this: BbWorld) {
  this.week = makeWeek({ vetoWinner: npc(5) });
});

Given("the veto is used to remove a nominee", function (this: BbWorld) {
  assert.ok(this.week, "a week should exist"); // veto-used is a precondition; doesn't change the rule
});

When("the HOH selects a replacement nominee", function (this: BbWorld) {
  this.selectable = selectableReplacements(this.week!);
});

Then("the veto winner is excluded from the selectable set", function (this: BbWorld) {
  assert.ok(!this.selectable!.includes(this.week!.vetoWinner!));
});

// --- Six-player veto draw -----------------------------------------------------

Given("an HOH and two nominees for the current week", function (this: BbWorld) {
  this.week = makeWeek();
});

When("the veto participants are drawn", function (this: BbWorld) {
  this.veto = vetoParticipants(this.week!, new SeededRandom(1), { houseguestsChoiceChip: true });
});

Then("the participant set contains exactly six houseguests", function (this: BbWorld) {
  assert.equal(this.veto!.participants.length, 6);
  assert.equal(new Set(this.veto!.participants).size, 6);
});

Then("it includes the HOH and both nominees", function (this: BbWorld) {
  for (const p of PULLERS) assert.ok(this.veto!.participants.includes(p));
});

Then("the remaining three come from the chip draw of the eligible pool", function (this: BbWorld) {
  const pool = this.week!.houseguests.filter((h) => !PULLERS.includes(h));
  const others = this.veto!.participants.filter((p) => !PULLERS.includes(p));
  assert.equal(others.length, 3);
  assert.ok(others.every((o) => pool.includes(o)));
});

Then('one chip may be "Houseguest\'s Choice"', function (this: BbWorld) {
  // capability: there exists a seed where the HC chip is drawn.
  let drawn = false;
  for (let s = 0; s < 500 && !drawn; s++) {
    drawn = !!vetoParticipants(this.week!, new SeededRandom(s), { houseguestsChoiceChip: true }).houseguestsChoice;
  }
  assert.ok(drawn, "the Houseguest's Choice chip can be drawn");
});

Then("the chip draw is seeded: the same seed gives the same chips", function (this: BbWorld) {
  const a = vetoParticipants(this.week!, new SeededRandom(1), { houseguestsChoiceChip: true });
  const b = vetoParticipants(this.week!, new SeededRandom(1), { houseguestsChoiceChip: true });
  assert.deepEqual(a.participants, b.participants); // seed alone determines the draw — no player lever
});

// --- Houseguest's Choice holder selection -------------------------------------

Given("the veto chips are drawn for the current week", function (this: BbWorld) {
  this.week = makeWeek();
  const rel = new RelationshipModel(0.5);
  for (const puller of PULLERS) for (let k = 0; k < 5; k++) rel.apply(puller, npc(7), "alliance", new SeededRandom(99));
  this.rel = rel;
  const choose = (holder: string, candidates: string[]): string =>
    candidates.reduce((best, c) => (rel.bondStrength(holder, c) > rel.bondStrength(holder, best) ? c : best), candidates[0]!);

  for (let s = 0; s < 1000; s++) {
    const v = vetoParticipants(this.week, new SeededRandom(s), { houseguestsChoiceChip: true, choose });
    if (v.houseguestsChoice) {
      this.veto = v;
      break;
    }
  }
  assert.ok(this.veto?.houseguestsChoice, "a draw where Houseguest's Choice is pulled");
});

Given('one drawn chip is "Houseguest\'s Choice"', function (this: BbWorld) {
  assert.ok(this.veto?.houseguestsChoice, "Houseguest's Choice should have been drawn");
});

When("its holder makes a selection", function (this: BbWorld) {
  assert.ok(this.veto?.houseguestsChoice, "the holder's selection happens during the draw");
});

Then("the holder picks the sixth competitor rather than receiving a random name", function (this: BbWorld) {
  const hc = this.veto!.houseguestsChoice!;
  assert.ok(hc.picked, "an NPC holder's pick is made during the draw (only the PLAYER defers — B45)");
  assert.ok(hc.candidates.includes(hc.picked!));
  assert.ok(this.veto!.participants.includes(hc.picked!));
  assert.equal(this.veto!.participants.length, 6);
});

Then("an NPC holder picks their strongest available bond per the relationship model", function (this: BbWorld) {
  const { holder, picked, candidates } = this.veto!.houseguestsChoice!;
  assert.ok(holder.startsWith("npc:"), "the holder is an NPC");
  const expected = candidates.reduce(
    (best, c) => (this.rel!.bondStrength(holder, c) > this.rel!.bondStrength(holder, best) ? c : best),
    candidates[0]!,
  );
  assert.equal(picked, expected);
});

Then("the veto field still totals six players", function (this: BbWorld) {
  assert.equal(this.veto!.participants.length, 6);
});

// --- Eviction voters ----------------------------------------------------------

When("the eviction vote is taken", function (this: BbWorld) {
  this.voters = evictionVoters(this.week!);
});

Then("every houseguest except the HOH and the two nominees casts a vote", function (this: BbWorld) {
  const expected = this.week!.houseguests.filter((h) => !PULLERS.includes(h));
  assert.deepEqual([...this.voters!].sort(), [...expected].sort());
});

// The live tie-break proof is tests/unit/tieBreak.test.ts (and the HC deferral is tests/unit/houseguestsChoice.test.ts); this step only pins the eligibility-side contract.
Then("the HOH votes only to break a tie", function (this: BbWorld) {
  assert.equal(breaksTie(this.week!), this.week!.hoh);
  assert.ok(!this.voters!.includes(this.week!.hoh));
});

// --- Special-comp exception + temperature invariance --------------------------

Given("a special competition that explicitly permits the outgoing HOH", function (this: BbWorld) {
  this.week = makeWeek({ outgoingHoh: npc(4) });
  this.special = true;
});

When("eligibility is computed", function (this: BbWorld) {
  this.eligible = eligibleForHOH(this.week!, { specialAllowsOutgoingHoh: !!this.special });
  this.selectable = selectableReplacements(this.week!);
});

Then("the outgoing HOH is in the eligible set", function (this: BbWorld) {
  assert.ok(this.eligible!.includes(this.week!.outgoingHoh!));
});

Given("any temperature roll for the moment", function (this: BbWorld) {
  // The temperature roll itself happens inside the Then, over the REAL eligible field (see eligibilityUnderTemperature.ts).
  this.week = makeWeek({ outgoingHoh: npc(4), vetoWinner: npc(5) });
});

Then("the outgoing-HOH rule and the veto-winner-replacement rule still hold", function (this: BbWorld) {
  assert.ok(!this.eligible!.includes(npc(4)));
  assert.ok(!this.selectable!.includes(npc(5)));
  // ...and no matter how loud temperature is, resolving over those sets never lets the excluded houseguests back in.
  assertHardRulesSurviveTemperature(this.week!);
});

// --- Reserve twist never overrides a hard rule or the Vault Wall ---------------

Given("a production twist held in reserve in the Vault", function (this: BbWorld) {
  this.sandbox = buildSandbox(1);
  this.specific = this.sandbox.addReservedTwist();
  // Seal the reserve in the exact shape production seals it (registry `setOnSeal`), so the deploy step reads WHAT to arm
  // from the Vault record itself rather than from a plan hard-coded beside it.
  for (const kind of ["double-eviction", "secret-veto", "battle-back"]) {
    this.sandbox.engine.vault.writeHidden({ id: `twist:scenario:${kind}`, kind: "reserved-twist", content: `sealed reserve twist: ${kind}, fires in the season` });
  }
  this.week = makeWeek({ outgoingHoh: npc(4), vetoWinner: npc(5) });
});

When("it is deployed", function (this: BbWorld) {
  // Deploy the REAL thing: a full live season whose whole reactive-twist pool is armed, played through the one live
  // loop. Every HOH crown and every replacement nominee is observed as it happens, with the twists firing around them.
  const ids = [PLAYER, ...Array.from({ length: 15 }, (_, i) => npc(i + 1))];
  const rng = new SeededRandom(4);
  const ctx: SeasonCtx = { player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel: new RelationshipModel(0.5) };
  const s = newLiveSeason(ids);
  // Arm exactly the twists the Vault holds in reserve (parsed from the sealed records), nothing else.
  const reserved = new Set(
    this.sandbox!.engine.vault.readHidden({ kind: "reserved-twist" }).map((r) => /sealed reserve twist: ([a-z-]+),/.exec(r.content)?.[1]).filter((k): k is string => !!k),
  );
  for (const k of ["double-eviction", "secret-veto", "battle-back"]) assert.ok(reserved.has(k), `the Vault holds a sealed ${k} reserve twist to deploy`);
  s.twistPlan = {
    doubleEvictionAtActive: 8, doubleEvictionArmed: reserved.has("double-eviction"),
    secretVetoStreak: 2, secretVetoArmed: reserved.has("secret-veto"),
    battleBackAtJury: 1, battleBackArmed: reserved.has("battle-back"),
  };
  const trace: DeployTrace = { crowns: [], replacements: [], fired: [] };
  let lastHoh: string | undefined;
  for (let i = 0; i < 4000 && !s.finished && s.beat !== "complete"; i++) {
    if (s.pending) applyDecision(s, autoDecision(s, ctx, rng), ctx, rng); else advance(s, ctx, rng);
    if (s.hoh && s.hoh !== lastHoh) trace.crowns.push({ hoh: s.hoh, outgoing: s.outgoingHoh, active: s.active.length });
    lastHoh = s.hoh;
    if (s.replacement && s.vetoHolder) trace.replacements.push({ replacement: s.replacement, vetoHolder: s.vetoHolder });
  }
  trace.fired = (s.firedTwists ?? []).map((t) => t.kind);
  assert.ok(s.finished || s.beat === "complete", "the deployed-twist season played to its end");
  assert.ok(trace.fired.includes("double-eviction"), "the reserved twist actually fired in the season (otherwise nothing was deployed)");
  assert.ok(trace.fired.every((k) => reserved.has(k)), `a twist fired that the Vault never held in reserve (${trace.fired.join(", ")})`);
  assert.ok(trace.crowns.length >= 5, "the season crowned several HOHs around the twist");
  this.deployTrace = trace;
});

Then("it does not override any eligibility hard rule", function (this: BbWorld) {
  const t = this.deployTrace!;
  for (const c of t.crowns) {
    // Final 3 lifts the outgoing-HOH restriction by design (0045); at every other size the rule is absolute.
    if (c.active > 3) assert.notEqual(c.hoh, c.outgoing, `outgoing-HOH rule broken at ${c.active} houseguests`);
  }
  for (const r of t.replacements) assert.notEqual(r.replacement, r.vetoHolder, "veto-winner-replacement rule broken");
  assert.ok(t.replacements.length > 0, "the season produced replacement nominees to check");
});

Then("it does not surface Vault content to the player", function (this: BbWorld) {
  const out = this.sandbox!.allPlayerOutputs();
  assert.ok(!out.includes(this.specific!.sentinel));
  assert.ok(!out.includes(this.specific!.content));
});

Then("it stays undisclosed until it actually occurs in-game", function (this: BbWorld) {
  const player = this.sandbox!.allPlayerOutputs();
  const admin = this.sandbox!.adminOutput();
  assert.ok(!player.includes(this.specific!.content) && !player.includes(this.specific!.sentinel));
  assert.ok(!admin.includes(this.specific!.content) && !admin.includes(this.specific!.sentinel));
});
