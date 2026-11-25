import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-791: on eviction night the player who has VOTED gets the same Continue step as everyone after their own vote card, and each press is one step. Before the fix the player's vote
 * left no open step at all (`pending` null), so the only thing that moved the ballots was their next typed message, and the front end then walked every remaining ballot in one turn
 * (a real-stack run showed 9 advances for one message). Real path: a played season (clock on) driven by the engine's own advance/decision calls to the player's own vote card, then
 * pressed one step at a time exactly as the Continue button does (a bare `advanceGame`). Roles only; no state is set by hand.
 */
type Any = Record<string, any>;
afterEach(() => { GameSessionAdapter.setTimeOfDayEnabled(null); });

function toTheVoteCard(seed: number): Any {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orw791-")))).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  for (let i = 0; i < 900; i++) {
    const p = s.advanceGame().pending ?? s.live.pending;
    if (!p) continue;
    if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0].id });
    else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
    else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0].id });
    else if (p.kind === "eviction-vote") break;
    // a ceremony watch step (the speeches) is answered by the next advanceGame of the loop
  }
  expect(s.live.pending?.kind, "the season reached the player's own vote card").toBe("eviction-vote");
  return s;
}

describe("ORW-791: Continue after the player's own eviction vote", () => {
  it("the vote card leaves a ballot watch step open; each Continue reads exactly one more ballot; the last ballot's Continue decides the vote", () => {
    const s = toTheVoteCard(5);
    const total: number = s.live.eviction?.revealOrder?.length ?? 0; // not begun yet: the vote card comes first
    expect(total).toBe(0);
    const first = s.submitDecision({ kind: "eviction-vote", vote: s.live.nominees[0] });
    expect(first.event?.beat).toBe("eviction-reveal");
    expect(first.pending, "the player who voted has a Continue step open").toMatchObject({ kind: "ceremony-step", ceremony: { kind: "eviction", stepId: "ballot" } });
    const of: number = s.live.eviction.revealOrder.length;
    expect(s.live.eviction.revealIx).toBe(1);

    for (let n = 2; n <= of; n++) {
      const v = s.advanceGame();
      expect(v.event?.beat, `press ${n} reads one ballot`).toBe("eviction-reveal");
      expect(s.live.eviction.revealIx, "one press = one ballot").toBe(n);
      expect(v.pending, `a Continue step stays open after ballot ${n}`).toMatchObject({ kind: "ceremony-step", ceremony: { stepId: "ballot" } });
      // E12: nothing on the open step names a voter or a tally
      expect(JSON.stringify(v.pending)).not.toMatch(/votedFor|tally|evictee/i);
    }
    expect(s.live.eviction.evictee, "no evictee until the press past the last ballot").toBeUndefined();
    const result = s.advanceGame();
    expect(result.event?.beat).toBe("eviction");
    expect(s.live.eviction?.evictee ?? result.eviction?.evictee).toBeDefined();
  });

  it("a ceremony step is answered by advanceGame, never submitDecision, so a typed answer cannot drive it", () => {
    const s = toTheVoteCard(5);
    s.submitDecision({ kind: "eviction-vote", vote: s.live.nominees[0] });
    const before = s.live.eviction.revealIx;
    expect(() => s.submitDecision({ kind: "ceremony-step" })).toThrow();
    expect(s.live.eviction.revealIx).toBe(before);
  });
});
