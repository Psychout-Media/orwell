import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { SessionCore } from "../../src/engine/sessionSnapshot";
import { resolvePending } from "../support/answerPending";

// Feature 0133 — early eviction: skip-or-watch + the finale-night interview. Roles only — no names.
// The Given searches seeds for a season whose (auto-played) player is evicted before the jury forms (#1954 pattern).

type Mode = "watch" | "skip";
interface EE { s: GameSessionAdapter; paused: SessionCore; digestsBefore: number; interview?: unknown }
let ee: EE | null = null;
let selfEvictKinds: Set<string> | null = null;
let n = 0;

function newGame(seed: number): GameSessionAdapter {
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor(`bdd-ee${n++}`).session;
  s.createCharacter({ playerName: "P", seed });
  return s;
}
/** Answer a pending with the shared driver — except the two 0133 cards, which a scenario decides itself. */
function answer(s: GameSessionAdapter, p: NonNullable<ReturnType<GameSessionAdapter["advanceGame"]>["pending"]>): void {
  resolvePending(p, (req) => void s.submitDecision(req));
}
function playUntilSpectatorChoice(seed: number): GameSessionAdapter | null {
  const s = newGame(seed);
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending?.kind === "spectator-choice") return s;
    if (v.pending) answer(s, v.pending);
    if (v.finished) return null;
  }
  return null;
}
function reachCrowning(s: GameSessionAdapter): void {
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending && v.pending.kind !== "finale-interview") answer(s, v.pending);
    if (v.finished) return;
  }
  throw new Error("season did not crown");
}
function outcomeOf(core: SessionCore): string {
  const l = core.live!;
  return JSON.stringify({ w: l.winner, f: l.finalTwo, j: l.jury, o: l.evictionOrder });
}

Given("a seeded live season where the player is evicted before the jury forms", function () {
  for (let seed = 1; seed <= 60; seed++) {
    const s = playUntilSpectatorChoice(seed);
    if (s) { ee = { s, paused: s.snapshot(), digestsBefore: 0 }; return; }
  }
  throw new Error("no seed in 1..60 evicted the player before the jury formed");
});

Then("a {string} decision is pending for the player", function (kind: string) {
  assert.equal(ee!.s.getGameState().pending?.kind, kind);
});
Then("the decision offers exactly {string} and {string}", function (a: string, b: string) {
  assert.deepEqual(ee!.s.getGameState().pending!.options.map((o) => o.id), [a, b]);
});

When("the player chooses to watch", function () { ee!.s.submitDecision({ kind: "spectator-choice", vote: "watch" }); });
When("the player chooses to skip", function () { ee!.s.submitDecision({ kind: "spectator-choice", vote: "skip" }); });
When("the player chooses {word}", function (mode: Mode) { ee!.s.submitDecision({ kind: "spectator-choice", vote: mode }); });
When("the player switches to skip", function () { ee!.s.submitDecision({ kind: "spectator-choice", vote: "skip" }); });
When("the game is advanced once", function () {
  const v = ee!.s.advanceGame();
  if (v.pending) answer(ee!.s, v.pending);
});
When("the player tries to choose watch again", function () { ee!.s.submitDecision({ kind: "spectator-choice", vote: "watch" }); });

When("the remaining weeks are advanced", function () {
  const s = ee!.s;
  for (let i = 0; i < 60 && !s.getGameState().finished; i++) {
    const v = s.advanceGame();
    if (v.pending) answer(s, v.pending);
    if (s.snapshot().live!.beat === "finale") break;
  }
});
Then("each completed eviction night produced exactly one week digest", function () {
  const d = ee!.s.getGameState().weekDigests ?? [];
  assert.ok(d.length > 0, "at least one week digest");
  // A twist night (double eviction) has two ceremonies in ONE week number — each gets its own line, so the
  // invariant is one digest per eviction, never one per week number.
  const evictees = d.map((x) => x.evicted?.id).filter((x) => x !== undefined);
  assert.equal(new Set(evictees).size, evictees.length, "no eviction digested twice");
});
Then("every digest contains only public broadcast facts", function () {
  for (const d of ee!.s.getGameState().weekDigests ?? []) {
    assert.deepEqual(Object.keys(d).sort(), ["evicted", "hoh", "juryCount", "nominees", "vetoHolder", "vetoUsed", "week"]);
  }
});
Then("the digests are public game-state records, never hidden events", function () {
  // Digests ride the player-facing game state (the same Vault-free view the player reads); the JSON carries no hidden/vault marker.
  const j = JSON.stringify(ee!.s.getGameState().weekDigests ?? []);
  assert.ok(!/hidden|vault|secret/i.test(j));
});

Then("the season is at the finale reveal", function () {
  const live = ee!.s.snapshot().live!;
  assert.ok(live.beat === "finale" || !!live.finale);
});
Then("the skipped weeks' digests are available to read", function () {
  assert.ok((ee!.s.getGameState().weekDigests ?? []).length > 0);
});
Then("the answer is refused and the player is still skipping", function () {
  assert.equal(ee!.s.getGameState().player!.spectator, "skip");
});

Then("the winner, finalists and jury are identical whether the player watches, skips, or neither is offered", function () {
  const run = (mode: "single" | Mode): string => {
    const t = new GameSessionRegistry().sandboxFor(`bdd-det${n++}`).session;
    t.restore(JSON.parse(JSON.stringify(ee!.paused)) as SessionCore);
    if (mode === "single") {
      const core = t.snapshot();
      core.live!.pending = undefined; core.live!.spectatorOffered = true;
      t.restore(core);
    } else {
      t.submitDecision({ kind: "spectator-choice", vote: mode });
    }
    for (let i = 0; i < 8000; i++) {
      const v = t.advanceGame();
      if (v.pending && v.pending.kind !== "finale-interview") answer(t, v.pending);
      if (v.finished) break;
    }
    return outcomeOf(t.snapshot());
  };
  const single = run("single");
  assert.equal(run("watch"), single);
  assert.equal(run("skip"), single);
});

When("the season reaches the crowning", function () { reachCrowning(ee!.s); });
When("the player answers with a stance and optional words", function () {
  const before = outcomeOf(ee!.s.snapshot());
  ee!.interview = { before };
  ee!.s.submitDecision({ kind: "finale-interview", vote: "gracious", statement: "good game" });
});
Then("the interview is recorded on the season's public record", function () {
  assert.deepEqual(ee!.s.snapshot().live!.finaleInterview, { stance: "gracious", message: "good game" });
});
Then("it appears in the season-end retrospective", function () {
  assert.deepEqual(ee!.s.seasonRetrospective()?.finaleInterview, { stance: "gracious", message: "good game" });
});
Then("no jury vote and no winner changed", function () {
  assert.equal(outcomeOf(ee!.s.snapshot()), (ee!.interview as { before: string }).before);
});
When("the player does not answer the finale interview", function () { /* deliberately nothing */ });
Then("the season has crowned its winner", function () { assert.ok(ee!.s.snapshot().live!.winner); });
Then("the unanswered interview does not prevent any further reads", function () {
  assert.doesNotThrow(() => { ee!.s.getGameState(); ee!.s.seasonRetrospective(); });
});

Then("no digest, summary or interview projection contains hidden or Vault content before the winner is crowned", function () {
  const s = ee!.s;
  const g = JSON.stringify([s.getGameState().weekDigests ?? [], s.getGameState().pending ?? null]);
  assert.ok(!/hidden|vault|confessional|npc:\d+/i.test(g), "no hidden/Vault/raw-id content pre-crowning");
});

Given("a seeded live season where the player confirms a self-eviction", function () {
  const s = newGame(7);
  s.advanceGame();
  s.requestSelfEviction();
  s.submitDecision({ kind: "self-evict", confirmed: true });
  ee = { s, paused: s.snapshot(), digestsBefore: 0 };
});
When("the season is advanced to its end", function () {
  selfEvictKinds = new Set<string>();
  const s = ee!.s;
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending) { selfEvictKinds.add(v.pending.kind); answer(s, v.pending); }
    if (v.finished) break;
  }
});
Then("no {string} and no {string} decision is ever raised", function (a: string, b: string) {
  assert.ok(!selfEvictKinds!.has(a) && !selfEvictKinds!.has(b));
});
