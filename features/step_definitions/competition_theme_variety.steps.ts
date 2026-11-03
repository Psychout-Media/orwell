import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView, CompetitionResultView, GameSession } from "../../src/ports/GameSession";
import { resolvePending } from "../support/answerPending";

// Feature 0125 — competition theme variety. HARD rule: roles only — no names.

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

/** Play a seeded game, collecting every live themed comp result view + the final eviction order. */
function ctvPlay(user: string, seed: number, themesOn: boolean, weeks = 6): {
  views: CompetitionResultView[]; evictionOrder: readonly string[];
} {
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor(user).session;
  s.createCharacter({ playerName: "The Player", seed });
  s.setCompThemesEnabled(themesOn);
  const views: CompetitionResultView[] = [];
  for (let i = 0; i < 240; i++) {
    const v = s.runCompetition({});
    if (v.started && v.winner) views.push(v);
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.status.week > weeks || a.finished) break;
  }
  return { views, evictionOrder: s.snapshot().live?.evictionOrder ?? [] };
}

// --- Scenario: A season of competitions runs without a repeated theme ---------------------

Given("a started game played across a full season", function (this: BbWorld) {
  this.ctv = { on: ctvPlay("ctv-season", 31, true, 8) };
});

When("each week's competition is themed from the seeded pool", function (this: BbWorld) {
  // runCompetition re-reports the live comp across staged rounds, so dedupe to ONE theme per (phase, week).
  // The comp's phase reads as "hoh-competition"/"premiere" (HOH) or "veto-competition" (veto); classify
  // by whether the phase mentions "veto" so week-1's premiere HOH is bucketed with the other HOH comps.
  const perWeek = new Map<string, { week: number; theme?: string }>();
  for (const v of this.ctv!.on!.views) {
    if (!v.theme) continue;
    const bucket = v.phase.includes("veto") ? "veto" : "hoh";
    const k = `${bucket}:${v.week}`;
    if (!perWeek.has(k)) perWeek.set(k, { week: v.week, theme: v.theme });
  }
  const seq = (bucket: string): (string | undefined)[] =>
    [...perWeek.entries()].filter(([k]) => k.startsWith(`${bucket}:`))
      .sort((a, b) => a[1].week - b[1].week).map(([, v]) => v.theme);
  this.ctv!.themes = { hoh: seq("hoh"), veto: seq("veto") };
  assert.ok(this.ctv!.themes.hoh.length >= 3, "several themed HOH comps were surfaced");
});

Then("no theme repeats within a phase across the season", function (this: BbWorld) {
  for (const phase of ["hoh", "veto"] as const) {
    const t = (this.ctv!.themes![phase]).filter(Boolean) as string[];
    // Distinct comps are what matter: the same mechanic re-skins to a different theme each week.
    assert.equal(new Set(t).size, t.length, `${phase} repeated a theme within the season`);
  }
});

Then("the same-week head-of-household and veto competitions are themed differently", function (this: BbWorld) {
  const { hoh, veto } = this.ctv!.themes!;
  const pairs = Math.min(hoh.length, veto.length);
  let differed = 0;
  for (let i = 0; i < pairs; i++) if (hoh[i] && veto[i] && hoh[i] !== veto[i]) differed++;
  assert.ok(differed >= Math.max(1, pairs - 1), "HOH and veto share a theme too often within a week");
});

// --- Scenario: The theme is a coherent Vault-free skin over the mechanic -------------------

Given("a resolved themed competition", function (this: BbWorld) {
  this.ctv = { on: ctvPlay("ctv-skin", 23, true, 4) };
});

When("the themed result is read on a player surface", function (this: BbWorld) {
  // The themed comp views were collected in the Given; nothing more to do — assert one exists.
  assert.ok(this.ctv!.on!.views.length > 0, "a themed competition resolved");
});

Then("it carries a theme label and a themed name and a scene-set premise", function (this: BbWorld) {
  const themed = this.ctv!.on!.views.find((v) => v.theme);
  assert.ok(themed, "a themed comp was surfaced");
  assert.ok(themed!.name && themed!.name.length > 0, "a themed name is present");
  assert.ok(themed!.narrative && themed!.narrative.premise.length > 0, "a scene-set premise is present");
});

Then("the themed result contains no stat, score, ranking, or Vault sentinel", function (this: BbWorld) {
  const blob = JSON.stringify(this.ctv!.on!.views);
  assert.ok(!/"(physical|mental|social|trust|affinity|threat)"\s*:\s*[\d.]/.test(blob), "no numeric stat");
  assert.ok(!/"scores"|"temperature"|"governing"|"ranking/i.test(blob), "no score/ranking surface");
  assert.ok(!/SENTINEL/i.test(blob), "no Vault sentinel");
});

// --- Scenario: The theme never changes who wins -------------------------------------------

Given("a seeded game to be played with and without themes", function (this: BbWorld) {
  this.ctv = {};
});

When("it is played once with themes on and once with themes off", function (this: BbWorld) {
  this.ctv!.on = ctvPlay("ctv-cal-on", 77, true, 6);
  this.ctv!.off = ctvPlay("ctv-cal-off", 77, false, 6);
});

Then("the same houseguests are evicted in the same order in both", function (this: BbWorld) {
  assert.deepEqual(this.ctv!.on!.evictionOrder, this.ctv!.off!.evictionOrder);
  assert.ok(this.ctv!.on!.evictionOrder.length > 0, "houseguests were actually evicted");
});

Then("each week's competition is won by the same houseguest in both", function (this: BbWorld) {
  assert.deepEqual(
    this.ctv!.on!.views.map((v) => v.winner?.id),
    this.ctv!.off!.views.map((v) => v.winner?.id),
  );
});

// --- Scenario: With themes off, the competition is the bare mechanic library ---------------

Given("a started game played with themes off", function (this: BbWorld) {
  this.ctv = { off: ctvPlay("ctv-bare", 31, false, 3) };
});

When("a competition resolves", function (this: BbWorld) {
  // The game was already played to completion in the Given; the resolved comp views are collected.
  assert.ok((this.ctv!.off!.views.length) > 0, "a competition resolved during the played season");
});

Then("its result carries no theme", function (this: BbWorld) {
  const views = this.ctv!.off!.views;
  assert.ok(views.length > 0, "a competition resolved");
  assert.ok(views.every((v) => v.theme === undefined), "a theme leaked with the layer off");
});

// --- Scenario: The theming is seed-deterministic ------------------------------------------

Given("a seeded game to be replayed with themes on", function (this: BbWorld) {
  this.ctv = { det: ctvPlay("ctv-det-a", 19, true, 4).views.map((v) => `${v.theme}:${v.name}`) };
});

When("the same themed weeks are played twice", function (this: BbWorld) {
  this.ctv!.detB = ctvPlay("ctv-det-b", 19, true, 4).views.map((v) => `${v.theme}:${v.name}`);
});

Then("the same themed competitions are surfaced in both", function (this: BbWorld) {
  assert.deepEqual(this.ctv!.det, this.ctv!.detB);
  assert.ok((this.ctv!.det?.length ?? 0) > 0, "themed comps were surfaced");
});
