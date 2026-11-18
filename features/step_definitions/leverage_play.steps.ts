import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { LEVERAGE_PLAY, type LeveragePlay } from "../../src/engine/leveragePlay";
import type { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";

/**
 * Feature 0202 - leverage in two registers. Drives the REAL adapter (its daily leverage tick, its makeDeal leverage path) through a registry sandbox. TEST-ONLY seams:
 * the live season, the awake set, the relationship read and the private narrator-fact reader. Roles only: houseguests, the player.
 */
type Seam = {
  live: { playedGame?: boolean; week: number; dayNumber?: number; nominees?: [string, string]; leveragePlays?: LeveragePlay[] };
  rel: { applyImpactDirected(a: string, b: string, i: object, r: { next(): number }): void };
  leveragePlayTick(k: InMemoryKnowledgeService): void; leansOnYouFor(id: string): { manner: string } | undefined; awakeNow(): null;
};
type Bag = { g: Seam; k: InMemoryKnowledgeService; npcs: string[]; days: number; subject?: string; factId?: string; sb: ReturnType<GameSessionRegistry["sandboxFor"]> };
const bag = (w: unknown): Bag => (w as { lev0202?: Bag }).lev0202!;
const SENTINEL = "leverage-planted-content-0202";
let n = 0;

function season(w: unknown, aboutPlayerOnly: boolean, plant = true): void {
  const sb = new GameSessionRegistry().sandboxFor(`lev0202-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 31 });
  const g = sb.session as unknown as Seam;
  g.live.playedGame = true; g.awakeNow = () => null;
  const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  g.live.nominees = [npcs[0]!, npcs[1]!];
  const k = sb.engine.knowledge as InMemoryKnowledgeService;
  for (const h of npcs) for (const t of [...npcs, PLAYER]) {
    if (!plant || t === h || (aboutPlayerOnly && t !== PLAYER)) continue;
    k.seedBelief(h, { content: SENTINEL, originalContent: SENTINEL, factId: `f:${h}:${t}`, subject: t, confidence: 0.8, hops: 0, distortion: 0, source: h }, "origin");
    g.rel.applyImpactDirected(h, t, { threat: npcs.indexOf(h) % 2 === 1 ? 0.1 : t === PLAYER ? 0.9 : 0.5, affinity: -0.3 }, { next: () => 0.5 });
  }
  (w as { lev0202?: Bag }).lev0202 = { g, k, npcs, days: 0, sb };
}
const pass = (b: Bag, days: number) => { for (let i = 0; i < days; i++) { b.days += 1; b.g.live.dayNumber = (b.g.live.dayNumber ?? 0) + 1; b.g.leveragePlayTick(b.k); } };

Given("a leverage-play season where every houseguest holds a fact about the others", function () { season(this, false); });
Given("a leverage-play season where every houseguest holds a fact about the player", function () { season(this, true); });
When("the leverage days pass", function () { pass(bag(this), 60); });
Then("some houseguests lean on the player and some lean on each other", function () {
  const plays = bag(this).g.live.leveragePlays ?? [];
  assert.ok(plays.some((p) => p.target === PLAYER)); assert.ok(plays.some((p) => p.target !== PLAYER));
});
Then("both a blunt demand and a sneaky play appear", function () { assert.deepEqual([...new Set((bag(this).g.live.leveragePlays ?? []).map((p) => p.manner))].sort(), ["blunt", "sneaky"]); });
Then("the plays are far fewer than the days in which they could have been made", function () {
  const b = bag(this); assert.ok((b.g.live.leveragePlays ?? []).length < b.days * LEVERAGE_PLAY.maxPlaysPerDay);
});

When("a houseguest begins to lean on the player", function () {
  const b = bag(this);
  for (let i = 0; i < 60 && !(b.g.live.leveragePlays ?? []).some((p) => p.status === "open"); i++) pass(b, 1);
  assert.ok((b.g.live.leveragePlays ?? []).some((p) => p.status === "open"), "no approach began");
});
Then("the narrator is handed only who is leaning and in what manner", function () {
  const b = bag(this); const open = (b.g.live.leveragePlays ?? []).find((p) => p.status === "open")!;
  const fact = b.g.leansOnYouFor(open.holder)!;
  assert.deepEqual(Object.keys(fact), ["manner"]);
  assert.equal(JSON.stringify(fact).includes(SENTINEL), false);
});
Then("nothing has been done on the player's behalf", function () {
  const open = (bag(this).g.live.leveragePlays ?? []).find((p) => p.status === "open")!;
  assert.equal(open.target, PLAYER); assert.equal(open.status, "open");
});
Then("an approach the player ignores for long enough closes without the player acting", function () {
  const b = bag(this); const id = (b.g.live.leveragePlays ?? []).find((p) => p.status === "open")!.id;
  pass(b, LEVERAGE_PLAY.answerDays + 1);
  assert.notEqual((b.g.live.leveragePlays ?? []).find((p) => p.id === id)!.status, "open");
});

Given("a leverage-play season where the player has learned a fact about a houseguest", function () {
  season(this, true, false);
  const b = bag(this);
  const subject = b.npcs[0]!;
  b.k.seedBelief(subject, { content: SENTINEL, originalContent: SENTINEL, factId: `l:${subject}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
  b.k.surfaceInformationTo(PLAYER, { content: SENTINEL, subject, confidence: 0.85 }, `told-by:${subject}`);
  b.subject = subject;
  const fact = b.k.knownTo(PLAYER).find((f) => f.subject === subject)!;
  b.factId = fact.factId ?? fact.id;
  b.sb.session.setPlayerKnowledgeReader(() => b.k.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId })));
});
When("the player makes a deal with that houseguest pressing the fact quietly", function () {
  const b = bag(this);
  (b as Bag & { deal?: unknown }).deal = b.sb.session.makeDeal({ with: b.subject!, kind: "safety", terms: "keep me safe", leverage: { factId: b.factId!, manner: "sneaky" } });
});
Then("the deal forms and the engine records a sneaky play by the player", function () {
  const b = bag(this);
  assert.ok((b as Bag & { deal?: { id?: string } }).deal?.id, "the deal did not form");
  assert.ok((b.g.live.leveragePlays ?? []).some((p) => p.holder === PLAYER && p.manner === "sneaky"));
});
Then("the engine decided whether it was noticed", function () {
  const p = (bag(this).g.live.leveragePlays ?? []).find((x) => x.holder === PLAYER)!;
  assert.ok(p.status === "worked" || p.status === "noticed");
});

Then("no recorded play and no fact for the narrator carries the planted content", function () {
  const b = bag(this);
  assert.equal(JSON.stringify(b.g.live.leveragePlays ?? []).includes(SENTINEL), false);
  for (const id of b.npcs) assert.equal(JSON.stringify(b.g.leansOnYouFor(id) ?? {}).includes(SENTINEL), false);
});
