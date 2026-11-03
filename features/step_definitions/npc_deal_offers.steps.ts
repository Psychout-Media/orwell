import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import type { UserSandbox } from "../../src/composition/registry";
import { resolvePending } from "../support/answerPending";

// HARD rule: roles only — NPC, houseguest, player. No names.

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

type Offer = NonNullable<ReturnType<GameSession["getGameState"]>["openDealOffer"]>;

// PO ruling 2026-11-01: an offer is OPEN STATE the narrator voices (never a pending card, never blocking).
function driveToOffer(sb: UserSandbox, maxSteps = 200): Offer | null {
  for (let i = 0; i < maxSteps; i++) {
    const v = sb.session.advanceGame();
    const o = sb.session.getGameState().openDealOffer;
    if (o) return o;
    if (v.pending) resolveLegally(sb.session, v.pending);
    if (v.finished) return null;
  }
  return null;
}

function newGame(user: string, seed: number, offersOn: boolean): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "P", seed });
  sb.session.setNpcDealOffersEnabled(offersOn);
  return sb;
}

const offerEvents = (sb: UserSandbox) =>
  sb.engine.events.queryAll().filter((e) => e.content.includes("float") && e.content.includes("deal"));

// ── float at a lull ───────────────────────────────────────────────────────────────────────────
Given("a live game with houseguest deal offers enabled", function (this: BbWorld) {
  this.dofSandbox = newGame("dof-on", 7, true);
});

When("the season plays through several lulls", function (this: BbWorld) {
  this.dofOffer = driveToOffer(this.dofSandbox!);
});

Then("a houseguest floats the player a deal offer", function (this: BbWorld) {
  assert.ok(this.dofOffer, "a houseguest floated the player a deal");
  // Never a pop-up: the floated offer is not a pending decision card.
  assert.notEqual(this.dofSandbox!.session.getGameState().pending?.kind, "deal-offer");
});

Then("the floated offer names who it is from, its kind, and its terms", function (this: BbWorld) {
  const o = this.dofOffer!;
  assert.ok(o, "the offer detail is present");
  assert.notEqual(o.from.id, PLAYER); // an NPC floated it
  assert.ok(["safety", "final-two"].includes(o.kind));
  assert.ok(o.terms.length > 0);
});

// ── grounded kind ─────────────────────────────────────────────────────────────────────────────
Given("a live game where one houseguest reads the player as a strong ally", function (this: BbWorld) {
  const sb = newGame("dof-grounded", 7, true);
  const ally = sb.session.livingIds().find((id) => id !== PLAYER)!;
  sb.engine.relationships.edge(ally, PLAYER).trust = 0.95;
  sb.engine.relationships.edge(ally, PLAYER).affinity = 0.95;
  this.dofSandbox = sb;
  this.dofFrom = ally;
});

When("that ally floats the player a deal offer", function (this: BbWorld) {
  this.dofOffer = driveToOffer(this.dofSandbox!);
});

Then("the floated offer is a final-two deal, grounded in their real bond", function (this: BbWorld) {
  assert.ok(this.dofOffer, "the ally floated an offer");
  assert.equal(this.dofOffer!.from.id, this.dofFrom); // the strongest-bond NPC offers
  assert.equal(this.dofOffer!.kind, "final-two"); // a strong bond ⇒ a final-two ask (grounded)
});

// ── accept / decline / vault (shared Given) ─────────────────────────────────────────────────────
Given("a houseguest has floated the player a deal offer", function (this: BbWorld) {
  const sb = newGame("dof-resolve", 7, true);
  this.dofOffer = driveToOffer(sb);
  assert.ok(this.dofOffer, "a houseguest floated an offer");
  this.dofSandbox = sb;
  this.dofFrom = this.dofOffer!.from.id;
  this.dofBeforeThreat = sb.engine.relationships.edge(this.dofFrom!, PLAYER).threat;
  this.dofBeforeDeals = (sb.session.getGameState().deals ?? []).length;
});

When("the player accepts the floated offer", function (this: BbWorld) {
  this.dofSandbox!.session.submitDecision({ kind: "deal-offer", vote: "accept" });
});

Then("a deal between the player and that houseguest stands on the board", function (this: BbWorld) {
  const deals = this.dofSandbox!.session.getGameState().deals ?? [];
  assert.equal(deals.length, this.dofBeforeDeals! + 1);
  const ids = (d: (typeof deals)[number]): string[] => d.parties.map((p) => (typeof p === "string" ? p : p.id));
  assert.ok(deals.some((d) => ids(d).includes(PLAYER) && ids(d).includes(this.dofFrom!)));
});

Then("no floated offer is left waiting", function (this: BbWorld) {
  assert.equal(this.dofSandbox!.session.getGameState().openDealOffer, undefined);
});

When("the player declines the floated offer", function (this: BbWorld) {
  this.dofSandbox!.session.submitDecision({ kind: "deal-offer", vote: "decline" });
});

Then("no deal is created from the floated offer", function (this: BbWorld) {
  assert.equal((this.dofSandbox!.session.getGameState().deals ?? []).length, this.dofBeforeDeals);
});

Then("that houseguest's hidden read of the player cools a little", function (this: BbWorld) {
  const after = this.dofSandbox!.engine.relationships.edge(this.dofFrom!, PLAYER).threat;
  assert.ok(after > this.dofBeforeThreat!, "the rebuffed houseguest reads the player as more of a threat");
});

When("the player-facing surfaces are read for the floated offer", function (this: BbWorld) {
  // no-op: assertions read the sandbox directly (the offer is a player-witnessed event, not a hidden one)
});

Then("the floated offer is the player's own knowledge, never hidden Vault content", function (this: BbWorld) {
  const approach = offerEvents(this.dofSandbox!)[0];
  assert.ok(approach, "the approach was recorded");
  assert.ok(!approach!.hidden, "the approach is NOT hidden — the NPC came to the player");
  assert.ok(approach!.witnessSet.includes(PLAYER));
});

Then("only one floated offer stands at a time", function (this: BbWorld) {
  const sb = this.dofSandbox!;
  const first = sb.session.getGameState().openDealOffer;
  assert.ok(first, "an offer is standing");
  const approaches = offerEvents(sb).length;
  // TRY to stack a second, straight through the real lull logic (`maybeOfferPlayerDeal`, the code `advanceGame` runs
  // every beat). The "one per week" cooldown is cleared and the seeded roll is varied across many (week, beat) keys,
  // so a roll WILL pass; the only thing left stopping a second offer is the one-open-offer rule itself.
  const inner = sb.session as unknown as {
    live: { week: number; beat: string; lastDealOfferWeek?: number };
    maybeOfferPlayerDeal(): void;
  };
  const { week, beat, lastDealOfferWeek } = inner.live;
  for (let w = week; w < week + 40; w++) {
    for (const b of ["hoh-competition", "nominations", "veto-competition", "veto-ceremony", "eviction-reveal", "eviction"]) {
      inner.live.week = w; inner.live.beat = b; inner.live.lastDealOfferWeek = undefined;
      inner.maybeOfferPlayerDeal();
      const open = sb.session.getGameState().openDealOffer;
      assert.deepEqual(open, first, `week ${w}/${b}: a second offer replaced or stacked onto the standing one`);
      assert.equal(offerEvents(sb).length, approaches, `week ${w}/${b}: a second approach was floated while one stood`);
    }
  }
  inner.live.week = week; inner.live.beat = beat; inner.live.lastDealOfferWeek = lastDealOfferWeek;
  // Resolving the one offer clears it — nothing is left behind.
  sb.session.submitDecision({ kind: "deal-offer", vote: "decline" });
  assert.equal(sb.session.getGameState().openDealOffer, undefined);
});

// ── PO ruling 2026-11-01: never blocks; lapses unanswered ──────────────────────────────────────
When("the player ignores the floated offer and play continues", function (this: BbWorld) {
  const sb = this.dofSandbox!;
  this.dofSeqBefore = sb.session.gameStatus().beatSeq;
  for (let i = 0; i < 400 && sb.session.getGameState().openDealOffer; i++) {
    const v = sb.session.advanceGame();
    // The no-pop-up rule, checked on EVERY advance: a floated offer never becomes a blocking card.
    if (v.pending?.kind === "deal-offer") throw new Error("a floated offer must never be a pending card");
    if (v.pending) resolveLegally(sb.session, v.pending);
    if (v.finished) break;
  }
});

Then("the week keeps moving while the offer stands", function (this: BbWorld) {
  assert.ok(this.dofSandbox!.session.gameStatus().beatSeq > this.dofSeqBefore!, "the game advanced with an open offer");
});

Then("the floated offer lapses when the week rolls over", function (this: BbWorld) {
  const sb = this.dofSandbox!;
  assert.equal(sb.session.getGameState().openDealOffer, undefined);
  assert.ok(sb.session.getGameState().week > this.dofOffer!.madeWeek);
  const lapse = sb.engine.events.queryAll().find((e) => e.content.includes("lapsed unanswered"));
  assert.ok(lapse, "the lapse was recorded");
  assert.ok(!lapse!.hidden && lapse!.witnessSet.includes(PLAYER), "the lapse is the player's own knowledge");
});

// ── flag off ────────────────────────────────────────────────────────────────────────────────────
Given("a live game with houseguest deal offers disabled", function (this: BbWorld) {
  this.dofSandbox = newGame("dof-off", 7, false);
});

Then("no houseguest ever floats the player a deal offer", function (this: BbWorld) {
  assert.equal(this.dofOffer, null);
  assert.equal(offerEvents(this.dofSandbox!).length, 0);
});
