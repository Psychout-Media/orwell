import { meetingNothingAboutIt } from "./house_meetings_player.steps";
import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { certaintyBand, presentedBand, presentedConfidence, tellChance, toPlayerKey, TO_PLAYER } from "../../src/engine/claimsToPlayer";
import { claimConfidence, type ClaimLog } from "../../src/engine/spokenClaims";

/**
 * Feature 0151 - what the player hears (theme 2 slice 4a, ORW-330). Drives the REAL adapter through a per-user registry sandbox. TEST-ONLY seams: the live season (to plant a belief, read the engine-only claims),
 * the relationship model (the holder's trust in the player), the presence map (who is in the room) and the agendas (the engine's own truth for a "going after" belief). Roles only.
 * Shares "Given a started season with claims on" with 0149.
 */
type Told = { kind: string; subject: string; object?: string; certainty: string };
type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; npcs?: string[]; told?: Told[]; seen?: string[]; prompts?: string[]; mix?: { on: string; off: string } };
const bag = (w: unknown): Bag => ((w as { hear0151?: Bag }).hear0151 ??= {});
const sessOf = (w: unknown) => (bag(w).s ?? (w as { claims0149?: { s?: GameSessionAdapter } }).claims0149!.s)!;
type Live = { week: number; dayNumber?: number; claims?: ClaimLog; beliefs?: Record<string, BeliefClaim[]>; agendas?: Record<string, { goals: Array<Record<string, unknown>> }> };
const live = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const rel = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { trust: number } } }).rel;
const presence = (s: GameSessionAdapter) => (s as unknown as { presence: Map<string, string> }).presence;
let n = 0;

function fresh(w: unknown, seed = 7): void {
  const sb = new GameSessionRegistry().sandboxFor(`hear0151-${n++}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const b = bag(w);
  b.sb = sb; b.s = sb.session; b.npcs = sb.session.livingIds().filter((id) => id !== PLAYER); b.told = []; b.seen = []; b.prompts = [];
}
/** Make sure the "claims on" sandbox of 0149 is the one this feature drives. */
function adopt(w: unknown): void {
  const c = (w as { claims0149?: { sb?: UserSandbox; s?: GameSessionAdapter; npcs?: string[] } }).claims0149!;
  const b = bag(w);
  b.sb = c.sb; b.s = c.s; b.npcs = c.npcs; b.told = []; b.seen = []; b.prompts = [];
}

interface Setup { trust: number; crowd: number; goingAfterIsReal: boolean; turns: number }
/** Plays `turns` player turns with ONE houseguest who holds a belief that a second is going after them; re-seats the room each turn (the calm tick moves people). */
function play(w: unknown, o: Setup): void {
  const b = bag(w);
  const s = b.s!;
  const [holder, subject, third, ...rest] = b.npcs!;
  for (let i = 0; i < o.turns; i++) {
    s.noteMessage({ messageId: `hear0151-${n}-${i}` });
    const here = presence(s).get(PLAYER)!;
    presence(s).set(holder!, here);
    rest.concat(subject!, third!).forEach((id, k) => presence(s).set(id, k < o.crowd ? here : "storage-room"));
    rel(s).edge(holder!, PLAYER).trust = o.trust;
    const l = live(s);
    (l.beliefs ??= {})[holder!] = [{ id: `${holder}|targets-me|${subject}|seed`, holder: holder!, kind: "targets-me", subject: subject!, object: holder!, value: true, origin: "told", source: third!, confidence: 0.8, week: l.week }];
    const goals = l.agendas?.[subject!]?.goals;
    if (goals) {
      const real = o.goingAfterIsReal;
      for (let g = goals.length - 1; g >= 0; g--) if (goals[g]!.kind === "get-them-out" && goals[g]!.target === holder) goals.splice(g, 1);
      if (real) goals.push({ id: "g-seed", owner: subject, horizon: "week", kind: "get-them-out", target: holder, why: [], test: { kind: "evicted", who: holder }, commitment: 0.9, status: "active", formedDay: 1, formedWeek: l.week });
    }
    const view = s.getMomentPrompt({}) as unknown as Record<string, unknown>;
    b.prompts!.push(JSON.stringify(view));
    const pk = (s as unknown as { presentKnowledgeForPrompt(): Array<{ id: string; tellsYou?: Told }> }).presentKnowledgeForPrompt();
    for (const e of pk) if (e.tellsYou) b.told!.push(e.tellsYou);
    const heard = (l.claims?.items ?? []).filter((c) => c.speaker === holder && c.listener === PLAYER);
    b.seen = heard.map((c) => c.id);
  }
}
const toldClaims = (w: unknown) => (live(sessOf(w)).claims?.items ?? []).filter((c) => c.listener === PLAYER);
const SETUP: Setup = { trust: 0.95, crowd: 0, goingAfterIsReal: true, turns: 240 };

// ---- Scenario 1: shared with someone they trust, hedged ----

Given("an NPC believes a second NPC is targeting them, and trusts the player", function () { /* the shared "claims on" season is the setup */ adopt(this); });
When("the player and the NPC are in a scene together", function () { play(this, SETUP); });
Then("the engine can have the NPC tell the player so, once", function () {
  const claims = toldClaims(this);
  assert.ok(claims.length >= 1, "a trusted houseguest never confided in 240 turns");
  const days = new Set<string>();
  const kinds = new Set<string>();
  for (const c of claims) {
    const day = `${c.week}:${c.day ?? 0}`;
    assert.ok(!days.has(day), "told the player twice in one day");
    days.add(day);
    const key = toPlayerKey(c.kind, c.subject, c.object);
    assert.ok(!kinds.has(key), "told the player the same belief twice");
    kinds.add(key);
    assert.equal(c.kind, "going-after");
    assert.equal(c.isTrue, true);
  }
  assert.equal(claims.length, 1, "one belief held, so it is told once and never again");
});
Then("the narrator is handed that claim to voice with the NPC's own level of certainty", function () {
  const b = bag(this);
  assert.ok(b.told!.length >= 1);
  const t = b.told![0]!;
  assert.equal(t.kind, "going-after");
  assert.equal(t.certainty, certaintyBand(0.8));
  assert.ok(b.prompts!.some((p) => p.includes("tellsYou")), "the prompt never carried the claim");
});
Then("the narrator is never told whether it is true or why the NPC is telling", function () {
  const b = bag(this);
  const allowed = new Set(["kind", "subject", "object", "certainty"]);
  for (const t of b.told!) for (const k of Object.keys(t)) assert.ok(allowed.has(k), `the field carries ${k}`);
  const text = b.prompts!.join("\n");
  const lines = text.match(/tellsYou \([^"]*?(?=\\n)/g) ?? [];
  assert.ok(lines.length >= 1, "no tellsYou line in the rendered prompt");
  for (const ln of lines) for (const bad of ["isTrue", "intent", "claim:", "untrue", "false", "lie", "inform", "mislead"]) assert.ok(!ln.includes(bad), `the narrator line carries ${bad}: ${ln}`);
  for (const bad of ["isTrue", "claim:"]) assert.ok(!text.includes(bad), `the narrator view carries ${bad}`);
});

// ---- Scenario 2: a wrong belief ----

Given("an NPC wrongly believes a second NPC is going after them, and trusts the player", function () { fresh(this); });
When("they are in a scene together", function () { play(this, { ...SETUP, goingAfterIsReal: false }); });
Then("the NPC can tell the player, and the claim is recorded as untrue", function () {
  const claims = toldClaims(this);
  assert.ok(claims.length >= 1, "the wrong belief was never told");
  assert.ok(claims.every((c) => c.isTrue === false), "the engine did not record the claim as untrue");
});
Then("nothing the narrator is handed says it is untrue", function () {
  const b = bag(this);
  assert.ok(b.told!.length >= 1);
  const text = b.prompts!.join("\n");
  const lines = text.match(/tellsYou \([^"]*?(?=\\n)/g) ?? [];
  for (const ln of lines) for (const bad of ["untrue", "false", "wrong", "lie", "mistaken"]) assert.ok(!ln.toLowerCase().includes(bad), `the narrator line carries ${bad}`);
  assert.deepEqual(Object.keys(b.told![0]!).sort(), ["certainty", "kind", "object", "subject"]);
});

// ---- Scenario 3: not in front of a crowd, not without trust ----

Given("an NPC holds a belief about a second NPC", function () { fresh(this); });
When("the NPC's trust in the player is low, or many others are in earshot", function () {
  const b = bag(this);
  for (const [i, o] of [{ ...SETUP, trust: 0.2, turns: 80 }, { ...SETUP, crowd: TO_PLAYER.crowdMax + 1, turns: 80 }, { ...SETUP, trust: TO_PLAYER.trustGate - 0.05, turns: 80 }].entries()) {
    fresh(this, 3 + i);
    play(this, o);
    assert.equal(toldClaims(this).length, 0, `told the player under case ${i}`);
    assert.equal(b.told!.length, 0);
  }
});
Then("the NPC does not tell the player, across seeds", function () {
  // the gates themselves, without sampling: trust below the gate and a crowd give a zero chance; a trusted private scene does not.
  assert.equal(tellChance({ trustInPlayer: 0.2, audience: 0, candor: 1 }), 0);
  assert.equal(tellChance({ trustInPlayer: 1, audience: TO_PLAYER.crowdMax + 1, candor: 1 }), 0);
  assert.ok(tellChance({ trustInPlayer: 0.9, audience: 0, candor: 0.5 }) > 0);
  assert.ok(tellChance({ trustInPlayer: 0.9, audience: 2, candor: 0.5 }) < tellChance({ trustInPlayer: 0.9, audience: 0, candor: 0.5 }));
});

// ---- Scenario 4: a claim the player did not hear ----

Given("an NPC tells a third NPC a claim while the player is elsewhere", function () {
  fresh(this);
  const b = bag(this);
  const [speaker, listener, subject] = b.npcs!;
  const told = b.s!.tellClaim({ speaker: speaker!, listener: listener!, kind: "going-after", subject: subject!, object: listener!, isTrue: false, intent: "mislead" });
  assert.ok(told);
  b.s!.noteMessage({ messageId: `hear0151-${n}-elsewhere` });
});
Then("the narrator is handed nothing about it", function () {
  if ((this as { meetings0156p?: { s?: unknown } }).meetings0156p?.s) return meetingNothingAboutIt(this); // 0156 scenario 6 shares this wording
  const s = bag(this).s!;
  assert.equal(s.claimsThePlayerHeard().length, 0);
  const view = JSON.stringify(s.getMomentPrompt({}));
  assert.ok(!view.includes("tellsYou"), "an unheard claim reached the narrator");
});

// ---- Scenario: a lie carries the same kind of band ----

When("the engine presents certainty for a claim the speaker does not hold, across seeds", function () { adopt(this); });
Then("the bands it presents are spread like the bands of claims the speaker does hold", function () {
  const N = 2000;
  const rng = new SeededRandom(11);
  const lie: Record<string, number> = { sure: 0, "fairly-sure": 0, "not-sure": 0 };
  const held: Record<string, number> = { sure: 0, "fairly-sure": 0, "not-sure": 0 };
  for (let i = 0; i < N; i++) {
    lie[presentedBand(undefined, rng.next())]!++;
    held[presentedBand(claimConfidence(rng.next(), false), 0)]!++; // a held belief: the confidence the engine writes for a listener of uniform trust
  }
  for (const band of Object.keys(lie)) assert.ok(Math.abs(lie[band]! - held[band]!) / N < 0.08, `${band}: ${lie[band]} presented vs ${held[band]} held`);
  assert.ok(Object.values(lie).every((c) => c > N * 0.1), "a presented band never varies");
});
Then("the certainty band function never takes whether the claim is true", function () {
  assert.equal(certaintyBand.length, 1);
  assert.equal(presentedBand.length, 2);
  assert.equal(presentedConfidence.length, 2);
  const src = readFileSync(join(process.cwd(), "src/engine/claimsToPlayer.ts"), "utf8");
  for (const bad of ["isTrue", "intent"]) assert.ok(!src.includes(bad), `claimsToPlayer.ts mentions ${bad}`);
});
Then("a claim told as untrue reaches the narrator with only its kind, names and certainty band", function () {
  fresh(this);
  play(this, { ...SETUP, goingAfterIsReal: false });
  const b = bag(this);
  assert.ok(toldClaims(this).some((c) => !c.isTrue), "no untrue claim was told");
  assert.ok(b.told!.length >= 1);
  for (const t of b.told!) assert.deepEqual(Object.keys(t).sort(), ["certainty", "kind", "object", "subject"]);
});

// ---- Scenario: the mix and late guards ----

When("seeded seasons play with houseguests sharing beliefs with the player", function () {
  // The strongest calibration claim: the feature moves NO outcome. The same seeded game, played the same way, ends in the same place with it on and off (own side stream, no shared rng, player gets no belief).
  const run = (on: boolean): string => {
    fresh(this, 5);
    const s = bag(this).s!;
    s.setClaimsToPlayerEnabled(on);
    const [holder, subject] = bag(this).npcs!;
    const trace: number[] = [];
    for (let i = 0; i < 150; i++) {
      s.noteMessage({ messageId: `hear0151-mix-${n}-${i}` });
      rel(s).edge(holder!, PLAYER).trust = 0.95;
      (live(s).beliefs ??= {})[holder!] = [{ id: "b", holder: holder!, kind: "targets-me", subject: subject!, object: holder!, value: true, origin: "told", confidence: 0.8, week: live(s).week }];
      s.getMomentPrompt({});
      trace.push(rel(s).edge(holder!, PLAYER).trust);
      if (i % 12 === 11) s.advanceGame();
    }
    const l = live(s) as unknown as { week: number; evictionOrder: string[] };
    return JSON.stringify({ trace, week: l.week, out: l.evictionOrder, trust: Object.fromEntries(bag(this).npcs!.map((id) => [id, rel(s).edge(id, PLAYER).trust])) });
  };
  bag(this).mix = { on: run(true), off: run(false) };
});
Then("the week-one house mix stays within the agreed reference", function () {
  assert.equal(bag(this).mix!.on, bag(this).mix!.off, "sharing beliefs moved the seeded game");
});
Then("the late-game guard stays green", function () {
  // The 0149/0151 side stream draws nothing from the shared rng; the seeded guards (tests/unit/houseMixGuard.test.ts, tests/property/houseMixLate.property.test.ts) run in the gate.
  assert.equal(bag(this).mix!.on, bag(this).mix!.off);
});
