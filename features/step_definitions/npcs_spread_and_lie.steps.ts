import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefStore } from "../../src/engine/beliefStore";
import type { ClaimLog, SpokenClaim } from "../../src/engine/spokenClaims";
import { truthOf, planSpeech, speechActionOf, type TruthFacts } from "../../src/engine/houseSpeech";
import { chooseHourAction, type HourView } from "../../src/engine/houseLife";
import type { Agenda, Goal } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";

/**
 * Feature 0153 - NPCs spread and lie on purpose (theme 2 slice 3, ORW-330). Drives the REAL adapter through a registry sandbox: a house-life
 * speech action goes through the adapter's own speech step (`sayInHouseLife`, the call the house-life loop makes), so the claim, its truth
 * and the listener's belief are the engine's. The campaign scenario drives the pure hour planner + speech planner over a day.
 * TEST-ONLY seams: the live season (claims, beliefs), the adapter's speech step and truth reads. Roles only.
 */
type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; planter?: string; rival?: string; ear?: string; told?: SpokenClaim; listeners?: string[]; voters?: string[] };
const bag = (w: unknown): Bag => ((w as { lie0153?: Bag }).lie0153 ??= {});
const live = (s: GameSessionAdapter) => (s as unknown as { live: { playedGame?: boolean; claims?: ClaimLog; beliefs?: BeliefStore } }).live;
type Seam = { sayInHouseLife(p: { kind: string; actor: string; about?: string; truthful: boolean }, partner: string, salt: string): SpokenClaim | undefined; truthFacts(): TruthFacts };
const seam = (s: GameSessionAdapter) => s as unknown as Seam;
let n = 0;

function played(w: unknown): GameSessionAdapter {
  const sb = new GameSessionRegistry().sandboxFor(`lie0153-${n++}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 9 });
  live(sb.session).playedGame = true;
  const b = bag(w);
  b.sb = sb; b.s = sb.session;
  [b.planter, b.rival, b.ear] = sb.session.livingIds().filter((id) => id !== PLAYER);
  return sb.session;
}

Given("a played season where a houseguest wants a rival out", function () { played(this); });
Given("a played season with beliefs on", function () { played(this); });

When("they plant a story with another houseguest", function () {
  const b = bag(this);
  b.told = seam(b.s!).sayInHouseLife({ kind: "plant", actor: b.planter!, about: b.rival!, truthful: false }, b.ear!, "bdd");
  assert.ok(b.told, "the plant said nothing");
});

Then("the listener believes the story, sourced to the planter", function () {
  const b = bag(this);
  const held = (live(b.s!).beliefs?.[b.ear!] ?? []).filter((c) => c.source === b.planter && c.subject === b.rival && c.value);
  assert.equal(held.length, 1, "the listener holds no belief from the planted story");
});

Then("the engine knows the story is false", function () {
  const b = bag(this);
  assert.equal(b.told!.isTrue, false);
  assert.equal(b.told!.intent, "mislead");
  assert.equal(truthOf(b.told!, seam(b.s!).truthFacts()), false, "the engine's own records say the story is true");
});

Then("the claims the narrator may voice are still empty", function () {
  assert.deepEqual(bag(this).s!.claimsThePlayerHeard(), []);
});

// ---- the campaign: a day of hours for someone who wants a nominee out ----

Given("a played season where a houseguest wants a nominee evicted", function () {
  const b = bag(this);
  b.voters = ["npc:v1", "npc:v2", "npc:v3"];
});

When("their lies go out over a day", function () {
  const b = bag(this);
  const OWNER = "npc:o", TARGET = "npc:t", OTHER_NOM = "npc:n", HOH = "npc:h";
  const goal: Goal = { id: `${OWNER}:get-them-out:${TARGET}`, owner: OWNER, horizon: "week", kind: "get-them-out", target: TARGET, why: [{ kind: "character", weight: 1 }],
    test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: 1 };
  const agenda: Agenda = { owner: OWNER, goals: [goal], history: [], formedForWeek: 1 };
  const everyone = [OWNER, TARGET, OTHER_NOM, HOH, ...b.voters!];
  const where = new Map<string, Room>(everyone.map((id, i) => [id, (["living-room", "kitchen", "backyard"] as Room[])[i % 3]!]));
  const facts: TruthFacts = { goalAgainst: () => false, votedToEvict: () => false, votedToKeep: () => false, finalTwo: () => false, liedTo: () => false, talkedAbout: () => false };
  b.listeners = [];
  for (let hour = 8; hour < 24; hour++) {
    const v: HourView = { owner: OWNER, character: { archetype: "mastermind", strategyStyle: "social", secretKinds: [] }, agenda, habits: [], emotional: 0.5, room: "living-room",
      whereabouts: where, affinity: new Map(everyone.map((id) => [id, 0.5])), threat: new Map(), mates: [], hoh: HOH, nominees: [TARGET, OTHER_NOM],
      timeOfDay: hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night", day: 4, hour, inCompetition: false, candor: 0.2 };
    const plan = chooseHourAction(v, 31);
    const action = speechActionOf(plan.kind);
    const partner = plan.with[0];
    if (!action || !partner) continue;
    const said = planSpeech(action, OWNER, partner, plan.about, plan.truthful, { living: everyone, beliefs: {}, facts, roll: (hour * 0.137) % 1 });
    if (said) b.listeners.push(said.listener);
  }
  assert.ok(b.listeners.length > 0, "a day of campaigning told no one anything");
});

Then("the people they lie to are voters this week, never the nominees or the HOH", function () {
  const b = bag(this);
  for (const l of b.listeners!) assert.ok(b.voters!.includes(l), `a campaign lie went to ${l}, who is not a voter`);
});

// ---- leaking: only what you hold ----

When("a houseguest who believes nothing about a houseguest leaks about them", function () {
  const b = bag(this);
  delete live(b.s!).beliefs?.[b.planter!];
  b.told = seam(b.s!).sayInHouseLife({ kind: "leak", actor: b.planter!, about: b.rival!, truthful: true }, b.ear!, "bdd-leak");
});

Then("nothing is told as true", function () {
  assert.equal(bag(this).told, undefined, "a houseguest leaked something they never believed");
});

Then("a houseguest who does hold a belief can pass it on, as what they believe", function () {
  const b = bag(this);
  // the planter comes to believe the rival is going after them (told by the listener, who lies), then leaks it to a third houseguest
  const third = b.s!.livingIds().filter((id) => id !== PLAYER && ![b.planter, b.rival, b.ear].includes(id))[0]!;
  b.s!.tellClaim({ speaker: b.ear!, listener: b.planter!, kind: "targets-you", subject: b.rival!, isTrue: false, intent: "mislead" });
  const leaked = seam(b.s!).sayInHouseLife({ kind: "leak", actor: b.planter!, about: b.rival!, truthful: true }, third, "bdd-leak2");
  assert.ok(leaked, "a held belief was not passed on");
  assert.equal(leaked.kind, "going-after");
  assert.equal(leaked.subject, b.rival);
  assert.equal(leaked.object, b.planter);
  assert.equal(leaked.isTrue, truthOf(leaked, seam(b.s!).truthFacts()), "the leak's truth is not the engine's");
  assert.equal(leaked.isTrue, false, "the belief passed on was false, so the leak is false too (the leaker cannot know)");
});
