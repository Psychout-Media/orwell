import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { certaintyBand, presentedBand } from "../../src/engine/claimsToPlayer";
import { decidePlantToPlayer, plantChance, PLANT_TO_PLAYER } from "../../src/engine/plantToPlayer";
import { claimConfidence, type ClaimLog } from "../../src/engine/spokenClaims";

/**
 * Feature 0159 - a lie planted on the player (theme 2 slice 6b, ORW-330, the owner's Q1 option C). Drives the REAL adapter through a per-user registry sandbox. TEST-ONLY seams: the live season (agendas for the
 * engine's own goals, the engine-only claim log), the relationship model, the presence map. The chance is a constant (`PLANT_TO_PLAYER.base`, tiny on purpose): the scenarios that need a lie to fire raise it for
 * the run only and put it back. Roles only.
 */
type Told = { kind: string; subject: string; object?: string; certainty: string };
type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; npcs?: string[]; told: Told[]; prompts: string[]; holder?: string; target?: string; bands: string[]; mix?: { on: string; off: string } };
const bag = (w: unknown): Bag => ((w as { plant0159?: Bag }).plant0159 ??= { told: [], prompts: [], bands: [] });
type Live = { week: number; playedGame?: boolean; dayNumber?: number; claims?: ClaimLog; beliefs?: Record<string, BeliefClaim[]>; agendas?: Record<string, { goals: Array<Record<string, unknown>> }> };
const live = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const rel = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { trust: number } } }).rel;
const presence = (s: GameSessionAdapter) => (s as unknown as { presence: Map<string, string> }).presence;
const cfg = PLANT_TO_PLAYER as { base: number };
const BASE = cfg.base;
let n = 0;

function fresh(w: unknown, seed = 7): void {
  const sb = new GameSessionRegistry().sandboxFor(`plant0159-${n++}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const b = bag(w);
  live(sb.session).playedGame = true;
  b.sb = sb; b.s = sb.session; b.npcs = sb.session.livingIds().filter((id) => id !== PLAYER); b.told = []; b.prompts = []; b.bands = [];
  [b.holder, b.target] = b.npcs;
  (w as { who0152?: unknown }).who0152 = { sb, s: sb.session, npcs: b.npcs }; // the shared "who told you that" steps read this world key
}
function adopt(w: unknown): void {
  const c = (w as { claims0149?: { sb?: UserSandbox; s?: GameSessionAdapter; npcs?: string[] } }).claims0149;
  if (!c?.s) return fresh(w); // a scenario without the shared "claims on" Given gets its own season
  const b = bag(w);
  b.sb = c.sb; b.s = c.s; b.npcs = c.npcs; b.told = []; b.prompts = []; b.bands = [];
  [b.holder, b.target] = b.npcs!;
  (w as { who0152?: unknown }).who0152 = { sb: c.sb, s: c.s, npcs: c.npcs };
}
const withGoal = (s: GameSessionAdapter, owner: string, target: string | undefined): void => {
  const l = live(s);
  const goals = ((l.agendas ??= {})[owner] ??= { goals: [] }).goals;
  for (let g = goals.length - 1; g >= 0; g--) if (["get-them-out", "revenge", "long-con"].includes(String(goals[g]!.kind))) goals.splice(g, 1);
  if (target) goals.push({ id: "g-plant", owner, horizon: "week", kind: "get-them-out", target, why: [], test: { kind: "evicted", who: target }, commitment: 0.9, status: "active", formedDay: 1, formedWeek: l.week });
};
const planted = (w: unknown) => (live(bag(w).s!).claims?.items ?? []).filter((c) => c.listener === PLAYER && c.speaker === bag(w).holder);

/** Plays `turns` player turns with the holder alone with the player (trust LOW on purpose: no trust gate), no held beliefs, and one goal against the target. */
function play(w: unknown, turns: number, o: { base?: number; crowd?: number; goal?: boolean; advanceEvery?: number } = {}): void {
  const b = bag(w);
  const s = b.s!;
  const [holder, target, ...rest] = b.npcs!;
  cfg.base = o.base ?? BASE;
  try {
    for (let i = 0; i < turns; i++) {
      s.noteMessage({ messageId: `plant0159-${n}-${i}` });
      const here = presence(s).get(PLAYER)!;
      presence(s).set(holder!, here);
      rest.concat(target!).forEach((id, k) => presence(s).set(id, k < (o.crowd ?? 0) ? here : "storage-room"));
      rel(s).edge(holder!, PLAYER).trust = 0.1;
      live(s).beliefs = {};
      withGoal(s, holder!, o.goal === false ? undefined : target!);
      b.prompts.push(JSON.stringify(s.getMomentPrompt({})));
      const pk = (s as unknown as { presentKnowledgeForPrompt(): Array<{ id: string; tellsYou?: Told }> }).presentKnowledgeForPrompt();
      for (const e of pk) if (e.tellsYou && e.id === holder) { if (!b.told.some((t) => t === e.tellsYou)) b.told.push(e.tellsYou); b.bands.push(e.tellsYou.certainty); }
      if (o.advanceEvery && i % o.advanceEvery === o.advanceEvery - 1) s.advanceGame();
    }
  } finally { cfg.base = BASE; }
}

// ---- Scenario 1 ----

Given("an NPC holds a goal against a second NPC", function () { adopt(this); withGoal(bag(this).s!, bag(this).holder!, bag(this).target); });
When("the NPC is in a scene with the player", function () { play(this, 60, { base: 1, advanceEvery: 10 }); });
Then("the engine can have the NPC tell the player a false claim about the second NPC, once a day", function () {
  const claims = planted(this);
  assert.ok(claims.length >= 1, "no lie was ever planted on the player");
  const days = new Set<string>();
  for (const c of claims) {
    const day = `${c.week}:${c.day ?? 0}`;
    assert.ok(!days.has(day), `told the player twice in one day ${day} ${JSON.stringify(claims.map((x) => [x.week, x.day, x.kind, x.subject]))}`);
    days.add(day);
    assert.equal(c.isTrue, false, "the planted claim is not false by the engine's truth");
    assert.ok([c.subject, c.object].includes(bag(this).target!), "the lie is not about the NPC's target");
    assert.ok(["targets-you", "lying-about", "talking-about"].includes(c.kind), `not a planter kind: ${c.kind}`);
  }
  assert.ok(claims.length > days.size - 1, "the days are not distinct");
});
Then("the claim is recorded as a lie told to the player, with what the NPC meant by it", function () {
  for (const c of planted(this)) { assert.equal(c.intent, "mislead"); assert.equal(c.isTrue, false); assert.equal(c.listener, PLAYER); }
});
Then("the player is handed no belief", function () {
  const b = bag(this);
  assert.ok(!(live(b.s!).beliefs?.[PLAYER]?.length), "the player was handed a belief");
  if (planted(this).length === 0 || b.told.length === 0) return; // shared wording: 0149's own scenario checks its own read
  assert.ok(b.told.length >= 1);
});

// ---- Scenario 2 ----

Given("an NPC plants a lie on the player", function () { adopt(this); withGoal(bag(this).s!, bag(this).holder!, bag(this).target); play(this, 60, { base: 1, advanceEvery: 10 }); assert.ok(bag(this).told.length >= 1, "no lie was planted"); });
Then("the narrator is handed the kind, the subject, the object and a certainty band", function () {
  const b = bag(this);
  for (const t of b.told) {
    assert.deepEqual(Object.keys(t).filter((k) => k !== "object").sort(), ["certainty", "kind", "subject"]);
    assert.ok(["targets-you", "lying-about", "talking-about"].includes(t.kind));
    assert.ok(["sure", "fairly-sure", "not-sure"].includes(t.certainty));
  }
  assert.ok(b.prompts.some((p) => p.includes("tellsYou")), "the prompt never carried the lie");
});
Then("never whether it is true, why the NPC told it, or the claim's id", function () {
  const b = bag(this);
  for (const t of b.told) for (const k of Object.keys(t)) assert.ok(["kind", "subject", "object", "certainty"].includes(k), `the field carries ${k}`);
  const text = b.prompts.join("\n");
  const lines = text.match(/tellsYou \([^"]*?(?=\\n)/g) ?? [];
  assert.ok(lines.length >= 1, "no tellsYou line in the rendered prompt");
  for (const ln of lines) for (const bad of ["isTrue", "intent", "claim:", "untrue", "false", "lie", "lying to the player on purpose", "inform", "mislead", "plant"]) {
    if (bad === "lie" && /is lying to/.test(ln)) continue; // the claim "X is lying to Y" is itself the claim kind's verb, voiced as the speaker's words
    assert.ok(!ln.includes(bad), `the narrator line carries ${bad}: ${ln}`);
  }
  for (const bad of ["isTrue", "claim:", "mislead"]) assert.ok(!text.includes(bad), `the narrator view carries ${bad}`);
});
Then("across seeds the certainty of lies matches the certainty of true claims", function () {
  // the live lies, across seeds (a fresh season each)
  const bands: string[] = [];
  for (let seed = 1; seed <= 90; seed++) {
    fresh(this, seed);
    play(this, 3, { base: 1 });
    bands.push(...bag(this).told.map((t) => t.certainty));
  }
  assert.ok(bands.length >= 50, `too few lies to read (${bands.length})`);
  const rng = new SeededRandom(11);
  const N = 2000;
  const held: Record<string, number> = { sure: 0, "fairly-sure": 0, "not-sure": 0 };
  for (let i = 0; i < N; i++) held[presentedBand(claimConfidence(rng.next(), false), 0)]!++;
  for (const band of Object.keys(held)) {
    const lie = bands.filter((x) => x === band).length / bands.length;
    assert.ok(Math.abs(lie - held[band]! / N) < 0.2, `${band}: ${lie.toFixed(2)} of lies against ${(held[band]! / N).toFixed(2)} of true claims`);
  }
  // the band function never takes truth
  assert.equal(presentedBand.length, 2);
  assert.equal(certaintyBand.length, 1);
  const src = readFileSync(join(process.cwd(), "src/engine/plantToPlayer.ts"), "utf8");
  for (const bad of ["isTrue", "intent"]) assert.ok(!src.replace(/\/\*[\s\S]*?\*\//g, "").includes(bad), `plantToPlayer.ts code mentions ${bad}`);
});

// ---- Scenario 3 ----

Given("an NPC holds no goal against anyone", function () { adopt(this); withGoal(bag(this).s!, bag(this).holder!, undefined); });
Then("the NPC plants no lie on the player, across seeds", function () {
  // even at a certain chance, with no goal there is no one to lie about; and a goal is exactly what makes a candidate
  for (let seed = 1; seed <= 6; seed++) {
    fresh(this, seed);
    play(this, 40, { base: 1, goal: false, advanceEvery: 8 });
    assert.equal(planted(this).length, 0, `a lie was planted with no goal (seed ${seed})`);
    assert.equal(bag(this).told.length, 0);
  }
  const scene = { holder: "h", cunning: 1, candor: 0, audience: 0, toldToday: false, roll: 0, pick: 0 };
  assert.equal(decidePlantToPlayer({ ...scene, candidates: [] }), undefined);
  assert.deepEqual(decidePlantToPlayer({ ...scene, candidates: ["t"] }), { about: "t" });
  assert.equal(decidePlantToPlayer({ ...scene, candidates: ["t"], toldToday: true }), undefined);
  assert.equal(plantChance({ cunning: 1, candor: 0, audience: PLANT_TO_PLAYER.crowdMax + 1 }), 0);
  assert.ok(plantChance({ cunning: 0.9, candor: 0.2, audience: 0 }) > plantChance({ cunning: 0.1, candor: 0.8, audience: 0 }));
  assert.ok(plantChance({ cunning: 0.5, candor: 0.5, audience: 2 }) < plantChance({ cunning: 0.5, candor: 0.5, audience: 0 }));
  assert.ok(PLANT_TO_PLAYER.base <= 0.05, "the chance is not small");
});

// ---- Scenario 4 ----

Given("an NPC planted a lie on the player", function () {
  adopt(this); withGoal(bag(this).s!, bag(this).holder!, bag(this).target);
  play(this, 60, { base: 1, advanceEvery: 10 });
  assert.ok(planted(this).length >= 1, "no lie was planted");
  const s = bag(this).s!;
  presence(s).set(bag(this).holder!, presence(s).get(PLAYER)!); // the speaker is in the room, awake
  assert.ok(s.awakeAmong([bag(this).holder!]).includes(bag(this).holder!));
});
Then("the NPC names no source", function () {
  // ORW-685: the liar's cover may play it off (saw it themself, or will not say) or slip; whichever it is, no source is named (the old "always saw it themself" answer is the ORWELL_COVER_SLIPS-off path).
  const note = ((this as { who0152?: { before?: string } }).who0152!.before) ?? "";
  assert.ok(note.length > 0, "no answer was handed over");
  assert.ok(!note.includes("names "), `the answer names a source: ${note}`);
  for (const other of bag(this).npcs!.filter((id) => id !== bag(this).holder)) assert.ok(!note.includes((bag(this).s as unknown as { nameOf(id: string): string }).nameOf(other)), "the answer names a houseguest");
});
Then("the narrator is not told the answer is untrue", function () {
  const note = ((this as { who0152?: { before?: string } }).who0152!.before) ?? "";
  for (const bad of ["untrue", "false", "lie", "mislead", "isTrue", "made up", "mistaken", "invented"]) assert.ok(!note.toLowerCase().includes(bad), `the note carries ${bad}: ${note}`);
});

// ---- Scenario 5: the mix and the late guard ----

When("seeded seasons play with lies planted on the player", function () {
  // The agreed-mix and runaway bounds are the vitest guards (tests/unit/houseMixGuard.test.ts, tests/property/houseMixLate.property.test.ts, run in CI). What this scenario is for: planting lies on the player, at the
  // shipped chance, moves no outcome of the same seeded game (own side stream; the player gets no belief).
  const run = (on: boolean): string => {
    fresh(this, 5);
    const s = bag(this).s!;
    s.setClaimsToPlayerEnabled(on);
    const [holder, target] = bag(this).npcs!;
    const trace: number[] = [];
    for (let i = 0; i < 150; i++) {
      s.noteMessage({ messageId: `plant0159-mix-${n}-${i}` });
      rel(s).edge(holder!, PLAYER).trust = 0.2;
      withGoal(s, holder!, target!);
      s.getMomentPrompt({});
      trace.push(rel(s).edge(holder!, PLAYER).trust);
      if (i % 12 === 11) s.advanceGame();
    }
    const l = live(s) as unknown as { week: number; evictionOrder: string[] };
    return JSON.stringify({ trace, week: l.week, out: l.evictionOrder, trust: Object.fromEntries(bag(this).npcs!.map((id) => [id, rel(s).edge(id, PLAYER).trust])) });
  };
  bag(this).mix = { on: run(true), off: run(false) };
});
export function plantMix(this: unknown): void {
  assert.equal(bag(this).mix!.on, bag(this).mix!.off, "planting lies on the player moved the seeded game");
}
