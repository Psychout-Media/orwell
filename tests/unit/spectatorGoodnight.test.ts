import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";

/**
 * ORW-351 (Ryne: one rule for every night). An evicted player WATCHING the season who says goodnight (the model calls `turnIn`) must end their night like any player's: the watched season moves on. It used to be a silent no-op for anyone who had left the
 * game, so a live week sat 90 turns on one night (5 minutes per goodnight) while the narrator narrated them asleep in the house. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") submit({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "exit-interview") submit({ kind: "exit-interview", vote: p.stances![0]! });
  else if (p.kind === "goodbye-message") submit({ kind: "goodbye-message", vote: p.options[0]!.id });
  else if (p.kind === "spectator-choice") submit({ kind: "spectator-choice", vote: "watch" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "finale-interview") submit({ kind: "finale-interview", vote: "gracious", statement: "good game" });
  else if (!p.options?.length) void s.advanceGame(); // a watch step (a staged ceremony beat): answered with advanceGame, not submitDecision
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

let seq = 0;
/** The repo's seed-search pattern: play until the auto-played player is voted out before the jury; return that session paused ON the watch choice, answered "watch". */
function earlyEvictedWatcher(): GameSessionAdapter {
  for (let seed = 1; seed <= 60; seed++) {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`sg${seq++}`).session;
    s.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      if (v.pending?.kind === "spectator-choice") { resolve(s, v.pending); return s; }
      if (v.pending) resolve(s, v.pending);
      if (v.finished) break;
    }
  }
  throw new Error("no seed in 1..60 evicted the (auto-played) player before the jury formed");
}

describe("a watching spectator's goodnight", () => {
  it("moves the watched season on, exactly as advancing it would", () => {
    const s = earlyEvictedWatcher();
    const digests = (): number => ((s as unknown as { live: { weekDigests?: unknown[] } }).live.weekDigests ?? []).length;
    const beatSeq0 = s.gameStatus().beatSeq, d0 = digests();
    const v = s.turnIn();
    expect(s.gameStatus().beatSeq, "the night passed: a committed mutation").toBeGreaterThan(beatSeq0);
    expect(digests(), "a watched week completed").toBeGreaterThan(d0);
    expect(v.held, "not refused").toBeUndefined();
  });

  it("is idempotent under a key (a retry replays, it does not run a second week)", () => {
    const s = earlyEvictedWatcher();
    const a = s.turnIn({ idempotencyKey: "k1" });
    const seqAfter = s.gameStatus().beatSeq;
    const b = s.turnIn({ idempotencyKey: "k1" });
    expect(b).toEqual(a);
    expect(s.gameStatus().beatSeq).toBe(seqAfter);
  });

  it("an active player's turnIn is untouched by the spectator branch (no spectator ⇒ the old path)", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`sg${seq++}`).session;
    s.createCharacter({ playerName: "P", seed: 3 });
    expect((s as unknown as { live: { spectator?: unknown } }).live.spectator).toBeUndefined();
    expect(() => s.turnIn()).not.toThrow();
  });
});
