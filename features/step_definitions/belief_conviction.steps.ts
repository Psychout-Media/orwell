import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { CONVICTION, testRef } from "../../src/engine/beliefConviction";
import { REASONS } from "../../src/engine/agendaConstants";
import type { Agenda, Goal } from "../../src/engine/agenda";
import { DEAL_NOMS } from "../../src/engine/dealNomConstants";

/**
 * Feature 0160 - conviction (Ryne's ruling on Theme 2 question 2). Drives the REAL adapter through a registry sandbox: credulity comes from
 * the houseguests' own sheets, the decision weight from the live nomination read, the testing from the agenda recheck (find-out goals) and
 * the nightly evidence from the adapter's overnight agenda mull. TEST-ONLY seams: the live season (beliefs, agendas, day), the relationship model,
 * and the adapter's private reads named below. Roles only.
 */
type Live = { playedGame?: boolean; beliefs?: BeliefStore; agendas?: Record<string, Agenda>; week: number; dayNumber?: number };
type Seam = {
  live: Live;
  rel: { edge(a: string, b: string): { trust: number } };
  credulityOf(id: string): number;
  beliefNomTiltFor(subject: string, holder: string): number;
  agendaRecheck(t: string, only: string[]): void;
  mullAgendasOvernight(): void;
};
type Bag = { s?: GameSessionAdapter; trusting?: string; suspicious?: string; teller?: string; subject?: string; holder?: string; other?: string };
const bag = (w: unknown): Bag => ((w as { conv0160?: Bag }).conv0160 ??= {});
const seam = (s: GameSessionAdapter) => s as unknown as Seam;
let n = 0;

function played(w: unknown): GameSessionAdapter {
  const sb = new GameSessionRegistry().sandboxFor(`conv0160-${n++}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 12 });
  seam(sb.session).live.playedGame = true;
  bag(w).s = sb.session;
  return sb.session;
}
const npcs = (s: GameSessionAdapter) => s.livingIds().filter((id) => id !== PLAYER);

Given("a played season with a trusting houseguest and a suspicious houseguest", function () {
  const s = played(this);
  const byCred = [...npcs(s)].sort((a, b) => seam(s).credulityOf(b) - seam(s).credulityOf(a) || a.localeCompare(b));
  const b = bag(this);
  b.trusting = byCred[0]; b.suspicious = byCred[byCred.length - 1];
  [b.teller, b.subject] = byCred.slice(1, 3);
  assert.ok(seam(s).credulityOf(b.trusting!) > seam(s).credulityOf(b.suspicious!), "the house has no spread of credulity");
});

When("the same teller tells each of them the same thing", function () {
  const b = bag(this); const s = b.s!;
  for (const l of [b.trusting!, b.suspicious!]) {
    seam(s).rel.edge(l, b.teller!).trust = 0.6; // the same trust in the teller: only the listener differs
    s.tellClaim({ speaker: b.teller!, listener: l, kind: "targets-you", subject: b.subject!, isTrue: false, intent: "mislead" });
  }
});

Then("the trusting houseguest holds it with more conviction than the suspicious one", function () {
  const b = bag(this); const live = seam(b.s!).live;
  const conv = (h: string) => (live.beliefs?.[h] ?? []).find((c) => c.kind === "targets-me" && c.subject === b.subject)!.confidence;
  assert.ok(conv(b.trusting!) > conv(b.suspicious!), `trusting ${conv(b.trusting!)} vs suspicious ${conv(b.suspicious!)}`);
});

Given("a houseguest who holds a grievance with high conviction", function () {
  const s = played(this); const b = bag(this);
  [b.holder, b.subject] = npcs(s);
  const live = seam(s).live;
  recordClaim((live.beliefs ??= {}), { holder: b.holder!, kind: "voted-against-me", subject: b.subject!, value: true, origin: "deduced", confidence: 0.75, week: live.week });
});

Then("it counts in their decisions at full weight, as a fact would", function () {
  const b = bag(this);
  assert.equal(seam(b.s!).beliefNomTiltFor(b.subject!, b.holder!), REASONS.goalWeight * 1); // 0.75 conviction, acted on as 1
});

Given("a houseguest who doubts something they were told that is false", function () {
  const s = played(this); const b = bag(this);
  [b.holder, b.subject, b.other] = npcs(s);
  const live = seam(s).live;
  const store = (live.beliefs ??= {});
  // doubted (0.45) and false: the subject holds no goal against the holder
  recordClaim(store, { id: "doubt-false", holder: b.holder!, kind: "targets-me", subject: b.subject!, object: b.holder!, value: true, origin: "told", source: b.other!, confidence: 0.45, week: live.week });
  // doubted, and CONFIRMED by a second source (ORW-585: evidence is what they hear through pathways, never the hidden truth)
  recordClaim(store, { id: "doubt-true", holder: b.holder!, kind: "targets-me", subject: b.other!, object: b.holder!, value: true, origin: "told", source: b.subject!, confidence: 0.45, week: live.week });
  const third = npcs(s).find((id) => ![b.holder, b.subject, b.other].includes(id))!;
  recordClaim(store, { id: "doubt-true-2", holder: b.holder!, kind: "targets-me", subject: b.other!, object: b.holder!, value: true, origin: "told", source: third, confidence: 0.4, week: live.week });
  seam(s).agendaRecheck("week-start", [b.holder!, b.other!]); // seeds the agendas
  const goal: Goal = { id: `${b.other}:get-them-out:${b.holder}`, owner: b.other!, horizon: "week", kind: "get-them-out", target: b.holder!, why: [{ kind: "character", weight: 1 }],
    test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: 1 };
  live.agendas![b.other!]!.goals.push(goal);
  seam(s).agendaRecheck("week-start", [b.holder!]);
});

Then("they take up a goal to find out, asking around", function () {
  const b = bag(this);
  const live = seam(b.s!).live;
  const doubt = (live.beliefs?.[b.holder!] ?? []).find((c) => c.id === "doubt-false")!;
  assert.ok(doubt.confidence < CONVICTION.asFact && !doubt.refuted, "the doubted belief is not under test");
  const goals = live.agendas![b.holder!]!.goals.filter((g) => g.kind === "find-out" && g.status === "active" && (g.test as { ref?: string }).ref === testRef({ id: "doubt-false" }));
  assert.equal(goals.length > 0, CONVICTION.askAround, "visible testing (a find-out goal) must follow CONVICTION.askAround");
});

const nights = (s: GameSessionAdapter, count: number) => {
  const live = seam(s).live;
  for (let i = 0; i < count; i++) { live.dayNumber = (live.dayNumber ?? 1) + 1; seam(s).mullAgendasOvernight(); } // the real nightly step
};
const belief = (w: unknown, id: string) => (seam(bag(w).s!).live.beliefs?.[bag(w).holder!] ?? []).find((c) => c.id === id)!;

Then("as the nights pass their conviction falls, until they stop believing it", function () {
  nights(bag(this).s!, 16);
  const b = belief(this, "doubt-false");
  assert.ok(b.refuted === true || b.confidence < CONVICTION.dropBelow, `a false doubted belief was not let go (conviction ${b.confidence})`);
});

Then("a doubted belief that a second source confirms grows into a conviction instead", function () {
  const b = belief(this, "doubt-true");
  assert.ok(!b.refuted && b.confidence >= CONVICTION.asFact, `a true doubted belief did not grow into a conviction (${b.confidence})`);
});

// ---- a low-trust deal ----
type DealSeam = { deals: { make: (...a: unknown[]) => unknown }; dealNomPushFor(target: string, holder: string): number };
Given("an HOH who promised two houseguests safety, one they trust and one they do not", function () {
  const s = played(this); const b = bag(this);
  [b.holder, b.subject, b.other] = npcs(s);
  const live = seam(s).live;
  for (const [t, trust] of [[b.subject!, 0.8], [b.other!, 0.1]] as const) {
    seam(s).rel.edge(b.holder!, t).trust = trust;
    (s as unknown as DealSeam).deals.make([b.holder!, t], "safety", "you are safe with me", undefined, live.week);
  }
});
Then("the promise to the trusted houseguest protects them fully", function () {
  const b = bag(this);
  assert.equal((b.s! as unknown as DealSeam).dealNomPushFor(b.subject!, b.holder!), DEAL_NOMS.protectivePush);
});
Then("the promise to the distrusted houseguest protects them less", function () {
  const b = bag(this);
  const weak = (b.s! as unknown as DealSeam).dealNomPushFor(b.other!, b.holder!);
  assert.ok(weak < 0 && weak > DEAL_NOMS.protectivePush, `a distrusted deal pushed ${weak}`);
});
