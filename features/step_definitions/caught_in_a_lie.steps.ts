import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim, BeliefStore } from "../../src/engine/beliefStore";
import type { Agenda } from "../../src/engine/agenda";
import type { ClaimLog, SpokenClaim } from "../../src/engine/spokenClaims";

/**
 * Feature 0154 scenarios 1-5 - caught in a lie (theme 2 slice 5a, ORW-330). Drives the REAL adapter through a registry sandbox: claims are told with
 * `tellClaim`; the board changes through the adapter's own hooks (`evictionCountPublic` is the call the staged eviction makes when its count is public;
 * `assuranceNominated` is the call a nomination makes). TEST-ONLY seams: the live season (claims, beliefs, agendas), the credibility read, the agenda recheck.
 * Scenarios 6-8 (vote claims, ballots, the house mix) are 5b's. Roles only.
 */
type Bag = { s?: GameSessionAdapter; speaker?: string; listener?: string; third?: string; fourth?: string; told?: SpokenClaim; before?: number };
const bag = (w: unknown): Bag => ((w as { caught0154?: Bag }).caught0154 ??= {});
const live = (s: GameSessionAdapter) => (s as unknown as { live: { playedGame?: boolean; claims?: ClaimLog; beliefs?: BeliefStore; agendas?: Record<string, Agenda> } }).live;
const recheck = (s: GameSessionAdapter, who: string) => (s as unknown as { agendaRecheck(t: string, only: string[]): void }).agendaRecheck("week-start", [who]);
let n = 0;

const held = (w: unknown, holder: string): readonly BeliefClaim[] => live(bag(w).s!).beliefs?.[holder] ?? [];
const lied = (w: unknown, holder: string, liar: string) => held(w, holder).filter((c) => c.kind === "lied-to-me" && c.subject === liar && !c.refuted);
const planted = (w: unknown) => held(w, bag(w).listener!).find((c) => c.id.endsWith(`|${bag(w).told!.id}`))!;

/** A started played season with the 0154 flags on, once per scenario (scenario 1 shares 0149's "a started season with claims on" step: its session is reused). */
function init(w: unknown): Bag {
  const b = bag(w);
  if (b.s) return b;
  const shared = (w as { claims0149?: { s?: GameSessionAdapter; npcs?: string[] } }).claims0149;
  if (shared?.s) { b.s = shared.s; [b.speaker, b.listener, b.third, b.fourth] = shared.npcs!; }
  else {
    b.s = new GameSessionRegistry().sandboxFor(`caught0154-${n++}`).session;
    b.s.setNpcBeliefsEnabled(true);
    b.s.createCharacter({ playerName: "The Player", seed: 11 });
    [b.speaker, b.listener, b.third, b.fourth] = b.s.livingIds().filter((id) => id !== PLAYER);
  }
  b.s.setNpcBeliefsEnabled(true); b.s.setLiesCaughtEnabled(true); b.s.setAssurancesEnabled(true);
  live(b.s).playedGame = true;
  assert.ok(b.fourth, "too few houseguests");
  return b;
}

// ---- scenarios 1 and 4: a vote claim against the PUBLIC count ----
// (the engine refuses a claim whose subject is its own speaker, so "I voted to keep you" is told as a third houseguest voting to keep the listener)

Given("an NPC told a houseguest {string}", function (_said: string) {
  const b = init(this);
  b.told = b.s!.tellClaim({ speaker: b.speaker!, listener: b.listener!, kind: "voted-to-keep", subject: b.third!, object: b.listener!, isTrue: false, intent: "mislead" });
  assert.ok(b.told, "the engine refused the claim");
  assert.ok(planted(this), "the claim planted no belief");
});

const voters = (w: unknown) => [bag(w).third!, bag(w).fourth!, bag(w).speaker!];
Given("the public vote count makes that impossible", function () {
  const b = init(this);
  b.s!.evictionCountPublic({ evictee: b.listener!, evictVotes: voters(this).length, voters: voters(this) });   // unanimous: nobody kept the evictee
});
Given("the public vote count is consistent with it", function () {
  const b = init(this);
  b.s!.evictionCountPublic({ evictee: b.listener!, evictVotes: voters(this).length - 1, voters: voters(this) });   // one voter kept them: the count cannot say who
});

Then(/^(?:the|that) houseguest believes the NPC lied to them$/, function () {
  const b = init(this);
  assert.equal(lied(this, b.listener!, b.speaker!).length, 1, "the houseguest does not believe they were lied to");
});
Then("the claim the houseguest was told is refuted", function () {
  const c = planted(this);
  assert.equal(c.refuted, true);
  assert.ok(c.id.endsWith(`|${bag(this).told!.id}`), "the belief id was not kept");
});
Then("the NPC's word counts for less with that houseguest from then on", function () {
  const b = init(this);
  assert.ok(b.s!.credibilityOf(b.listener!, b.speaker!) < 1, "the liar's credibility did not drop");
  assert.equal(b.s!.credibilityOf(b.third!, b.speaker!), 1, "a houseguest who caught nothing lost trust too");
});
Then("nothing is refuted and no one believes they were lied to", function () {
  const b = init(this);
  assert.ok(!planted(this).refuted, "an unsettled claim was refuted");
  for (const id of [b.listener!, b.third!, b.fourth!, b.speaker!]) assert.equal(held(this, id).filter((c) => c.kind === "lied-to-me").length, 0, "a lie was caught the board cannot settle");
  assert.equal(b.s!.credibilityOf(b.listener!, b.speaker!), 1);
});

// ---- scenario 2: a nomination after "you're safe" ----

Given("an NPC assured a houseguest they were safe", function () {
  const b = init(this);
  b.s!.recordAssurance({ from: b.speaker!, to: b.listener!, kind: "safe", sincerity: 0.5, source: "npc" });
});
When("the NPC nominates that houseguest", function () {
  const b = init(this);
  b.s!.assuranceNominated(b.speaker!, b.listener!);   // the call a committed nomination makes
});

// ---- scenario 3: two claims that cannot both be true ----

Given("an NPC told one houseguest that a second houseguest has a final two with a third", function () {
  const b = init(this);
  assert.ok(b.s!.tellClaim({ speaker: b.speaker!, listener: b.listener!, kind: "final-two-with", subject: b.third!, object: b.fourth!, isTrue: false, intent: "mislead" }));
});
Given("told the same houseguest that the second is going after the third", function () {
  const b = init(this);
  assert.ok(b.s!.tellClaim({ speaker: b.speaker!, listener: b.listener!, kind: "going-after", subject: b.third!, object: b.fourth!, isTrue: false, intent: "mislead" }));
});

// ---- scenario 5: revenge ----

Given("a houseguest has caught an NPC lying about something that cost them", function () {
  const b = init(this);
  b.s!.recordAssurance({ from: b.speaker!, to: b.listener!, kind: "safe", sincerity: 0.5, source: "npc" });
  b.s!.assuranceNominated(b.speaker!, b.listener!);   // the assurance broke: nominated after "you're safe"
  assert.equal(lied(this, b.listener!, b.speaker!).length, 1, "the lie was not caught");
});
Then("the houseguest can take up a goal against that NPC, with the caught lie as its reason", function () {
  const b = init(this);
  recheck(b.s!, b.listener!);
  const goals = (live(b.s!).agendas?.[b.listener!]?.goals ?? []).filter((g) => g.kind === "revenge" && g.target === b.speaker);
  assert.equal(goals.length, 1, "no revenge goal formed");
  assert.equal(goals[0]!.why[0]!.kind, "belief");
  assert.equal(goals[0]!.why[0]!.about, b.speaker);
});
