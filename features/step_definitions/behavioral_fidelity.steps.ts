import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { liveRichnessMetrics, TYPED_SCENES } from "../../src/engine/richness";
import { RICHNESS } from "../../src/engine/richnessConfig";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * 0003 — behavioral fidelity, measured on the LIVE game (audit 2026-10-25: this BDD used to drive
 * `simulateSeason`, which has no production callers, so a live game could lose its off-screen society
 * with every 0003 scenario still green). Each scenario now plays a real stretch of season through the
 * production spine — `advanceGame`/`submitDecision`, with the orchestrator as the commit delegate the way
 * `composeRuntime` wires it, so the house lives one bounded off-screen tick per committed turn — and reads
 * every claim off the sandbox's REAL EventStore + relationship layer. Roles only.
 */

const WEEKS = 3;

function resolve(s: GameSession, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent" || p.kind === "comp-round") s.submitDecision({ kind: p.kind, intent: "compete" } as never);
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}

function playLive(world: BbWorld, seed: number): void {
  const reg = new GameSessionRegistry();
  const orch = new Orchestrator(reg, { now: () => seed }, { seed, turnDriven: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  const sb = reg.sandboxFor(`fidelity-${seed}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const edgesBefore = JSON.stringify(sb.engine.relationships.serialize());
  for (let i = 0; i < 1500; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) resolve(sb.session, v.pending);
    if (v.status.week > WEEKS || v.finished) break;
  }
  const events = sb.engine.events.queryAll();
  world.seed = seed;
  world.liveFidelity = {
    events,
    metrics: liveRichnessMetrics(events),
    edgesMoved: JSON.stringify(sb.engine.relationships.serialize()) !== edgesBefore,
  };
}

/** Hidden scenes (the off-screen society) of the live stretch. */
const hiddenScenes = (w: BbWorld) => w.liveFidelity!.events.filter((e) => e.hidden);

// --- Background ---------------------------------------------------------------

Given("an active game simulated over many in-game days with a fixed seed", function (this: BbWorld) {
  playLive(this, 1);
});

When("the simulated stretch completes", function (this: BbWorld) {
  assert.ok(this.liveFidelity && this.liveFidelity.events.length > 0, "the live stretch should have been played");
});

// --- Rich social life ---------------------------------------------------------

Then(
  "alliances, gossip, scheming, and private conversations have occurred among NPCs",
  function (this: BbWorld) {
    const types = this.liveFidelity!.metrics.types;
    for (const t of ["alliance", "gossip", "strategy"]) {
      assert.ok(types.includes(t), `expected interaction type "${t}" to occur`);
    }
    assert.ok(hiddenScenes(this).length > 0, "expected private (off-screen) NPC conversations");
  },
);

Then("most of them occurred off-screen relative to the player", function (this: BbWorld) {
  const share = this.liveFidelity!.metrics.offscreenShare;
  assert.ok(share > 0.5, `off-screen share ${share} should be a majority`);
});

// --- NPC-initiated, player-excluded scenes ------------------------------------

Then(
  "some scenes were initiated by NPCs with witness sets that exclude the player",
  function (this: BbWorld) {
    const hidden = hiddenScenes(this);
    assert.ok(hidden.length > 0, "expected off-screen scenes");
    assert.ok(hidden.every((e) => !e.witnessSet.includes(PLAYER)), "off-screen scenes exclude the player");
    assert.ok(hidden.some((e) => e.initiator.startsWith("npc:")), "scenes are NPC-initiated");
  },
);

// --- Alliance churn -----------------------------------------------------------

Then("at least one alliance formed", function (this: BbWorld) {
  assert.ok(this.liveFidelity!.metrics.allianceScenes >= 1, "expected at least one alliance scene");
});

Then("at least one alliance shifted or fractured", function (this: BbWorld) {
  assert.ok(this.liveFidelity!.metrics.churnScenes >= 1, "expected at least one conflict or betrayal scene");
});

Then("relationship edge strengths changed over time", function (this: BbWorld) {
  assert.ok(this.liveFidelity!.edgesMoved, "the live relationship layer should have moved");
});

// --- Surfacing rarity ---------------------------------------------------------

Then("hidden elements were revealed on only a small fraction of moments", function (this: BbWorld) {
  const { revealShare, totalReveals } = this.liveFidelity!.metrics;
  assert.ok(totalReveals > 0, "some hidden element should surface over a stretch of live play");
  assert.ok(revealShare <= RICHNESS.MAX_SURFACING_RATE, `surfacing rate ${revealShare} should stay rare`);
});

Then(
  "no single moment revealed more than the allowed maximum of hidden elements",
  function (this: BbWorld) {
    // A "moment" is one committed beat: every event a commit records shares its play-clock `ts`.
    const perMoment = new Map<number, number>();
    for (const e of this.liveFidelity!.events) {
      if (TYPED_SCENES.has(e.type) && e.reveal === true) perMoment.set(e.ts, (perMoment.get(e.ts) ?? 0) + 1);
    }
    const max = Math.max(0, ...perMoment.values());
    assert.ok(max <= RICHNESS.MAX_REVEALS_PER_MOMENT, `a moment revealed ${max} hidden elements — no dumping`);
  },
);

// --- Thresholds across seeds --------------------------------------------------

Given("the game is simulated with seed {string}", function (this: BbWorld, seed: string) {
  playLive(this, Number(seed));
});

// regex (not a Cucumber Expression) because the step text contains parentheses.
Then(
  /^most NPC interactions occurred off-screen \(share ≥ the configured majority minimum\)$/,
  function (this: BbWorld) {
    const share = this.liveFidelity!.metrics.offscreenShare;
    assert.ok(share >= RICHNESS.MIN_OFFSCREEN_SHARE, `off-screen share ${share} < ${RICHNESS.MIN_OFFSCREEN_SHARE}`);
  },
);

Then("the diversity of NPC interaction types meets the configured minimum", function (this: BbWorld) {
  const div = this.liveFidelity!.metrics.typeDiversity;
  assert.ok(div >= RICHNESS.MIN_TYPE_DIVERSITY, `type diversity ${div} < ${RICHNESS.MIN_TYPE_DIVERSITY}`);
});

Then("the hidden-element surfacing rate stays within the configured bounds", function (this: BbWorld) {
  const rate = this.liveFidelity!.metrics.revealShare;
  assert.ok(rate > 0 && rate <= RICHNESS.MAX_SURFACING_RATE, `surfacing rate ${rate} out of bounds`);
});
