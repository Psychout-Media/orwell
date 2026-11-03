import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { COMPETITION_LIBRARY, COMPETITION_LIBRARY_PLUS } from "../../src/engine/competitionLibrary";
import { RELEVANT } from "../../src/domain/competitionOutcome";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { resolvePending } from "../support/answerPending";

// Feature 0126 — expanded competition mechanics. HARD rule: roles only — no names.

/** Answer whatever pending the live game raises with a legal, deterministic choice (roles only). */
function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

/** Play a seeded game to completion with the expanded pool on/off; collect the drawn comps + eviction order. */
function cmpPlay(user: string, seed: number, plusOn: boolean): { hoh: string[]; veto: string[]; evictionOrder: readonly string[] } {
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor(user).session;
  s.createCharacter({ playerName: "The Player", seed });
  s.setCompMechanicsPlusEnabled(plusOn);
  for (let i = 0; i < 2000; i++) {
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.finished) break;
  }
  const live = s.snapshot().live!;
  return { hoh: live.compHistory?.hoh ?? [], veto: live.compHistory?.veto ?? [], evictionOrder: live.evictionOrder ?? [] };
}

const PLUS_IDS = new Set(COMPETITION_LIBRARY_PLUS.map((d) => d.id));

// --- Scenario: A season drawn from the expanded pool has no repeated mechanic --------------

Given("a started game played across a full season with the expanded mechanic pool on", function (this: BbWorld) {
  this.cmp = cmpPlay("cmp-season", 31, true);
});

When("each week's competition mechanic is drawn", function (this: BbWorld) {
  assert.ok((this.cmp!.hoh!.length) >= 3, "several HOH mechanics were drawn");
});

Then("nearly every head-of-household and veto mechanic across the season is distinct", function (this: BbWorld) {
  assert.ok(new Set(this.cmp!.hoh).size >= 13, `only ${new Set(this.cmp!.hoh).size} distinct HOH mechanics`);
  assert.ok(new Set(this.cmp!.veto).size >= 12, `only ${new Set(this.cmp!.veto).size} distinct veto mechanics`);
});

Then("the new expanded mechanics are actually used", function (this: BbWorld) {
  assert.ok([...this.cmp!.hoh!, ...this.cmp!.veto!].some((id) => PLUS_IDS.has(id)), "no expanded mechanic was drawn");
});

// --- Scenario: With the expanded pool off the season is the bare base library --------------

Given("one seed played once with the expanded pool off and once with it on", function (this: BbWorld) {
  this.cmp = {};
});

When("both expanded-pool games are played to completion", function (this: BbWorld) {
  // PAT-3: a real OFF-vs-ON contrast on one seed (the OFF path is the bare base library; the former step compared two OFF runs).
  this.cmp!.a = cmpPlay("cmp-off-a", 77, false);
  this.cmp!.b = cmpPlay("cmp-on-b", 77, true);
});

Then("no expanded-only mechanic is drawn with the pool off", function (this: BbWorld) {
  const drawn = [...this.cmp!.a!.hoh, ...this.cmp!.a!.veto];
  assert.ok(drawn.length > 0, "competitions were drawn");
  assert.ok(!drawn.some((id) => PLUS_IDS.has(id)), "an expanded mechanic leaked with the pool off");
});

Then("the same seed with the pool on does draw expanded-only mechanics", function (this: BbWorld) {
  assert.ok([...this.cmp!.b!.hoh, ...this.cmp!.b!.veto].some((id) => PLUS_IDS.has(id)), "the flag is inert: no expanded mechanic drawn when on");
});

// --- Scenario: The expanded pool preserves the competition stat balance --------------------

Given("the full expanded mechanic pool", function (this: BbWorld) {
  this.cmp = {};
});

Then("each phase stays mental-dominant with physical second and social a minority", function () {
  for (const phase of ["hoh", "veto"] as const) {
    const full = [...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS].filter((d) => d.phase === phase);
    const c: Record<string, number> = { physical: 0, mental: 0, social: 0 };
    for (const d of full) c[RELEVANT[d.type]]++;
    assert.equal(c.physical + c.mental + c.social, 15, `${phase} pool is not 15`);
    assert.ok(c.mental > c.physical, `${phase} not mental-dominant`);
    assert.ok(c.physical > c.social, `${phase} social not a minority`);
  }
});

Then("every mechanic's governing stat matches the resolution map for its type", function () {
  for (const d of [...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS]) {
    assert.equal(d.governing, RELEVANT[d.type], `${d.id} governing drifted from its type`);
  }
});

// --- Scenario: The engine still decides the winner over the expanded pool ------------------

Given("a resolved competition drawn from the expanded pool", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor("cmp-wall").session;
  s.createCharacter({ playerName: "The Player", seed: 5 });
  s.setCompMechanicsPlusEnabled(true);
  const views: unknown[] = [];
  for (let i = 0; i < 240; i++) {
    views.push(s.runCompetition({}));
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.status.week > 4 || a.finished) break;
  }
  this.cmp = { views: JSON.stringify(views) };
});

When("the expanded-pool result is read on a player surface", function (this: BbWorld) {
  assert.ok((this.cmp!.views?.length ?? 0) > 0, "a competition resolved");
});

Then("the expanded-pool result contains no stat, score, ranking, or Vault sentinel", function (this: BbWorld) {
  const blob = this.cmp!.views!;
  assert.ok(!/"(physical|mental|social|trust|affinity|threat)"\s*:\s*[\d.]/.test(blob), "no numeric stat");
  assert.ok(!/"scores"|"temperature"|"governing"|"ranking/i.test(blob), "no score/ranking surface");
  assert.ok(!/SENTINEL/i.test(blob), "no Vault sentinel");
});

// --- Scenario: The expanded draw is seed-deterministic -------------------------------------

Given("two games started from the same seed played with the expanded pool on", function (this: BbWorld) {
  this.cmp = {};
});

When("each expanded-pool game on the same seed is played to completion", function (this: BbWorld) {
  this.cmp!.a = cmpPlay("cmp-det-a", 19, true);
  this.cmp!.b = cmpPlay("cmp-det-b", 19, true);
});

Then("the same competition mechanics are drawn in both", function (this: BbWorld) {
  assert.deepEqual(this.cmp!.a!.hoh, this.cmp!.b!.hoh);
  assert.deepEqual(this.cmp!.a!.veto, this.cmp!.b!.veto);
});
