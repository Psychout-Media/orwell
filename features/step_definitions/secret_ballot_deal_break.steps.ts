import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import {
  newLiveGame, advanceUntil, cloneSnapshot, resumeFrom, edgeIn, withOpenDeal, searchSeeds, freshScratch,
} from "../support/liveEvictionNight";

// AMEND 0047 (2026-11-03) - "A deal broken by a secret ballot does not single out the breaker" (#1963, #1976, #1987).
// Until now only tests/unit/sealedBallotLeak1963.test.ts proved this, by poking private methods on a hand-set ballot. These
// steps play a REAL seeded game through the live adapter to a REAL staged weekly ballot / nomination, then run the same
// night twice from one engine snapshot - once as it is (the control) and once with one extra open deal in the ledger - and
// compare the wronged houseguest's hidden read (relationship edges + recorded manner) at the moment the break lands.
// Roles only: wronged party, breaker, voters.

const EPS = 1e-6;

interface Contest {
  wronged: EntityId;
  breaker: EntityId;
  /** Everyone whose ballot named the wronged party (the breaker included). */
  suspects: EntityId[];
  control: SessionSnapshot;
  broken: SessionSnapshot;
}

/** Re-play a snapshot to the commit of `beat` (the break lands inside that commit) and return the resulting engine snapshot. */
function playTo(snap: SessionSnapshot, beat: string): SessionSnapshot | null {
  const g = resumeFrom(snap, 0, "contest");
  return advanceUntil(g, (v) => v.event?.beat === beat) ? cloneSnapshot(g) : null;
}

const trust = (snap: SessionSnapshot, from: EntityId, to: EntityId): number => edgeIn(snap, from, to).trust;
const betrayed = (snap: SessionSnapshot, wronged: EntityId, breaker: EntityId): boolean =>
  snap.live?.mannerByEvictee?.[wronged]?.[breaker]?.betrayed === true;

/**
 * Walk a seed's staged evictions (up to `maxNights`); at each, park at the vote reveal (the ballot is fixed, the break has
 * not landed) and offer the parked snapshot to `pick`, which returns a Contest or undefined.
 */
function findBallot(what: string, pick: (parked: SessionSnapshot, control: SessionSnapshot) => Omit<Contest, "control" | "broken"> | undefined): Contest {
  return searchSeeds(what, 80, (seed) => {
    const g = newLiveGame(seed, "ballot");
    for (let night = 0; night < 4; night++) {
      const v = advanceUntil(g, (view) => view.eviction?.stage === "votes");
      if (!v) return undefined;
      const parked = cloneSnapshot(g);
      const control = playTo(parked, "eviction");
      const found = control ? pick(parked, control) : undefined;
      if (found && control) {
        const broken = playTo(withOpenDeal(parked, [found.wronged, found.breaker], "safety", parked.live!.week), "eviction");
        if (broken) return { ...found, control, broken };
      }
      // Not this night: let it finish and look at the next staged eviction.
      if (!advanceUntil(g, (view) => view.event?.beat === "eviction-result")) return undefined;
    }
    return undefined;
  });
}

const votersAgainst = (parked: SessionSnapshot, wronged: EntityId): EntityId[] =>
  Object.entries(parked.live!.eviction!.voteOf).filter(([, target]) => target === wronged).map(([voter]) => voter as EntityId);

Given("a live eviction night where an NPC deal partner votes with the house to evict the wronged party", function (this: BbWorld) {
  // The secret-ballot case: an NPC nominee sent out by >= 3 voters, one of whom (a non-player voter the evictee's plain read
  // does not already blame, so a demerit would be NEW information) holds an open deal with them.
  const n = freshScratch();
  n.facts.contest = findBallot("a staged eviction with an NPC nominee voted against by >= 3 voters incl. an unblamed NPC", (parked, control) => {
    for (const wronged of parked.live!.eviction!.nominees) {
      if (wronged === PLAYER) continue;
      const suspects = votersAgainst(parked, wronged);
      const breaker = suspects.find((s) => s !== PLAYER && !betrayed(control, wronged, s));
      if (suspects.length >= 3 && breaker) return { wronged, breaker, suspects };
    }
    return undefined;
  });
  this.night = n;
});

Given("a live eviction night where the player is on the block and a deal partner votes against them", function (this: BbWorld) {
  // The player-wronged case: the PLAYER is on the block with >= 2 NPC voters against them, one of whom holds a deal with them.
  const n = freshScratch();
  n.facts.contest = findBallot("a staged eviction with the player on the block and >= 2 NPC voters against them", (parked, control) => {
    if (!parked.live!.eviction!.nominees.includes(PLAYER)) return undefined;
    const suspects = votersAgainst(parked, PLAYER);
    // the player's read of the breaker must have room to fall (trust already floored at 0 would hide the shock)
    const breaker = suspects.find((s) => !betrayed(control, PLAYER, s) && trust(control, PLAYER, s) > 0.15);
    return suspects.length >= 2 && breaker ? { wronged: PLAYER, breaker, suspects } : undefined;
  });
  this.night = n;
});

Given("a live nomination night where an NPC head of household holds a deal with a houseguest they are about to nominate", function (this: BbWorld) {
  // The public case: an NPC HOH is parked JUST BEFORE the nominations ceremony; the control run shows who goes on the block,
  // and the deal is with one of those nominees (so it breaks in the open, by a public nomination).
  const n = freshScratch();
  n.facts.contest = searchSeeds("a nominations ceremony run by an NPC head of household where the deal partner still goes up", 80, (seed) => {
    const g = newLiveGame(seed, "public");
    for (let week = 0; week < 4; week++) {
      const parkedAtNominations = (view: { pending: unknown }): boolean => {
        if (view.pending) return false;
        const live = g.session.snapshot().live;
        return live?.beat === "nominations" && !!live.hoh && live.hoh !== PLAYER;
      };
      if (!advanceUntil(g, parkedAtNominations)) return undefined;
      const parked = cloneSnapshot(g);
      const control = playTo(parked, "nominations");
      const breaker = parked.live!.hoh as EntityId;
      const wronged = control?.live?.nominees?.find((x) => x !== PLAYER);
      if (control && wronged && !betrayed(control, wronged, breaker)) {
        const broken = playTo(withOpenDeal(parked, [wronged, breaker], "safety", parked.live!.week), "nominations");
        // The deal must not have talked the HOH out of the nomination: it breaks only if the partner still goes up.
        if (broken?.live?.nominees?.includes(wronged)) return { wronged, breaker, suspects: [breaker], control, broken } satisfies Contest;
      }
      if (!advanceUntil(g, (view) => view.event?.beat === "eviction-result")) return undefined;
    }
    return undefined;
  });
  this.night = n;
});

/** The break really happened: the deal was open in the ledger of the "deal" night and is broken now (never an unbroken deal). */
function assertDealBroken(w: BbWorld, how: string): void {
  const c = w.night!.facts.contest as Contest;
  assert.ok(!(c.control.deals ?? []).some((d) => d.id === "deal:bdd-0047-1"), "the control night carries no extra deal");
  assert.equal((c.broken.deals ?? []).find((d) => d.id === "deal:bdd-0047-1")?.status, "broken", `the deal was broken ${how}`);
}

When("the partner breaks the deal through the secret ballot", function (this: BbWorld) {
  // Both nights were played to the moment the break lands (from one engine snapshot) in the Given; confirm it landed.
  assertDealBroken(this, "by the voter's secret ballot");
});

When("the head of household nominates their deal partner", function (this: BbWorld) {
  assertDealBroken(this, "by the public nomination");
});

Then("the wronged houseguest's hidden read of every voter who voted to evict them takes a share of the shock", function (this: BbWorld) {
  const c = this.night!.facts.contest as Contest;
  for (const s of c.suspects) {
    const drop = trust(c.control, c.wronged, s) - trust(c.broken, c.wronged, s);
    assert.ok(drop > EPS, `suspect ${s} shares the betrayal shock (trust fell by ${drop})`);
  }
  // Only the voters who sent them out share it: anyone else the wronged party knows is untouched.
  for (const e of c.broken.relationships.filter((r) => r.from === c.wronged && !c.suspects.includes(r.to))) {
    assert.ok(Math.abs(e.trust - trust(c.control, c.wronged, e.to)) < EPS, `non-voter ${e.to} takes no part of the shock`);
  }
});

Then("the breaker is not an outlier among those voters", function (this: BbWorld) {
  const c = this.night!.facts.contest as Contest;
  const drop = (s: EntityId): number => trust(c.control, c.wronged, s) - trust(c.broken, c.wronged, s);
  const others = c.suspects.filter((s) => s !== c.breaker).map(drop);
  assert.ok(drop(c.breaker) > EPS, "the real breaker carries its share");
  // Indistinguishable within the temperature jitter: the breaker's drop sits inside the innocent suspects' range, not above it.
  assert.ok(drop(c.breaker) / Math.max(...others) < 2.5, `the breaker (${drop(c.breaker)}) is no outlier among the other voters (${others.join(", ")})`);
});

Then("no jury demerit names the breaker", function (this: BbWorld) {
  const c = this.night!.facts.contest as Contest;
  // The control (no deal) has no grievance on file against the breaker; the sealed break must not add one for any voter.
  assert.equal(betrayed(c.control, c.wronged, c.breaker), false, "(control) no grievance against the breaker without a deal");
  for (const s of c.suspects) {
    assert.deepEqual(
      c.broken.live?.mannerByEvictee?.[c.wronged]?.[s] ?? null,
      c.control.live?.mannerByEvictee?.[c.wronged]?.[s] ?? null,
      `the deal break left no jury demerit against voter ${s}`,
    );
  }
});

Then("a break against the player lands on the breaker alone", function (this: BbWorld) {
  const c = this.night!.facts.contest as Contest;
  const drop = (s: EntityId): number => trust(c.control, PLAYER, s) - trust(c.broken, PLAYER, s);
  assert.ok(drop(c.breaker) > EPS, "the full betrayal shock lands on the breaker");
  for (const e of c.broken.relationships.filter((r) => r.from === PLAYER && r.to !== c.breaker)) {
    assert.ok(Math.abs(e.trust - trust(c.control, PLAYER, e.to)) < EPS, `voter ${e.to} is not blamed for the breaker's vote (nothing is spread)`);
  }
  assert.equal(betrayed(c.broken, PLAYER, c.breaker), true, "the demerit is recorded as for any attributed break");
});

Then("a public break lands on the breaker alone with a jury demerit", function (this: BbWorld) {
  const c = this.night!.facts.contest as Contest;
  const drop = trust(c.control, c.wronged, c.breaker) - trust(c.broken, c.wronged, c.breaker);
  assert.ok(drop > EPS, `the nomination break lands fully on the head of household (trust fell by ${drop})`);
  for (const e of c.broken.relationships.filter((r) => r.from === c.wronged && r.to !== c.breaker)) {
    assert.ok(Math.abs(e.trust - trust(c.control, c.wronged, e.to)) < EPS, `${e.to} is not touched by a break done in the open`);
  }
  assert.equal(betrayed(c.broken, c.wronged, c.breaker), true, "a public break names the breaker to the jury");
});
