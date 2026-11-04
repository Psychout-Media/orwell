import { EngineRefusal } from "../../src/domain/errors";
import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import type { SessionCore } from "../../src/engine/sessionSnapshot";
import { isInertBeat, SPECTATOR_MODES, isPreJuryEvictee } from "../../src/engine/liveSeason";
import { PLAYER } from "../../src/domain/ids";

/**
 * Feature 0133 — early eviction: a PRE-JURY-evicted player chooses to skip to the finale or watch the engine's
 * skeleton season, and is interviewed on the finale night. The choice and the digests change NOTHING about the
 * season (same RNG, same winner); the interview is raised after the jury decided. Roles only — no names.
 */

/** Answer any pending legally and DETERMINISTICALLY (the same policy for every variant being compared). */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>, choose: "watch" | "skip" = "watch"): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") submit({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else if (p.kind === "exit-interview") submit({ kind: "exit-interview", vote: p.stances![0]! });
  else if (p.kind === "goodbye-message") submit({ kind: "goodbye-message", vote: p.options[0]!.id });
  else if (p.kind === "spectator-choice") submit({ kind: "spectator-choice", vote: choose });
  else if (p.kind === "finale-interview") submit({ kind: "finale-interview", vote: "gracious", statement: "good game" });
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

let userSeq = 0;
function newGame(seed: number): GameSessionAdapter {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`ee${userSeq++}`);
  sb.session.createCharacter({ playerName: "P", seed });
  return sb.session;
}

/** Play a season until the PRE-JURY spectator-choice pending appears. Returns the session paused ON it, or null. */
function playUntilSpectatorChoice(seed: number): GameSessionAdapter | null {
  const s = newGame(seed);
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending?.kind === "spectator-choice") return s;
    if (v.pending) resolve(s, v.pending);
    if (v.finished) return null;
  }
  return null;
}

/** The repo's seed-search pattern (#1954): never pin a seed the balance can move. */
function findEarlyEvictionSession(): { seed: number; s: GameSessionAdapter } {
  for (let seed = 1; seed <= 60; seed++) {
    const s = playUntilSpectatorChoice(seed);
    if (s) return { seed, s };
  }
  throw new Error("no seed in 1..60 evicted the (auto-played) player before the jury formed");
}

function outcome(core: SessionCore) {
  const l = core.live!;
  return { winner: l.winner, finalTwo: l.finalTwo, jury: l.jury, order: l.evictionOrder, finished: l.finished, week: l.week };
}

function finishOnPlayerless(s: GameSessionAdapter, choose: "watch" | "skip" = "watch"): void {
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending, choose);
    if (v.finished) return;
  }
  throw new Error("season did not resolve");
}

describe("0133 — the spectator choice is a card with exactly two options, raised once", () => {
  it("a pre-jury eviction raises `spectator-choice` offering watch and skip", () => {
    const { s } = findEarlyEvictionSession();
    const p = s.getGameState().pending!;
    expect(p.kind).toBe("spectator-choice");
    expect(p.options.map((o) => o.id)).toEqual([...SPECTATOR_MODES]);
    expect(s.getGameState().player!.status).toBe("evicted");
  });

  it("the offer is one-time: after answering, it never reappears", () => {
    const { s } = findEarlyEvictionSession();
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    const seen = new Set<string>();
    for (let i = 0; i < 400 && !s.getGameState().finished; i++) {
      const v = s.advanceGame();
      if (v.pending) { seen.add(v.pending.kind); resolve(s, v.pending); }
    }
    expect(seen.has("spectator-choice")).toBe(false);
  });

  it("an illegal mode is refused and the offer stays open", () => {
    const { s } = findEarlyEvictionSession();
    expect(() => s.submitDecision({ kind: "spectator-choice", vote: "teleport" })).toThrow();
    expect(s.getGameState().pending!.kind).toBe("spectator-choice");
  });

  it("the choice beat is inert (draws no rng, ticks no clock)", () => {
    expect(isInertBeat("spectator-choice")).toBe(true);
    expect(isInertBeat("finale-interview")).toBe(true);
  });
});

describe("0133 — watch is the engine's skeleton season; skip fast-forwards to the finale", () => {
  it("watch: each advance completes ONE week and the digest is public, named and recorded", () => {
    const { s } = findEarlyEvictionSession();
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    let prev = (s.getGameState().weekDigests ?? []).length;
    const evAtChoice = s.snapshot().live!.evictionOrder.length;
    let sawWeeks = 0;
    for (let i = 0; i < 60 && !s.getGameState().finished; i++) {
      const before = s.getGameState().week;
      const v = s.advanceGame();
      if (v.pending) { resolve(s, v.pending); continue; }
      const digests = s.getGameState().weekDigests ?? [];
      if (digests.length > prev) {
        sawWeeks += 1;
        // one line per completed EVICTION NIGHT: usually one per advance, two across a reactive double-eviction week (two nights under one week number)
        expect(digests.length - prev).toBeGreaterThanOrEqual(1);
        expect(digests.length - prev).toBeLessThanOrEqual(2);
        const d = digests[digests.length - 1]!;
        expect(Object.keys(d).sort()).toEqual(["evicted", "hoh", "juryCount", "nominees", "vetoHolder", "vetoUsed", "week"]);
        expect(d.hoh === null || typeof d.hoh.name === "string").toBe(true);
        expect(s.getGameState().week).toBeGreaterThanOrEqual(before);
        prev = digests.length;
      }
      if (s.snapshot().live!.beat === "finale") break;
    }
    expect(sawWeeks).toBeGreaterThan(0);
    // In total: one digest per eviction night after the player's own. A reactive BATTLE-BACK voids a juror's eviction (they leave the eviction record) but the
    // public history keeps the night's digest, and their later re-eviction is a new night — so with a battle-back the digests may exceed the CURRENT eviction
    // record by up to two (the voided night + its repeat); with none it is EXACT.
    const live = s.snapshot().live!;
    const bb = (live.firedTwists ?? []).filter((t) => t.kind === "battle-back").length;
    const total = (s.getGameState().weekDigests ?? []).length;
    const evictionsAfter = live.evictionOrder.length - evAtChoice;
    if (bb === 0) expect(total).toBe(evictionsAfter);
    else { expect(total).toBeGreaterThanOrEqual(evictionsAfter); expect(total).toBeLessThanOrEqual(evictionsAfter + 2 * bb); }
    expect(s.getGameState().player!.spectator).toBe("watch");
  });

  it("skip: ONE advance lands at the finale and the skipped weeks' digests are readable", () => {
    const { s } = findEarlyEvictionSession();
    s.submitDecision({ kind: "spectator-choice", vote: "skip" });
    const v = s.advanceGame();
    expect(v.pending === null || v.pending === undefined || v.pending.kind !== "spectator-choice").toBe(true);
    const live = s.snapshot().live!;
    expect(live.beat === "finale" || !!live.finale).toBe(true);
    expect((s.getGameState().weekDigests ?? []).length).toBeGreaterThan(0);
    expect(s.getGameState().player!.spectator).toBe("skip");
  });

  it("watch can be switched to skip later; skip cannot go back; the offer cannot be repeated", () => {
    const { s } = findEarlyEvictionSession();
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    s.submitDecision({ kind: "spectator-choice", vote: "skip" });
    expect(s.getGameState().player!.spectator).toBe("skip");
    // refused with a typed EngineRefusal naming why (the narrator can tell the player), and nothing changes
    expect(() => s.submitDecision({ kind: "spectator-choice", vote: "watch" })).toThrow(EngineRefusal);
    expect(() => s.submitDecision({ kind: "spectator-choice", vote: "watch" })).toThrow(/irreversible/i);
    expect(s.getGameState().player!.spectator).toBe("skip");
  });
});

describe("0133 — the choice never changes the season (same rng, same winner)", () => {
  it("single-stepping, watching and skipping produce the identical evictions, finalists, jury and winner", () => {
    const { s } = findEarlyEvictionSession();
    const paused = s.snapshot();               // paused ON the spectator-choice pending
    const run = (mode: "single" | "watch" | "skip"): ReturnType<typeof outcome> => {
      const reg = new GameSessionRegistry();
      const t = reg.sandboxFor(`det${userSeq++}`).session;
      t.restore(JSON.parse(JSON.stringify(paused)) as SessionCore);
      if (mode === "single") {
        // pre-feature behavior: the offer is answered-and-ignored (no fast-forward state), beats stepped one by one
        const live = t.snapshot();
        live.live!.pending = undefined; live.live!.spectatorOffered = true;
        t.restore(live);
      } else {
        t.submitDecision({ kind: "spectator-choice", vote: mode });
      }
      finishOnPlayerless(t, mode === "skip" ? "skip" : "watch");
      return outcome(t.snapshot());
    };
    const single = run("single"), watch = run("watch"), skip = run("skip");
    expect(single.finished).toBe(true);
    expect(watch).toEqual(single);
    expect(skip).toEqual(single);
  });
});

describe("0133 — the finale-night interview", () => {
  it("is raised AFTER the crowning, never blocks it, and moves no vote or winner", () => {
    const { s } = findEarlyEvictionSession();
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    let last: AdvanceView | null = null;
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      last = v;
      if (v.pending && v.pending.kind !== "finale-interview") resolve(s, v.pending);
      if (v.finished) break;
    }
    expect(last!.finished).toBe(true);
    const crowned = s.snapshot().live!;
    expect(crowned.winner).toBeTruthy();                           // crowned although the interview is unanswered
    expect(s.getGameState().pending!.kind).toBe("finale-interview");
    const before = JSON.stringify([crowned.winner, crowned.finalTwo, crowned.jury]);
    s.submitDecision({ kind: "finale-interview", vote: "defiant", statement: "I played my own game" });
    const after = s.snapshot().live!;
    expect(JSON.stringify([after.winner, after.finalTwo, after.jury])).toBe(before);
    expect(after.finaleInterview).toEqual({ stance: "defiant", message: "I played my own game" });
  });

  it("an illegal stance is refused; the answer reaches the retrospective", () => {
    const { s } = findEarlyEvictionSession();
    s.submitDecision({ kind: "spectator-choice", vote: "skip" });
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      if (v.pending && v.pending.kind !== "finale-interview") resolve(s, v.pending);
      if (v.finished) break;
    }
    expect(() => s.submitDecision({ kind: "finale-interview", vote: "smug" })).toThrow();
    s.submitDecision({ kind: "finale-interview", vote: "gracious", statement: "thank you all" });
    expect(s.seasonRetrospective()?.finaleInterview).toEqual({ stance: "gracious", message: "thank you all" });
  });
});

describe("0133 — who does NOT get the choice or the interview", () => {
  it("a self-evicted player forfeits all of it (0061)", () => {
    const s = newGame(7);
    s.advanceGame();
    s.requestSelfEviction();
    s.submitDecision({ kind: "self-evict", confirmed: true });
    const kinds = new Set<string>();
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      if (v.pending) { kinds.add(v.pending.kind); resolve(s, v.pending); }
      if (v.finished) break;
    }
    expect(kinds.has("spectator-choice")).toBe(false);
    expect(kinds.has("finale-interview")).toBe(false);
  });

  it("only a PRE-JURY evictee is offered it (a juror is a different experience)", () => {
    const order = Array.from({ length: 6 }, (_, i) => `npc:${i}` as never);
    const state = { evictionOrder: order, active: Array.from({ length: 10 }, (_, i) => `npc:${i + 6}` as never) };
    // cast 16 ⇒ the first 5 evictions are pre-jury
    expect(isPreJuryEvictee(state as never, order[0]!)).toBe(true);
    expect(isPreJuryEvictee(state as never, order[4]!)).toBe(true);
    expect(isPreJuryEvictee(state as never, order[5]!)).toBe(false);
    expect(isPreJuryEvictee(state as never, PLAYER)).toBe(false);
  });
});
