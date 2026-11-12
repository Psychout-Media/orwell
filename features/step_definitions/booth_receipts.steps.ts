import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

// Feature 0139 - the booth has receipts. Roles only. Driven through the real season, the real deal lever and the real
// playerReceipts read; hidden NPC events are written through the engine-side event store (the test seam the other steps use).
type Receipt = { kind: string; summary: string; sourceEventIds?: string[] };
type Rc = GameSessionAdapter;
interface Ctx { sb: UserSandbox; s: Rc; receipts: ReadonlyArray<Receipt>; said?: string; cast?: string; hiddenIds: string[] }
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => state.get(w)!;

function resolve(s: GameSession, p: NonNullable<AdvanceView["pending"]>, evictVote?: string): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round" || p.kind === "comp-intent") s.submitDecision({ kind: p.kind, intent: "compete" });
  else if (p.kind === "eviction-vote") s.submitDecision({ kind: "eviction-vote", vote: evictVote ?? p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", statement: "bye", vote: p.options[0]?.id });
  else s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}
function fresh(seed: number): Ctx {
  const sb = new GameSessionRegistry().sandboxFor(`booth-${seed}-${Math.random()}`);
  const s = sb.session as GameSessionAdapter;
  s.createCharacter({ playerName: "The Player", seed });
  s.setBoothReceiptsEnabled(true);
  return { sb, s, receipts: [], hiddenIds: [] };
}

Given("the player said they would target one nominee and then voted for the other", function (this: BbWorld) {
  for (const seed of [5, 8, 13, 21, 34, 3, 9, 11, 17, 23, 29, 31]) {
    const c = fresh(seed);
    for (let i = 0; i < 1500; i++) {
      const v = c.s.advanceGame();
      if (v.finished) break;
      const p = v.pending;
      if (!p) continue;
      if (p.kind === "eviction-vote" && p.options.length >= 2) {
        const [said, cast] = [p.options[0]!, p.options[1]!];
        c.sb.engine.events.record({
          id: `talk:${c.sb.engine.events.count()}`, ts: c.sb.engine.events.count(), type: "conversation",
          initiator: PLAYER, witnessSet: [PLAYER, cast.id], hidden: false,
          content: `I'm going to target ${said.name} this week, trust me.`,
        });
        resolve(c.s, p, cast.id);
        for (let k = 0; k < 60; k++) {
          const w = c.s.advanceGame();
          if (w.pending) resolve(c.s, w.pending);
          if (w.event?.beat === "eviction-result" || w.finished) break;
        }
        c.said = said.name; c.cast = cast.name;
        // The week's nominees are read back from the ballots, so a unanimous ballot hides the other nominee: try the next seed.
        if (!c.s.playerReceipts().some((r) => r.kind === "target-vote-mismatch")) break;
        state.set(this, c);
        return;
      }
      resolve(c.s, p);
    }
  }
  assert.fail("no seed gave the player an eviction vote");
});
Given("the player holds two open final-two deals", function (this: BbWorld) {
  const c = fresh(7);
  for (let i = 0; i < 3; i++) c.s.advanceGame();
  const rel = (c.s as unknown as { rel: { edge(a: string, b: string): { trust: number; affinity: number } } }).rel;
  const partners = c.s.livingIds().filter((id) => id !== PLAYER).slice(0, 2);
  for (const p of partners) { const e = rel.edge(p, PLAYER); e.trust = 0.9; e.affinity = 0.9; }
  const made = partners.map((p) => c.s.makeDeal({ with: p, kind: "final-two", terms: "final two together" }));
  assert.ok(made.every((m) => m && !("refused" in (m as object))), "both final-two deals were made");
  state.set(this, c);
});
Given("hidden NPC events exist in the season", function (this: BbWorld) {
  const c = fresh(7);
  for (let i = 0; i < 3; i++) c.s.advanceGame();
  const [a, b] = c.s.livingIds().filter((id) => id !== PLAYER);
  // Off-screen NPC-to-NPC scenes the player never witnessed, saying the very things a receipt would cite.
  for (const [i, text] of ["SENTINEL-hidden I'm going to target everyone this week", "SENTINEL-hidden final two with me, I swear it"].entries()) {
    const id = `hidden:${i}`;
    c.sb.engine.events.record({ id, ts: 50 + i, type: "conversation", initiator: a!, witnessSet: [a!, b!], hidden: true, content: text });
    c.hiddenIds.push(id);
  }
  // A hidden record in the player's own name that would contradict a Diary-Room read if it were ever cited as a public statement.
  c.sb.engine.knowledge.recordDiaryRoom("I trust the partner completely");
  c.sb.engine.events.record({ id: "hidden:own", ts: 60, type: "conversation", initiator: PLAYER, witnessSet: [a!], hidden: true, content: "I don't trust the partner at all" });
  c.hiddenIds.push("hidden:own");
  state.set(this, c);
});

When("the booth receipts are read", function (this: BbWorld) { const c = st(this); c.receipts = c.s.playerReceipts(); });
When("the receipts are read", function (this: BbWorld) { const c = st(this); c.receipts = c.s.playerReceipts(); });

Then("a target-vote-mismatch receipt appears citing its source events", function (this: BbWorld) {
  const c = st(this);
  const m = c.receipts.find((r) => r.kind === "target-vote-mismatch");
  assert.ok(m, "the booth caught the contradiction");
  assert.ok(m!.summary.includes(c.said!) && m!.summary.includes(c.cast!), m!.summary);
  assert.ok(!/npc:\d/.test(m!.summary));
  assert.ok((m!.sourceEventIds ?? []).length > 0, "it cites its source events");
});
Then("a divergent-commitment receipt appears", function (this: BbWorld) {
  const r = st(this).receipts.filter((x) => x.kind === "divergent-commitment");
  assert.equal(r.length, 1, JSON.stringify(st(this).receipts.map((x) => x.kind)));
  assert.ok(!/npc:\d/.test(JSON.stringify(r)));
});
Then("none of them draw on hidden events or NPC state", function (this: BbWorld) {
  const c = st(this);
  const blob = JSON.stringify(c.receipts);
  assert.ok(!blob.includes("SENTINEL"), "no hidden content cited");
  assert.ok(!c.receipts.some((r) => r.kind === "dr-public-flip"), "a hidden statement is never a public contradiction");
  for (const r of c.receipts) for (const id of r.sourceEventIds ?? []) assert.ok(!c.hiddenIds.includes(id), `receipt cites hidden ${id}`);
});
