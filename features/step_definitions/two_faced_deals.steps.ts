import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { Deal } from "../../src/domain/deal";
import { recordPlan, type PlanStore } from "../../src/engine/dealPlans";

/**
 * Feature 0178 - two-faced deals (Theme 3 slice 1). Drives the REAL adapter through a registry sandbox: deals go through the adapter's real deal ledger, the
 * plan is decided and carried out by the adapter's own beat step (`planAndCarryOutDeals`), the flip reaches the vote through the season context the live
 * loop reads (`ctx().dealTrustFor`), and the retrospective is the real post-crown door. TEST-ONLY seams: the live season (the beat, the week, the plan store,
 * finished), the deal ledger, the adapter's private beat step and context. Roles only: a houseguest, the player.
 */
type Live = { playedGame?: boolean; dealPlans?: PlanStore; week: number; beat: string; finished?: boolean };
type Ledger = { make(parties: [string, string], kind: string, terms: string, madeEventId?: string, madeWeek?: number): Deal; all: readonly Deal[] };
type Seam = { live: Live; deals: Ledger; planAndCarryOutDeals(): void; ctx(): { dealTrustFor?: (h: string, o: string) => number } };
type Bag = { sb?: UserSandbox; npc?: string; deal?: Deal };
const bag = (w: unknown): Bag => ((w as { plans0178?: Bag }).plans0178 ??= {});
const seam = (w: unknown) => bag(w).sb!.session as unknown as Seam;
const session = (w: unknown) => bag(w).sb!.session as GameSessionAdapter;
let n = 0;

Given("a played season with deal plans on", function () {
  const sb = new GameSessionRegistry().sandboxFor(`plans0178-${n++}`);
  sb.session.setDealPlansEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 8 });
  const b = bag(this);
  b.sb = sb;
  seam(this).live.playedGame = true;
  b.npc = sb.session.livingIds().filter((id) => id !== PLAYER)[0];
});

Given("a houseguest who has made a great many deals this season", function () {
  const b = bag(this);
  const others = session(this).livingIds().filter((id) => id !== PLAYER && id !== b.npc);
  for (let i = 0; i < 30; i++) {
    const d = seam(this).deals.make([b.npc!, others[i % others.length]!], "vote", "a vote this week", undefined, seam(this).live.week);
    (d as { status: string }).status = "lapsed"; // past deals, over now: they count toward how many deals this houseguest has made
  }
});

When("they agree to keep the player safe", function () {
  const b = bag(this);
  b.deal = seam(this).deals.make([b.npc!, PLAYER], "safety", "you are safe with me this week", undefined, seam(this).live.week);
  seam(this).planAndCarryOutDeals();
});

Then("the engine gives them a secret plan to break it", function () {
  const b = bag(this);
  const plan = seam(this).live.dealPlans?.[b.deal!.id]?.[b.npc!];
  assert.ok(plan, "no plan was made for the houseguest's promise");
  assert.notEqual(plan.kind, "keep", "a houseguest with that many deals behind them planned to keep this one");
});

function planned(w: unknown, kind: "safety" | "vote", plan: "break-at" | "flip", at: "nominations" | "vote"): void {
  const b = bag(w); const live = seam(w).live;
  b.deal = seam(w).deals.make([b.npc!, PLAYER], kind, "a promise to the player", undefined, live.week);
  recordPlan((live.dealPlans ??= {}), b.deal.id, b.npc!, { kind: plan, moment: { week: live.week, at } }, live.week);
}

Given("a houseguest whose secret plan is to break their safety deal with the player at this week's nominations", function () { planned(this, "safety", "break-at", "nominations"); });
Given("a houseguest whose secret plan is to flip their vote deal with the player at this week's vote", function () { planned(this, "vote", "flip", "vote"); });

When("the nominations come", function () {
  seam(this).live.beat = "nominations";
  seam(this).planAndCarryOutDeals();
});

Then("the deal is broken by that houseguest, quietly", function () {
  const b = bag(this);
  const d = seam(this).deals.all.find((x) => x.id === b.deal!.id)!;
  assert.equal(d.status, "broken");
  const view = session(this).getGameState().deals?.find((x) => x.id === d.id);
  if (view) assert.equal(view.status, "open", "the player's own view shows the break (it must stay quiet until a pathway)");
});

Then("their plan is recorded as carried out", function () {
  const b = bag(this);
  assert.equal(seam(this).live.dealPlans![b.deal!.id]![b.npc!]!.outcome, "carried-out");
});

When("the vote comes", function () { seam(this).live.beat = "eviction"; });

Then("the deal pushes that houseguest to vote the player out, not to keep them", function () {
  const b = bag(this);
  const trust = seam(this).ctx().dealTrustFor?.(b.npc!, PLAYER);
  assert.ok(trust !== undefined && trust < 0, `the deal's weight at the vote is ${trust}`);
});

Given("the player has promised a houseguest, aloud, to keep them off the block", function () {
  const b = bag(this);
  const present = (session(this).whereabouts()?.present ?? []).map((x) => x.id as string).filter((id) => id !== PLAYER);
  const to = present[0] ?? b.npc!;
  const r = session(this).recordOpenLedger({ text: "I will keep you off the block.", speaker: PLAYER, addressedTo: [to], kind: "promise" });
  assert.ok(r.accepted, `the promise was not recorded (${r.reason})`);
});

Then("no player or admin view shows a plan while the season is live", async function () {
  const sb = bag(this).sb!;
  const out = JSON.stringify([
    await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
    await sb.mcp.admin.callTool("inspectNonVaultState", {}), session(this).seasonRetrospective(),
  ]);
  assert.ok(!/dealPlans|break-at|cut-final-three|"this-week"|secretPlans/.test(out), "a plan reached a live view");
});

When("the season is crowned", function () { seam(this).live.finished = true; });

Then("the retrospective shows the houseguest's plan for the deal, and how it went", function () {
  const b = bag(this);
  const retro = session(this).seasonRetrospective()?.dealPlans;
  const row = retro?.secretPlans.find((p) => p.holder.id === b.npc && p.with.id === PLAYER);
  assert.ok(row, "the retrospective does not show the houseguest's plan");
  assert.equal(row.plan, "break-at");
  assert.ok(row.outcome, "the plan's outcome is missing");
});

Then("it shows the player's own promises, each with whether it was kept", function () {
  const retro = session(this).seasonRetrospective()?.dealPlans;
  const said = retro?.yourPromises.filter((p) => p.source === "said") ?? [];
  assert.ok(said.some((p) => /off the block/.test(p.text) && p.status), "the player's spoken promise is missing from their record");
  assert.ok((retro?.yourPromises ?? []).some((p) => p.source === "deal"), "the player's deal is missing from their record");
});
