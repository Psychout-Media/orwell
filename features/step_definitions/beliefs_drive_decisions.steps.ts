import { After, Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { RelationshipModel } from "../../src/engine/relationships";
import { nominationPlan } from "../../src/engine/season";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { BELIEF_RULES, beliefPull, type BeliefStrength } from "../../src/engine/beliefDecisions";
import type { Agenda } from "../../src/engine/agenda";

/**
 * Feature 0150 - beliefs drive decisions at full strength (theme 2 slice 2, ORW-330). The nomination scenario drives the engine's own
 * nomination plan over seeded houses; the goal scenarios drive the REAL adapter through a registry sandbox (slice 1's `tellClaim`
 * plants the belief). TEST-ONLY seams: the live season (agendas, beliefs), the relationship model (trust), and the adapter's agenda
 * recheck (the same call the engine makes on every trigger). `BELIEF_RULES.strength` is restored after every scenario. Roles only.
 */

type Bag = { counts?: Record<BeliefStrength, { a: number; b: number }>; sb?: UserSandbox; s?: GameSessionAdapter; holder?: string; accused?: string; liar?: string; before?: string };
const bag = (w: unknown): Bag => ((w as { beliefs0150?: Bag }).beliefs0150 ??= {});
const live = (s: GameSessionAdapter) => (s as unknown as { live: { playedGame?: boolean; agendas?: Record<string, Agenda>; beliefs?: BeliefStore } }).live;
const rel = (s: GameSessionAdapter) => (s as unknown as { rel: RelationshipModel }).rel;
const recheck = (s: GameSessionAdapter, who: string) => (s as unknown as { agendaRecheck(t: string, only: string[]): void }).agendaRecheck("week-start", [who]);
let n = 0;

After(function () { BELIEF_RULES.strength = "full"; });

// ---- Scenario: a believed rumor can decide a nomination ----

const HOH = "npc:hoh", A = "npc:a", B = "npc:b";
const OTHERS = ["npc:1", "npc:2", "npc:3", "npc:4", "npc:5"];
const HOUSE = [HOH, A, B, ...OTHERS];
const SEEDS = 60;

/** A seeded house: every directed edge random; then B is made A's exact twin (every edge to and from them copied), so the HOH sees no difference. */
function house(seed: number): RelationshipModel {
  let x = (seed * 2654435761) >>> 0;
  const r = (): number => { x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return (x % 10000) / 10000; };
  const m = new RelationshipModel(0.5);
  for (const p of HOUSE) for (const q of HOUSE) if (p !== q) Object.assign(m.edge(p, q), { trust: r(), affinity: r(), threat: r() });
  for (const p of HOUSE) {
    if (p === A || p === B) continue;
    Object.assign(m.edge(p, B), { ...m.edge(p, A) });
    Object.assign(m.edge(B, p), { ...m.edge(A, p) });
  }
  Object.assign(m.edge(B, A), { ...m.edge(A, B) });
  return m;
}

Given("seeded houses where the HOH sees two houseguests exactly alike", function () {
  bag(this).counts = { full: { a: 0, b: 0 }, capped: { a: 0, b: 0 } };
});

Given("the HOH wrongly believes one of them is targeting them", function () {
  // planted per house in the When (the belief is the only thing that separates the twins)
});

When("the HOH nominates in each house", function () {
  const c = bag(this).counts!;
  for (const strength of ["full", "capped"] as const) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const m = house(seed);
      const store: BeliefStore = {};
      recordClaim(store, { holder: HOH, kind: "targets-me", subject: A, object: HOH, value: true, origin: "told", source: OTHERS[0]!, confidence: 0.6, week: 1 });
      const plan = nominationPlan(HOH, HOUSE, m, { beliefPush: (t) => beliefPull(store, HOH, t, 1, { strength }) });
      if (plan.target === A) c[strength].a += 1;
      if (plan.target === B) c[strength].b += 1;
    }
  }
});

Then("the believed threat is the HOH's target more often than the other", function () {
  const c = bag(this).counts!;
  assert.ok(c.full.a > c.full.b, `full strength: believed threat ${c.full.a} vs twin ${c.full.b}`);
  assert.equal(c.full.b, 0, "the twin nobody believes anything about should never be the target over the believed one");
});

Then("far more often than when beliefs are capped at their old small tilt", function () {
  const c = bag(this).counts!;
  assert.ok(c.full.a >= c.capped.a + SEEDS / 10, `full ${c.full.a} vs capped ${c.capped.a} of ${SEEDS} houses`);
});

// ---- Scenarios: a wrong belief forms a goal; it stays engine-only ----

async function surfaces(sb: UserSandbox): Promise<string> {
  return JSON.stringify([
    await sb.mcp.player.callTool("getGameState", {}),
    await sb.mcp.player.callTool("gameStatus", {}),
    await sb.mcp.admin.callTool("inspectNonVaultState", {}),
    await sb.mcp.admin.callTool("sandboxHealth", {}),
  ]);
}

Given("a started season with a person playing", async function () {
  const sb = new GameSessionRegistry().sandboxFor(`beliefs0150-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 5 });
  live(sb.session).playedGame = true; // agendas are kept for a played game
  const b = bag(this);
  b.sb = sb; b.s = sb.session;
  const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  [b.liar, b.holder, b.accused] = npcs;
  b.before = await surfaces(sb);
});

When("a houseguest is told, falsely, by someone they trust that another houseguest voted to evict them", function () {
  const b = bag(this);
  rel(b.s!).edge(b.holder!, b.liar!).trust = 0.95;
  const told = b.s!.tellClaim({ speaker: b.liar!, listener: b.holder!, kind: "voted-to-evict-you", subject: b.accused!, isTrue: false, intent: "mislead" });
  assert.ok(told, "the engine refused the claim");
});

When("their goals are looked at again", function () {
  const b = bag(this);
  recheck(b.s!, b.holder!);
});

const revengeOn = (w: unknown) => {
  const b = bag(w);
  return (live(b.s!).agendas?.[b.holder!]?.goals ?? []).filter((g) => g.kind === "revenge" && g.target === b.accused);
};

Then("they take up a goal against that houseguest, and the reason is what they believe", function () {
  const goals = revengeOn(this);
  assert.equal(goals.length, 1, "no goal formed against the houseguest they believe voted against them");
  assert.equal(goals[0]!.why[0]!.kind, "belief");
  assert.equal(goals[0]!.why[0]!.about, bag(this).accused);
});

Then("with beliefs capped, no such goal forms", function () {
  const b = bag(this);
  // the same tell in a fresh season, with the strength seam set to the old behaviour
  const sb = new GameSessionRegistry().sandboxFor(`beliefs0150-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 5 });
  live(sb.session).playedGame = true;
  BELIEF_RULES.strength = "capped";
  rel(sb.session).edge(b.holder!, b.liar!).trust = 0.95;
  sb.session.tellClaim({ speaker: b.liar!, listener: b.holder!, kind: "voted-to-evict-you", subject: b.accused!, isTrue: false, intent: "mislead" });
  recheck(sb.session, b.holder!);
  const goals = (live(sb.session).agendas?.[b.holder!]?.goals ?? []).filter((g) => g.kind === "revenge" && g.target === b.accused);
  assert.equal(goals.length, 0, "a capped belief formed a goal");
});

Then("no player-facing or admin view shows the belief or the goal it formed", async function () {
  const b = bag(this);
  assert.equal(revengeOn(this).length, 1, "the belief formed no goal to hide");
  const after = await surfaces(b.sb!);
  assert.ok(!after.includes("revenge") && !after.includes("voted-against-me"), "a belief or its goal reached a surface");
  assert.equal(after, b.before, "telling the claim and forming the goal changed what a player or admin surface shows");
});
