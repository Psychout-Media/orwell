import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Feature 0134 - Telephone-Game Payoffs (ORW-300: wired into the BDD gate). The provenance word on a surfaced gossip fact is derived from its HOP count and shown only with
 * the gossip-drift flag on; a first-hand fact and a flag-off row carry nothing. Driven through the real session path (seed a fact on the player's own knowledge with a known hop
 * count, read the per-turn narrator prompt), exactly as tests/unit/surfacedFactsDelivery.test.ts does. Roles only: the fact text names nobody.
 */
type Sandbox = ReturnType<GameSessionRegistry["sandboxFor"]>;
interface TelephoneState { sb?: Sandbox; content: string; chainSource: string; learned: string; baseline: string; }
const state = new WeakMap<BbWorld, TelephoneState>();
const st = (w: BbWorld): TelephoneState => { let s = state.get(w); if (!s) { s = { content: "", chainSource: "", learned: "", baseline: "" }; state.set(w, s); } return s; };

const FACT = "someone in the house is angling for the veto";
const learnedBlock = (systemPrompt: string): string => systemPrompt.split("\n\n").find((p) => p.startsWith("WHAT YOU'VE LEARNED")) ?? "";

function liveGame(seed: number, user: string): Sandbox {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}
function seedOnPlayer(sb: Sandbox, content: string, hops: number): void {
  sb.engine.knowledge.seedBelief(PLAYER, { content, originalContent: content, factId: `t:${content}`, confidence: 0.9, hops, distortion: 0, source: npc(1) }, `told-by:${npc(1)}`);
}
const readLearned = (sb: Sandbox): string => learnedBlock(sb.session.getMomentPrompt({ moment: "social" }).systemPrompt);

Given("a gossip fact that has passed through two hops before reaching the player", function (this: BbWorld) {
  const s = st(this);
  s.sb = liveGame(1340, "tg-two-hops");
  s.content = FACT; s.chainSource = npc(1);
  seedOnPlayer(s.sb, FACT, 2);
  s.sb.session.setGossipDriftEnabled(true);
});
When("the fact is surfaced to the player", function (this: BbWorld) { const s = st(this); s.learned = readLearned(s.sb!); });
Then("its row carries a chain-length word such as second-hand", function (this: BbWorld) {
  const s = st(this);
  assert.ok(s.learned.includes(FACT), "the fact is surfaced");
  assert.ok(s.learned.includes("(second-hand)"), `a two-hop fact reads second-hand: ${s.learned}`);
  assert.ok(!/\bhops[=:]?\s*\d/.test(s.learned) && !/\(\s*\d\)/.test(s.learned), "the raw hop count never shows");
});
Then("no houseguest identity from the chain is shown", function (this: BbWorld) {
  const s = st(this);
  const teller = s.sb!.session.getGameState().house.find((h) => h.id === s.chainSource);
  assert.ok(!s.learned.includes(s.chainSource), "no chain member id");
  if (teller) assert.ok(!s.learned.includes(teller.name), "no chain member name");
});

Given("a fact the player witnessed or heard directly", function (this: BbWorld) {
  const s = st(this);
  s.sb = liveGame(1341, "tg-first-hand");
  s.content = FACT;
  seedOnPlayer(s.sb, FACT, 0);
  s.sb.session.setGossipDriftEnabled(true);
});
When("it is surfaced", function (this: BbWorld) { const s = st(this); s.learned = readLearned(s.sb!); });
Then("its row has no provenance word", function (this: BbWorld) {
  const s = st(this);
  assert.ok(s.learned.includes(`  - ${FACT}`), `the fact renders cleanly: ${s.learned}`);
  assert.ok(!/-hand\)|everyone's saying/.test(s.learned), `no provenance word on a first-hand fact: ${s.learned}`);
});

Given("gossip drift is disabled", function (this: BbWorld) {
  const s = st(this);
  s.sb = liveGame(1342, "tg-flag-off");
  seedOnPlayer(s.sb, FACT, 3);
  s.sb.session.setGossipDriftEnabled(false);
  // the pre-feature rendering = the same fact with no hop information at all
  const base = liveGame(1342, "tg-flag-off-baseline");
  seedOnPlayer(base, FACT, 0);
  base.session.setGossipDriftEnabled(false);
  s.baseline = readLearned(base);
});
When("a drifted fact is surfaced", function (this: BbWorld) { const s = st(this); s.learned = readLearned(s.sb!); });
Then("the surfaced row is byte-identical to the pre-feature rendering", function (this: BbWorld) {
  const s = st(this);
  assert.ok(s.learned.includes(FACT), "the fact is surfaced");
  assert.equal(s.learned, s.baseline, "with the flag off a three-hop fact renders exactly like a fact with no hop count");
  assert.ok(!/-hand\)|multiple mouths/.test(s.learned), "no provenance word, no guidance line");
});
