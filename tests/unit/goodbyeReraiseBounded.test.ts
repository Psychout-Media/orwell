import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { AdvanceView, PendingDecisionView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-684 slice (a): the player's own goodbye is theirs to write (E34), so the engine raises the `goodbye-message` pending and waits. Asking to advance again
 * while it is open must RE-SHOW the same pending and nothing else: no event, no clock step, no new pending, however often it is asked (bounded: it can never
 * walk the season on, and never loops into something new); answering it then moves the eviction on. Roles only.
 */
const resolve = (s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void => {
  const pick = (): string => p.options?.[0]?.id as string;
  switch (p.kind as PendingDecisionView["kind"]) {
    case "nominations": s.submitDecision({ kind: "nominations", choice: [p.options![0]!.id, p.options![1]!.id] }); return;
    case "veto-decision": s.submitDecision({ kind: "veto-decision", use: false }); return;
    case "comp-intent": case "comp-round": s.submitDecision({ kind: p.kind, intent: "compete" } as never); return;
    case "goodbye-message": s.submitDecision({ kind: "goodbye-message", vote: pick() }); return;
    default: s.submitDecision({ kind: p.kind, vote: pick() } as never);
  }
};

describe("ORW-684: an open goodbye pending is re-shown, never re-raised into a loop", () => {
  it("advancing again while the goodbye is unanswered changes nothing, and answering it moves on", () => {
    const runtime = composeRuntime({ clock: new FakeClock() });
    const s = runtime.registry.sandboxFor("goodbye-bounded-81000").session;
    s.createCharacter({ playerName: "P", seed: 81000 });
    let view: AdvanceView = s.advanceGame();
    let guard = 0;
    while (view.pending?.kind !== "goodbye-message") {
      expect(view.finished, "the game finished before a goodbye pending").toBeFalsy();
      expect(guard++).toBeLessThan(1500);
      if (view.pending) resolve(s, view.pending);
      view = s.advanceGame();
    }
    const first = view.pending!;
    const events = () => runtime.registry.sandboxFor("goodbye-bounded-81000").engine.events.queryAll().length;
    const before = { events: events(), day: s.getGameState().dayNumber };
    for (let i = 0; i < 6; i++) {
      const again = s.advanceGame();
      expect(again.pending?.kind, `ask ${i + 1}`).toBe("goodbye-message");
      expect(again.pending?.options?.map((o) => o.id)).toEqual(first.options?.map((o) => o.id));
      expect(again.event, `ask ${i + 1} narrated something new`).toBeFalsy();
    }
    expect(events(), "re-asking recorded events").toBe(before.events);
    expect(s.getGameState().dayNumber).toBe(before.day);
    s.submitDecision({ kind: "goodbye-message", vote: first.options![0]!.id });
    const next = s.advanceGame();
    expect(next.pending?.kind === "goodbye-message" && next.pending.evictee === first.evictee && JSON.stringify(next.pending) === JSON.stringify(first), "answering did not move the eviction on").toBe(false);
  }, 120000);
});
