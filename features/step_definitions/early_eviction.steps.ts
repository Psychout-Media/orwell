import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { SessionCore } from "../../src/engine/sessionSnapshot";
import { resolvePending } from "../support/answerPending";
import { EngineRefusal } from "../../src/domain/errors";

// Feature 0133 — early eviction: skip-or-watch + the finale-night interview. Roles only — no names.
// The Given searches seeds for a season whose (auto-played) player is evicted before the jury forms (#1954 pattern).

type Mode = "watch" | "skip";
interface EE { s: GameSessionAdapter; paused: SessionCore; digestsBefore: number; evictionsAtChoice: number; interview?: unknown; refusal?: unknown; liveBeforeRefusal?: string }
let ee: EE | null = null;
let selfEvictKinds: Set<string> | null = null;
let n = 0;

const sandboxOf = new WeakMap<GameSessionAdapter, UserSandbox>();
function newGame(seed: number): GameSessionAdapter {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`bdd-ee${n++}`);
  const s = sb.session;
  sandboxOf.set(s, sb);
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
    if (s) { ee = { s, paused: s.snapshot(), digestsBefore: 0, evictionsAtChoice: 0 }; return; }
  }
  throw new Error("no seed in 1..60 evicted the player before the jury formed");
});

Then("a {string} decision is pending for the player", function (kind: string) {
  assert.equal(ee!.s.getGameState().pending?.kind, kind);
});
Then("the decision offers exactly {string} and {string}", function (a: string, b: string) {
  assert.deepEqual(ee!.s.getGameState().pending!.options.map((o) => o.id), [a, b]);
});

function choose(mode: Mode): void {
  ee!.evictionsAtChoice = ee!.s.snapshot().live!.evictionOrder.length;
  ee!.s.submitDecision({ kind: "spectator-choice", vote: mode });
}
When("the player chooses to watch", function () { choose("watch"); });
When("the player chooses to skip", function () { choose("skip"); });
When("the player chooses {word}", function (mode: Mode) { choose(mode); });
When("the player switches to skip", function () { ee!.s.submitDecision({ kind: "spectator-choice", vote: "skip" }); });
When("the game is advanced once", function () {
  const v = ee!.s.advanceGame();
  if (v.pending) answer(ee!.s, v.pending);
});
When("the player tries to choose watch again", function () {
  ee!.liveBeforeRefusal = JSON.stringify(ee!.s.snapshot().live);
  try { ee!.s.submitDecision({ kind: "spectator-choice", vote: "watch" }); ee!.refusal = undefined; } catch (e) { ee!.refusal = e; }
});

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
  const evictionsSinceChoice = ee!.s.snapshot().live!.evictionOrder.length - ee!.evictionsAtChoice;
  assert.ok(evictionsSinceChoice > 0, "the watched stretch contained at least one eviction");
  // A twist night (double eviction) has two ceremonies in ONE week number — each gets its own line, so the
  // invariant is EXACTLY one digest per eviction made after the player's choice (not per week number, not "at least one").
  assert.equal(d.length, evictionsSinceChoice, "weekDigests.length equals the evictions made after the choice");
  const evictees = d.map((x) => x.evicted?.id).filter((x) => x !== undefined);
  assert.equal(new Set(evictees).size, evictees.length, "no eviction digested twice");
});
const DIGEST_KEYS = ["evicted", "hoh", "juryCount", "nominees", "vetoHolder", "vetoUsed", "week"];
Then("every digest contains only public broadcast facts", function () {
  const digests = ee!.s.getGameState().weekDigests ?? [];
  assert.ok(digests.length > 0, "there are digests to check");
  for (const d of digests) {
    // 1. the exact key allowlist (a new field must be reviewed to be added, not slip through)
    assert.deepEqual(Object.keys(d).sort(), DIGEST_KEYS);
    // 2. display values only: no raw `npc:N` handle leaks into any NAME or text value (the `id` of a named reference is the player's
    //    ordinary handle for that houseguest; what must never appear is a raw id inside a display string).
    const display = JSON.stringify(d, (k, v) => (k === "id" ? undefined : v));
    assert.ok(!/npc:\d+/.test(display), `no raw id in a digest's display values: ${display}`);
  }
});
Then("the digests are public game-state records, never hidden events", function () {
  const s = ee!.s;
  const digests = s.getGameState().weekDigests ?? [];
  const live = s.snapshot().live!;
  // A digest is a projection of the PUBLIC ceremony record (live.weekDigests), not an event of its own: every evictee it names is a
  // ceremony eviction on the season record, and no event (hidden or not) is a digest.
  for (const d of digests) {
    if (d.evicted) assert.ok(live.evictionOrder.includes(d.evicted.id), "a digested evictee is on the public eviction record");
  }
  const events = sandboxOf.get(s)!.engine.events.queryAll();
  assert.ok(!events.some((e) => /digest/i.test(e.content)), "no EventStore event is (or carries) a week digest");
});

Then("the season is at the finale reveal", function () {
  const live = ee!.s.snapshot().live!;
  assert.ok(live.beat === "finale" || !!live.finale);
});
Then("the skipped weeks' digests are available to read", function () {
  assert.ok((ee!.s.getGameState().weekDigests ?? []).length > 0);
});
Then("the answer is refused and the player is still skipping", function () {
  // The engine's VISIBLE outcome: a typed refusal with a clear reason (not a silent no-op) the narrator can voice...
  assert.ok(ee!.refusal instanceof EngineRefusal, "a later watch after skip is a typed EngineRefusal");
  assert.match((ee!.refusal as Error).message, /irreversible/i, "the refusal names why");
  // ...and the state is untouched.
  assert.equal(ee!.s.getGameState().player!.spectator, "skip");
  assert.equal(JSON.stringify(ee!.s.snapshot().live), ee!.liveBeforeRefusal, "the refused answer changed nothing");
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
  ee = { s, paused: s.snapshot(), digestsBefore: 0, evictionsAtChoice: 0 };
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
