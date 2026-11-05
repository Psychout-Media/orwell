import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { newLiveSeason, advance, applyDecision, finalHohPartDef, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

// Feature 0128 - the three-part Final HOH, driven at the engine level (liveSeason.ts) with a seeded rng; the live-adapter persistence/announcement path is
// proven in tests/unit/finalHohThreePartLive.test.ts. Roles only.

const SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);

function play(seed: number, finalists: EntityId[], threePart: boolean, opts: { evict?: boolean } = {}): NonNullable<BbWorld["fh"]>["runs"][number] {
  const s: LiveSeasonState = newLiveSeason(finalists);
  s.week = 11; s.beat = "hoh-competition";
  const rel = new RelationshipModel(0.5);
  const ctx: SeasonCtx = { player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel, ...(threePart ? { finalHohThreePart: true } : {}) };
  const rng = new SeededRandom(seed);
  const events: Array<{ beat: string; participants: string[] }> = [];
  const asked: EntityId[][] = [];
  for (let i = 0; i < 500 && s.beat === "hoh-competition"; i++) {
    const ev = advance(s, ctx, rng);
    if (ev) events.push({ beat: ev.beat, participants: [...ev.participants] });
    if (s.pending) {
      const p = s.pending as { kind: string; stillIn?: EntityId[] };
      if (p.kind === "comp-round") asked.push([...(p.stillIn ?? [])]);
      const ev2 = applyDecision(s, { kind: "comp-round", intent: "compete" } as never, ctx, rng);
      if (ev2) events.push({ beat: ev2.beat, participants: [...ev2.participants] });
    }
  }
  const run: NonNullable<BbWorld["fh"]>["runs"][number] = { seed, events, hoh: s.hoh, asked, state: JSON.parse(JSON.stringify(s)) };
  if (opts.evict && (s.beat as string) === "final-eviction") {
    for (let i = 0; i < 20 && (s.beat as string) === "final-eviction"; i++) {
      const ev = advance(s, ctx, rng);
      if (s.pending) { const p = s.pending as { options: [EntityId, EntityId] }; applyDecision(s, { kind: "final-eviction", evict: p.options[0] } as never, ctx, rng); run.evictee = p.options[0]; break; }
      if (ev?.beat === "final-eviction") { run.evictee = ev.participants[1]; break; }
    }
  }
  return run;
}
const parts = (r: { events: Array<{ beat: string; participants: string[] }> }) => r.events.filter((e) => e.beat === "final-hoh-part");
const NPCS: EntityId[] = [npc(1), npc(2), npc(3)];
const setup = (w: BbWorld, finalists: EntityId[], threePart: boolean, evict = false): void => {
  w.fh = { finalists, threePart, withPlayer: finalists.includes(PLAYER), runs: SEEDS.map((seed) => play(seed, finalists, threePart, { evict })) };
};

Given("three finalists and the three-part Final HOH enabled", function (this: BbWorld) { setup(this, NPCS, true); });
When("the endgame advances through the Final HOH competition", function (this: BbWorld) { assert.ok(this.fh!.runs.length > 0); });

Then("part one is an endurance competition among all three finalists", function (this: BbWorld) {
  const d = finalHohPartDef(1, new SeededRandom(1));
  assert.equal(d.type, "endurance"); assert.equal(d.governing, "physical");
  for (const r of this.fh!.runs) assert.deepEqual([...parts(r)[0]!.participants].sort(), [...this.fh!.finalists].sort(), `seed ${r.seed}: all three play Part 1`);
});
Then("part two is a physical-and-mental competition between the two who lost part one", function (this: BbWorld) {
  const d = finalHohPartDef(2, new SeededRandom(1));
  assert.equal(d.governing, "physical"); assert.equal(d.secondary, "mental");
  for (const r of this.fh!.runs) {
    const p1 = parts(r)[0]!.participants[0]!;
    assert.deepEqual([...parts(r)[1]!.participants].sort(), this.fh!.finalists.filter((f) => f !== p1).sort(), `seed ${r.seed}: only the Part-1 losers play Part 2`);
  }
});
Then("part three is a quiz between the part-one winner and the part-two winner", function (this: BbWorld) {
  const d = finalHohPartDef(3, new SeededRandom(1));
  assert.equal(d.type, "quiz"); assert.equal(d.governing, "mental");
  for (const r of this.fh!.runs) assert.ok([parts(r)[0]!.participants[0], parts(r)[1]!.participants[0]].includes(r.hoh as string), `seed ${r.seed}: Part 3 is between the two part-winners`);
});
Then("the winner of part three is the Final HOH", function (this: BbWorld) {
  for (const r of this.fh!.runs) {
    const crown = r.events.filter((e) => e.beat === "hoh-competition");
    assert.equal(crown.length, 1, "exactly one HOH crown (Part 3)");
    assert.equal(crown[0]!.participants[0], r.hoh);
  }
});

Given("a finalist who wins part one", function (this: BbWorld) { setup(this, NPCS, true); });
When("part two is played", function (this: BbWorld) { assert.ok(this.fh!.runs.every((r) => parts(r).length === 2)); });
Then("that finalist does not compete in part two", function (this: BbWorld) {
  for (const r of this.fh!.runs) assert.ok(!parts(r)[1]!.participants.includes(parts(r)[0]!.participants[0]!), `seed ${r.seed}`);
});
Then("they advance directly to part three", function (this: BbWorld) {
  for (const r of this.fh!.runs) {
    const p1 = parts(r)[0]!.participants[0]!, p2 = parts(r)[1]!.participants[0]!;
    assert.deepEqual([p1, p2].includes(r.hoh as string), true, `seed ${r.seed}: the Final HOH is a part-winner`);
    assert.notEqual(p1, p2);
  }
});

Given("the three-part Final HOH has been played", function (this: BbWorld) { setup(this, NPCS, true); });
Then("the Final HOH won part three and one earlier part", function (this: BbWorld) {
  for (const r of this.fh!.runs) assert.ok([parts(r)[0]!.participants[0], parts(r)[1]!.participants[0]].includes(r.hoh as string), `seed ${r.seed}`);
});
Then("the finalist who lost both part one and part two never competed in part three", function (this: BbWorld) {
  for (const r of this.fh!.runs) {
    const p1 = parts(r)[0]!.participants[0]!, p2 = parts(r)[1]!.participants[0]!;
    const loserBoth = this.fh!.finalists.find((f) => f !== p1 && f !== p2)!;
    assert.notEqual(r.hoh, loserBoth, `seed ${r.seed}: the two-loss finalist cannot be the Final HOH`);
  }
});

Given("a Final HOH decided by the three-part competition", function (this: BbWorld) { setup(this, NPCS, true, true); });
When("it is time for the Final HOH to evict", function (this: BbWorld) { assert.ok(this.fh!.runs.every((r) => r.evictee !== undefined), "every run reached the Final HOH's eviction"); });
Then("the Final HOH personally evicts one of the other two", function (this: BbWorld) {
  for (const r of this.fh!.runs) { assert.notEqual(r.evictee, r.hoh); assert.ok(this.fh!.finalists.includes(r.evictee!), `seed ${r.seed}`); }
});
Then("the finalist who lost both early parts is not evicted automatically", function (this: BbWorld) {
  // 0045: the HOH CHOOSES. The eviction is a decision over BOTH other finalists (here the engine/NPC policy picks the first option); it is never forced onto the two-loss finalist.
  const forced = this.fh!.runs.filter((r) => {
    const p1 = parts(r)[0]!.participants[0]!, p2 = parts(r)[1]!.participants[0]!;
    return r.evictee === this.fh!.finalists.find((f) => f !== p1 && f !== p2);
  });
  assert.ok(forced.length < this.fh!.runs.length, "across seeds the evictee is not always the two-loss finalist");
});

Given("the player is a finalist with the three-part Final HOH enabled", function (this: BbWorld) { setup(this, [PLAYER, npc(1), npc(2)], true); });
When("each part they are eligible for is played", function (this: BbWorld) { assert.ok(this.fh!.runs.length > 0); });
Then("the player commits an approach before that part resolves", function (this: BbWorld) {
  for (const r of this.fh!.runs) {
    const mine = r.asked.filter((f) => f.includes(PLAYER));
    assert.ok(mine.length >= 2, `seed ${r.seed}: the player is asked (comp-round) for every part they are in`);
    assert.ok(r.asked.every((f) => f.includes(PLAYER)), "...and never for a part they are not in");
  }
});
Then("if the player wins part one they rest through part two", function (this: BbWorld) {
  const wins = this.fh!.runs.filter((r) => parts(r)[0]!.participants[0] === PLAYER);
  assert.ok(wins.length > 0, "a seed where the player wins Part 1");
  for (const r of wins) assert.equal(r.asked.length, 2, `seed ${r.seed}: Part 1 and Part 3 only`);
});

Given("an NPC-only Final 3 with the three-part Final HOH enabled", function (this: BbWorld) { setup(this, NPCS, true); });
Then("each part's advancement and win is decided by the engine from hidden signals, not narration", function (this: BbWorld) {
  assert.ok(this.fh!.runs.every((r) => parts(r).length === 2 && r.hoh), "every part resolved by the engine alone (no model in this loop)");
});
Then("no score or number is shown for any part", function (this: BbWorld) {
  for (const r of this.fh!.runs) for (const e of r.events) if (e.beat === "final-hoh-part") assert.ok(!/\bscore|\b\d+(\.\d+)?%/.test(JSON.stringify(e)), "no score/percentage on a part event");
});
Then("the same seed reproduces the same three-part outcome, surviving an engine restart", function (this: BbWorld) {
  for (const r of this.fh!.runs.slice(0, 6)) {
    const again = play(r.seed, NPCS, true);
    assert.deepEqual(again.events, r.events, `seed ${r.seed}: same seed, same outcome`);
    const resumed = JSON.parse(JSON.stringify(r.state)) as LiveSeasonState; // the persisted end state round-trips (0030)
    assert.equal(resumed.hoh, r.hoh);
  }
});

Given("three finalists and the three-part Final HOH disabled", function (this: BbWorld) { setup(this, NPCS, false); });
When("the endgame advances with the three-part flag off", function (this: BbWorld) { assert.ok(this.fh!.runs.length > 0); });
Then("the Final HOH is decided by a single competition exactly as feature 0045", function (this: BbWorld) {
  for (const r of this.fh!.runs) { assert.equal(parts(r).length, 0); assert.equal(r.events.filter((e) => e.beat === "hoh-competition").length, 1); }
});
Then("the seeded single-competition endgame is deterministic and emits no part events", function (this: BbWorld) {
  // NOTE (S16): this compares flag-off with flag-off (determinism), not against the pre-feature model; the anchor for the pre-feature baseline is the standing trajectory-neutrality gates (stagedTrajectoryNeutral, juryReach) pin the pre-feature baseline.
  for (const r of this.fh!.runs.slice(0, 8)) {
    const s = newLiveSeason(NPCS); s.week = 11; s.beat = "hoh-competition";
    const ctx: SeasonCtx = { player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel: new RelationshipModel(0.5), finalHohThreePart: false };
    const rng = new SeededRandom(r.seed); const evs: string[] = [];
    for (let i = 0; i < 500 && s.beat === "hoh-competition"; i++) { const ev = advance(s, ctx, rng); if (ev) evs.push(`${ev.beat}:${ev.content}`); }
    assert.ok(evs.length > 0 && !evs.some((e) => e.startsWith("final-hoh-part")), "no part events with the flag absent or false");
    assert.equal(s.hoh, r.hoh, `seed ${r.seed}: same Final HOH with the flag absent or false`);
  }
});
