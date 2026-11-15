import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import { assertNoSentinels } from "../../tests/support/assertions";
import { npc } from "../../src/domain/ids";
import { answerPending, resolvePending } from "../support/answerPending";

// Feature 0034 — codifies the live weekly loop + decision seam, driven only through the MCP player
// channel (createCharacter → advanceGame/submitDecision). Seed 5: the player survives deep and faces
// the full range of decisions (a thorough wiring proof, mirroring tests/integration/liveProgression).

type Player = import("../../src/adapters/mcp/McpServer").McpServer;

const adv = async (p: Player): Promise<AdvanceView> => (await p.callTool("advanceGame", {})) as AdvanceView;

async function resolveLegally(p: Player, d: NonNullable<AdvanceView["pending"]>): Promise<void> {
  const req = answerPending(d);
  if (req) await p.callTool("submitDecision", req as unknown as Record<string, unknown>);
}

/** Advance until the first BINDING pending decision, counting beats that resolved automatically. */
async function driveToPending(p: Player): Promise<{ view: AdvanceView; beats: number }> {
  let beats = 0;
  for (let i = 0; i < 3000; i++) {
    const view = await adv(p);
    // B46 / 0006 staged-rounds: a competition-approach declaration (the single comp-intent or a per-round
    // comp-round) auto-resolves to compete and counts as an auto beat — it is not the "first binding
    // decision" the scenario means (that's a nomination / vote / etc.).
    if (view.pending?.kind === "comp-intent" || view.pending?.kind === "comp-round") {
      await p.callTool("submitDecision", { kind: view.pending.kind, intent: "compete" });
      beats++;
      continue;
    }
    if (view.pending || view.finished) return { view, beats };
    beats++;
  }
  throw new Error("no pending decision within bound");
}

/** Advance to a pending decision of a specific kind, resolving any others legally on the way. */
async function driveToKind(p: Player, kind: string): Promise<AdvanceView> {
  for (let i = 0; i < 3000; i++) {
    const view = await adv(p);
    if (view.finished) throw new Error(`finished before reaching ${kind}`);
    if (view.pending) {
      if (view.pending.kind === kind) return view;
      await resolveLegally(p, view.pending);
    }
  }
  throw new Error(`never reached ${kind}`);
}

/** The pending decision as it stood before an illegal submit — kind AND option ids (a refusal must not reshape it). */
const pendingBefore = new WeakMap<BbWorld, { kind: string; optionIds: string[] }>();
const snap = (d: NonNullable<AdvanceView["pending"]>): { kind: string; optionIds: string[] } =>
  ({ kind: d.kind, optionIds: (d.options ?? []).map((o) => o.id) });

const newLive = (user: string, seed: number): { reg: GameSessionRegistry; player: Player } => {
  const reg = new GameSessionRegistry();
  const player = reg.resolver()("player", user) as Player;
  return { reg, player };
};

// --- S1: auto-resolve + stop ---------------------------------------------------

Given("a live game started for the player", async function (this: BbWorld) {
  const { reg, player } = newLive("u1", 5);
  this.registry = reg; this.livePlayer = player;
  await player.callTool("createCharacter", { playerName: "Player", seed: 5 });
});

When("the game is advanced to the player's first binding decision", async function (this: BbWorld) {
  const { view, beats } = await driveToPending(this.livePlayer!);
  this.lastAdvance = view; this.beatsBeforeStop = beats;
});

Then("at least one beat resolved automatically before it stopped", function (this: BbWorld) {
  assert.ok((this.beatsBeforeStop ?? 0) >= 1, "NPC beats resolved automatically before the player's turn");
});

Then("the pending decision offers a legal set of options", function (this: BbWorld) {
  const p = this.lastAdvance!.pending;
  assert.ok(p, "a decision is pending");
  assert.ok(p!.options.length >= p!.pick, "enough legal options to satisfy the pick");
});

Then("advancing again does not skip the pending decision", async function (this: BbWorld) {
  const before = this.lastAdvance!.pending!;
  const again = await adv(this.livePlayer!);
  assert.ok(again.pending, "still pending (idempotent while a decision is owed)");
  assert.equal(again.pending!.kind, before.kind);
  assert.deepEqual(again.pending!.options.map((o) => o.id), before.options.map((o) => o.id));
});

// --- S2: validated apply -------------------------------------------------------

Given("a live game advanced to the player's first binding decision", async function (this: BbWorld) {
  const { reg, player } = newLive("u1", 5);
  this.registry = reg; this.livePlayer = player;
  await player.callTool("createCharacter", { playerName: "Player", seed: 5 });
  this.lastAdvance = (await driveToPending(player)).view;
});

When("the player submits a legal choice through the seam", async function (this: BbWorld) {
  this.beatsBeforeStop = this.registry!.sandboxFor("u1").engine.events.queryAll().length;
  await resolveLegally(this.livePlayer!, this.lastAdvance!.pending!);
  this.lastAdvance = await adv(this.livePlayer!);
});

Then("the choice is applied and the loop continues", function (this: BbWorld) {
  const now = this.registry!.sandboxFor("u1").engine.events.queryAll().length;
  assert.ok(now > (this.beatsBeforeStop ?? 0), "the resolved beat advanced the loop (new events)");
});

Then("the beats are recorded as player-witnessed events", function (this: BbWorld) {
  const events = this.registry!.sandboxFor("u1").engine.events.queryAll();
  // The BEATS (house-events) the player lived are never hidden. NPC confessionals (0040) are recorded
  // alongside them but are Vault-only interiority — legitimately hidden — so we assert on the beats.
  const beats = events.filter((e) => e.type === "house-event");
  assert.ok(beats.length > 0, "the loop recorded player-witnessed beats");
  assert.ok(beats.every((e) => !e.hidden), "the player lived these beats — never hidden");
});

// --- S3: illegal refused -------------------------------------------------------

Given("a live game advanced to a nomination decision", async function (this: BbWorld) {
  // Seed re-selected 2026-11-13 (ORW-19 comp-win threat 0.3 -> 0.45): the player must be HOH to face a nominations decision, which depends on the seed; it holds on most seeds (seeds 1, 2, 11, 12 at both values), seed 5 no longer.
  const { reg, player } = newLive("u1", 1);
  this.registry = reg; this.livePlayer = player;
  await player.callTool("createCharacter", { playerName: "Player", seed: 1 });
  this.lastAdvance = await driveToKind(player, "nominations");
});

When("the player submits an illegal nomination", async function (this: BbWorld) {
  const p = this.lastAdvance!.pending!;
  pendingBefore.set(this, snap(p));
  // Naming the same houseguest twice is illegal (0005 legality enforced in liveSeason.applyDecision).
  try {
    await this.livePlayer!.callTool("submitDecision", { kind: "nominations", choice: [p.options[0]!.id, p.options[0]!.id] });
    this.liveRefused = false;
  } catch (e) {
    assert.match(String((e as Error).message), /cannot nominate the same houseguest twice/, "refused for the RIGHT reason");
    this.liveRefused = true;
  }
});

Then("the seam refuses it", function (this: BbWorld) {
  assert.equal(this.liveRefused, true, "the illegal choice was rejected");
});

Given("a live game advanced to an eviction-vote decision for the player", async function (this: BbWorld) {
  // The player must be a plain voter (not HOH / nominee) — which depends on the seed, so search for one and
  // FAIL LOUDLY if none lands (never skip the scenario silently).
  let lastErr: unknown;
  for (let seed = 5; seed < 45; seed++) {
    const { reg, player } = newLive(`vote-${seed}`, seed);
    await player.callTool("createCharacter", { playerName: "Player", seed });
    try {
      const view = await driveToKind(player, "eviction-vote");
      this.registry = reg; this.livePlayer = player; this.lastAdvance = view;
      return;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`no seed in 5..44 put the player at an eviction-vote decision: ${String(lastErr)}`);
});

When("the player votes to evict a houseguest who is not a nominee", async function (this: BbWorld) {
  const p = this.lastAdvance!.pending!;
  pendingBefore.set(this, snap(p));
  const nominees = new Set(p.options.map((o) => o.id));
  // The HOH is a real, present houseguest who is never one of the two nominees.
  const state = (await this.livePlayer!.callTool("getGameState", {})) as { ceremony?: { hoh: { id: string } | null } };
  const notNominee = state.ceremony?.hoh?.id && !nominees.has(state.ceremony.hoh.id)
    ? state.ceremony.hoh.id
    : Array.from({ length: 15 }, (_, i) => npc(i + 1)).find((id) => !nominees.has(id));
  assert.ok(notNominee, "fixture: a houseguest outside the two nominees exists");
  try {
    await this.livePlayer!.callTool("submitDecision", { kind: "eviction-vote", vote: notNominee });
    this.liveRefused = false;
  } catch (e) {
    // Only the engine's own legality refusal counts — an unrelated tool/engine failure must NOT pass as "refused".
    assert.match(String((e as Error).message), /can only vote to evict a final nominee/, "refused for the RIGHT reason");
    this.liveRefused = true;
  }
});

Then("the same pending decision still stands", async function (this: BbWorld) {
  const again = await adv(this.livePlayer!);
  assert.ok(again.pending, "still pending after the refusal");
  const before = pendingBefore.get(this)!;
  assert.equal(again.pending!.kind, before.kind);
  assert.deepEqual(again.pending!.options.map((o) => o.id), before.optionIds, "the SAME options, not a reshaped decision");
});

// --- S4: restart ---------------------------------------------------------------

Given("a live game advanced several beats", async function (this: BbWorld) {
  const { reg, player } = newLive("u2", 9);
  this.registry = reg; this.livePlayer = player; this.liveUser = "u2";
  await player.callTool("createCharacter", { playerName: "Player", seed: 9 });
  for (let i = 0; i < 3; i++) {
    const v = await adv(player);
    if (v.pending) await resolveLegally(player, v.pending);
  }
  const st = (await player.callTool("gameStatus", {})) as { week: number; phase: string };
  this.liveWeekA = st.week; this.livePhaseA = st.phase;
});

// Shared restart step (0034 + 0037): restore the current scenario's user into a fresh registry
// from the durable snapshot, capturing both the public status and the full resumed snapshot so
// each scenario's Then can assert what it cares about (week/phase, or the in-progress finale).
When("the engine restarts and resumes from the durable save", async function (this: BbWorld) {
  const user = this.liveUser ?? "u2";
  const snap = this.savedSnap ?? this.registry!.snapshot(user);
  this.registry2 = new GameSessionRegistry();
  this.registry2.restore(user, snap);
  this.resumedSnap = this.registry2.snapshot(user) as typeof this.resumedSnap;
  const st = (await this.registry2.resolver()("player", user).callTool("gameStatus", {})) as { week: number; phase: string };
  this.liveWeekB = st.week; this.livePhaseB = st.phase;
});

Then("the resumed week and phase match exactly", function (this: BbWorld) {
  assert.equal(this.liveWeekB, this.liveWeekA);
  assert.equal(this.livePhaseB, this.livePhaseA);
});

// --- S5: Vault-free ------------------------------------------------------------

Given("a live game whose Vault holds hidden content", async function (this: BbWorld) {
  const { reg, player } = newLive("u3", 2);
  this.registry = reg; this.livePlayer = player;
  await player.callTool("createCharacter", { playerName: "Player", seed: 2 });
  this.durableSentinel = "SENTINEL-VAULT-0034-secret-scheme";
  // An off-screen scene the player does NOT witness (hidden) — must never reach the live outputs.
  reg.sandboxFor("u3").engine.events.record({
    id: "hidden:0034", ts: 999_999, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: this.durableSentinel,
  });
});

When("the game is advanced and the status is read", async function (this: BbWorld) {
  const a = await adv(this.livePlayer!);
  const s = await this.livePlayer!.callTool("gameStatus", {});
  this.lastOutput = `${JSON.stringify(a)}\n${JSON.stringify(s)}`;
});

Then("no advance or status output carries a Vault sentinel value", function (this: BbWorld) {
  assertNoSentinels(this.lastOutput, [this.durableSentinel!]);
});

// --- S6: deterministic ---------------------------------------------------------

/** T12: the FULL trails of the two same-seed runs — two diverged games typically still agree
 *  on the final week/phase after 60 advances, so the Then compares the whole journey. */
let liveTrailA: string[] = [];
let liveTrailB: string[] = [];
let liveEventsA: string[] = [];
let liveEventsB: string[] = [];

Given("two live games started from the same seed", async function (this: BbWorld) {
  const a = newLive("a", 2); const b = newLive("b", 2);
  this.registry = a.reg; this.registry2 = b.reg; this.livePlayer = a.player;
  await a.player.callTool("createCharacter", { playerName: "Player", seed: 2 });
  await b.player.callTool("createCharacter", { playerName: "Player", seed: 2 });
});

When("the same advances and decisions are applied to each", async function (this: BbWorld) {
  const drive = async (p: Player, reg: GameSessionRegistry, user: string) => {
    const trail: string[] = [];
    for (let i = 0; i < 60; i++) {
      const v = await adv(p);
      // The per-advance trail: position + the beat the engine resolved + the decision it owed.
      trail.push(
        `${v.status.week}|${v.status.phase}|${v.event?.beat ?? ""}|${v.event?.content ?? ""}|${v.pending?.kind ?? ""}`,
      );
      if (v.finished) break;
      if (v.pending) await resolveLegally(p, v.pending);
    }
    // The full recorded event trail (kind + day-counter + visibility + content) — every event
    // the run committed to its store, hidden off-screen life included.
    const events = reg.sandboxFor(user).engine.events.queryAll()
      .map((e) => `${e.type}:${e.ts}:${e.hidden}:${e.initiator}:${e.content}`);
    return { status: (await p.callTool("gameStatus", {})) as { week: number; phase: string }, trail, events };
  };
  const a = await drive(this.livePlayer!, this.registry!, "a");
  const b = await drive(this.registry2!.resolver()("player", "b") as Player, this.registry2!, "b");
  this.liveWeekA = a.status.week; this.livePhaseA = a.status.phase;
  this.liveWeekB = b.status.week; this.livePhaseB = b.status.phase;
  liveTrailA = a.trail; liveTrailB = b.trail;
  liveEventsA = a.events; liveEventsB = b.events;
});

Then("their resulting week and phase are identical", function (this: BbWorld) {
  assert.equal(this.liveWeekB, this.liveWeekA);
  assert.equal(this.livePhaseB, this.livePhaseA);
  // T12: the final position agreeing is necessary but weak — the FULL advance-by-advance trail
  // and the FULL committed event record must match (the strategic_decisions trail pattern).
  assert.ok(liveTrailA.length >= 50, "the runs genuinely advanced (a long trail to compare)");
  assert.deepEqual(liveTrailB, liveTrailA, "the two runs took the identical advance-by-advance journey");
  assert.ok(liveEventsA.length > 0, "the runs recorded events to compare");
  assert.deepEqual(liveEventsB, liveEventsA, "the two runs committed identical event records");
});
