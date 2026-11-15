import { describe, it, expect, afterEach, vi } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { SOCIETY_TICK_HOURS } from "../../src/engine/sleepConstants";

/**
 * ORW-393: at night every announced player message bumped `live.nightTurns`, which the loop fingerprint did not strip, so each night message read as a beat commit - an un-debounced,
 * always-ticking off-screen society tick (bypassing SOCIETY_TICK_HOURS), duplicating hidden events. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

type Sess = ReturnType<GameSessionRegistry["sandboxFor"]>["session"] & { noteMessage(r: { messageId: string }): unknown; messageModeNow(): boolean; advanceClockPerConversation(): void };

function setup(seed: number) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("u");
  const s = sb.session as unknown as Sess;
  s.createCharacter({ playerName: "The Player", seed });
  s.setPerConversationClockEnabled(true);
  const orch = new Orchestrator(reg, new FakeClock(), { seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  for (let i = 0; i < 120 && s.snapshot().live?.hoh === undefined; i++) {
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
  }
  expect(s.snapshot().live?.hoh, "the HOH was seated before the test runs").toBeDefined();
  return { s, orch };
}

describe("ORW-393 - night chat messages do not earn un-debounced society ticks", () => {
  it("N night messages inside one in-game hour run at most the debounced number of off-screen ticks", () => {
    const { s, orch } = setup(11);
    s.noteMessage({ messageId: "warm-0" }); // enter message mode
    expect(s.messageModeNow()).toBe(true);
    // let time pass (in-process clock steps) until it is night
    for (let i = 0; i < 400 && (s.snapshot().live as { nightDepth?: number } | undefined)?.nightDepth !== undefined && (s.snapshot().live as { nightDepth: number }).nightDepth < 20; i++) s.advanceClockPerConversation();
    const night0 = (s.snapshot().live as { nightDepth: number }).nightDepth;
    expect(night0).toBeGreaterThanOrEqual(20);
    const spy = vi.spyOn(orch, "advance");
    const N = 12; // 12 messages, 5 in-game minutes each = 1 in-game hour
    for (let i = 0; i < N; i++) s.noteMessage({ messageId: `night-${i}` });
    const live = s.snapshot().live as { nightDepth: number; nightTurns?: number };
    expect(live.nightTurns, "the messages really were night lingering").toBeGreaterThanOrEqual(N);
    const hours = live.nightDepth - night0;
    const ticks = spy.mock.calls.filter((c) => c[1] === "offscreen-tick").length;
    expect(hours).toBeLessThanOrEqual(SOCIETY_TICK_HOURS * 2);
    expect(ticks).toBeLessThanOrEqual(Math.ceil(hours / SOCIETY_TICK_HOURS) + 1);
  });
});
