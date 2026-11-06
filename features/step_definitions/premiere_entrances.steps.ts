import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../support/answerPending";

/** A9 - premiere entrances (0111 flag-on scenarios). Roles only; ids/names come from the generated cast. */
function bag(w: BbWorld): NonNullable<BbWorld["pe"]> { return (w.pe ??= {}); }
const SENTINEL = "SENTINEL-A9-entrances-secret";

function start(seed: number, on: boolean, user: string): { session: GameSessionAdapter; sandbox: ReturnType<GameSessionRegistry["sandboxFor"]> } {
  const sandbox = new GameSessionRegistry().sandboxFor(user);
  const session = sandbox.session;
  session.setPremiereEntrancesEnabled(on);
  session.createCharacter({ playerName: "P", seed });
  return { session, sandbox };
}
const everyone = (s: GameSessionAdapter): string[] => {
  const st = s.getGameState();
  return [st.player!.id, ...st.house.map((h) => h.id)];
};
const entranceState = (s: GameSessionAdapter): { order: string[]; playerPos: number; stage: string } | undefined =>
  (s.snapshot().live as unknown as { premiereEntrance?: { order: string[]; playerPos: number; stage: string } }).premiereEntrance;

Given("the premiere entrances are enabled for a seeded season", function (this: BbWorld) {
  const w = bag(this);
  w.seed = 111;
  const { session, sandbox } = start(w.seed, true, "a9-on");
  w.session = session; w.sandbox = sandbox;
  w.sandbox.engine.vault.writeHidden({ id: "a9:secret", kind: "confessional", content: SENTINEL });
  w.sentinel = SENTINEL;
});

Given("the premiere entrances are disabled for a seeded season", function (this: BbWorld) {
  const w = bag(this);
  const { session, sandbox } = start(111, false, "a9-off");
  w.session = session; w.sandbox = sandbox;
});

Given("premiere entrances for several different seeds", function (this: BbWorld) {
  const w = bag(this);
  w.positions = [];
  for (let seed = 1; seed <= 20; seed++) w.positions.push(entranceState(start(seed, true, `a9-seed-${seed}`).session)!.playerPos);
});

Then("the entrance order contains every houseguest exactly once", function (this: BbWorld) {
  const s = bag(this).session!;
  const order = entranceState(s)!.order;
  assert.equal(order.length, 16, "sixteen houseguests (the player plus fifteen)");
  assert.deepEqual([...order].sort(), everyone(s).sort(), "a permutation of the whole house, each exactly once");
});

Then("the player's position in the order is recorded", function (this: BbWorld) {
  const s = bag(this).session!;
  const pe = entranceState(s)!;
  assert.ok(Number.isInteger(pe.playerPos) && pe.playerPos >= 0 && pe.playerPos < 16);
  assert.equal(pe.order[pe.playerPos], s.getGameState().player!.id, "the recorded position is the player's slot");
});

Then("the same seed reproduces the same order", function (this: BbWorld) {
  const w = bag(this);
  const again = start(w.seed!, true, "a9-on-again").session;
  assert.deepEqual(entranceState(again)!.order, entranceState(w.session!)!.order);
});

Then("the player does not occupy the same position in every season", function (this: BbWorld) {
  const distinct = new Set(bag(this).positions!);
  assert.ok(distinct.size >= 3, `the player's position varies by seed (saw ${[...distinct].join(",")})`);
});

When("the entrances and the toast are played through", function (this: BbWorld) {
  const w = bag(this);
  const s = w.session!;
  w.gateAlwaysTrue = true; w.hohDuringEntrances = false;
  for (let i = 0; i < 80 && entranceState(s)!.stage !== "done"; i++) {
    const pr = s.premiereIntros();
    // ORW-196: the roll-call gate is "raised" only if `complete`/`powerReachable` DISAGREE with the entrance stage: while arrivals are still staged ("entrances") the tally honestly
    // reads incomplete (nothing is gated on it - the first power waits for the toast), and from the toast on it must read complete + reachable.
    if (pr) {
      const staging = pr.entrance?.stage === "entrances";
      if (pr.complete === staging || (!staging && !pr.powerReachable)) w.gateAlwaysTrue = false;
    }
    if (s.gameStatus().hoh) w.hohDuringEntrances = true;
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
  }
  assert.equal(entranceState(s)!.stage, "done", "the entrances and the toast finished within a bounded number of steps");
});

type Ev = { type: string; content: string; witnessSet: readonly string[] };
const eventsOf = (w: NonNullable<BbWorld["pe"]>, type: string): Ev[] =>
  (w.sandbox!.engine.events.queryAll() as unknown as Ev[]).filter((e) => e.type === type);
const nameOf = (s: GameSessionAdapter, id: string): string => {
  const st = s.getGameState();
  return id === st.player!.id ? st.player!.name : st.house.find((h) => h.id === id)!.name;
};

Then("every houseguest entered exactly once and each entrance is a recorded event", function (this: BbWorld) {
  const w = bag(this); const s = w.session!;
  const arrivals = eventsOf(w, "premiere-entrance");
  assert.equal(arrivals.length, 16, "one recorded arrival per houseguest");
  for (const id of everyone(s)) {
    const n = arrivals.filter((e) => e.content === `${nameOf(s, id)} arrives`).length;
    assert.equal(n, 1, "each houseguest enters exactly once");
  }
});

Then("every houseguest has met the player and every other houseguest by witnessing", function (this: BbWorld) {
  const w = bag(this); const s = w.session!;
  const ids = everyone(s);
  const arrivals = eventsOf(w, "premiere-entrance");
  const arrivalOf = new Map(ids.map((id) => [id, arrivals.find((e) => e.content === `${nameOf(s, id)} arrives`)!] as const));
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    // a has met b iff a witnessed b's arrival, or b witnessed a's (the later arriver is seen by everyone already inside).
    const met = arrivalOf.get(b)!.witnessSet.includes(a) || arrivalOf.get(a)!.witnessSet.includes(b);
    assert.ok(met, "every pair meets through a witnessed entrance");
  }
});

Then("the host and every houseguest gave a recorded toast speech, except the player's own chat-authored slot", function (this: BbWorld) {
  const w = bag(this); const s = w.session!;
  const speeches = eventsOf(w, "toast-speech");
  assert.equal(speeches.filter((e) => e.content === "The host opens the toast").length, 1, "the host speaks once");
  const me = s.getGameState().player!;
  for (const h of s.getGameState().house) assert.equal(speeches.filter((e) => e.content === `${h.name} gives a toast`).length, 1, "each houseguest toasts once");
  assert.equal(speeches.filter((e) => e.content.includes(me.name)).length, 0, "the player's slot is chat-authored, never engine-recorded");
});

Then("nothing hidden appears in any entrance or toast output", function (this: BbWorld) {
  const w = bag(this); const s = w.session!;
  const out = JSON.stringify([eventsOf(w, "premiere-entrance"), eventsOf(w, "toast-speech"), s.premiereIntros(), s.whereabouts()]);
  assert.ok(!out.includes(w.sentinel!), "the Vault sentinel never reaches an entrance/toast surface");
  assert.ok(!/trust|affinity|threat/i.test(JSON.stringify(eventsOf(w, "premiere-entrance"))), "no relationship terms in recorded entrance content");
});

Then("the meet-everyone gate is never raised", function (this: BbWorld) {
  assert.equal(bag(this).gateAlwaysTrue, true, "complete/powerReachable agree with the entrance stage (incomplete only while arrivals are staged, complete from the toast on) - no roll-call gate");
});

Then("the first power does not start until the toast is done", function (this: BbWorld) {
  const w = bag(this);
  assert.equal(w.hohDuringEntrances, false, "no HOH is crowned while entrances/toast run");
  assert.equal(w.session!.getGameState().phase, "premiere", "the premiere has not yet advanced to the HOH competition");
});

Then("no premiere entrance state exists and the champagne circle opens as before", function (this: BbWorld) {
  const s = bag(this).session!;
  assert.equal(entranceState(s), undefined, "flag off: no premiereEntrance in the live state");
  assert.equal((s.snapshot().live as unknown as { champagneCircle?: string }).champagneCircle, "gathered");
  assert.equal(s.premiereIntros()!.entrance, undefined);
});
