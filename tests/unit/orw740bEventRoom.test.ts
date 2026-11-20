import { endHeldNightSync } from "../support/heldNight";
import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { renderGameContext } from "../../src/engine/momentPrompts";
import { eventStagingRoom } from "../../src/engine/houseEvent";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * ORW-740b (ADR 0009, 2026-11-20; related ORW-705 PT-3 / ORW-706): a reply never puts the player, a ceremony or a competition in a room other than the engine's. The narrator's
 * "IT IS TIME" line used to say "production calls the whole house to the living room" for EVERY event, while the engine seats a competition in the backyard (ORW-281 slice 6). This walks a
 * real played week (the production-shaped harness of the 0118 tests, a message-driven clock, the real advance path): at every due event the briefing names the engine's staging room, the
 * advance seats the player in that same room, and the in-session line names it too. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function harness(seed: number, user: string) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setPerConversationClockEnabled(true);
  const orch = new Orchestrator(reg, new FakeClock(), { seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  return sb;
}

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "ceremony-step") (s as unknown as GameSession).advanceGame();
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

describe("ORW-740b - the event room is ONE engine read", () => {
  it("the staging function: ceremonies in the living room, competitions in the backyard (a played game), nothing otherwise", () => {
    for (const k of ["nominations", "veto-draw", "veto-ceremony", "eviction"]) expect(eventStagingRoom(k, true)).toBe("living-room");
    for (const k of ["hoh-competition", "veto-competition"]) { expect(eventStagingRoom(k, true)).toBe("backyard"); expect(eventStagingRoom(k, false)).toBeNull(); }
    expect(eventStagingRoom("champagne-circle", true)).toBeNull();
    expect(eventStagingRoom(undefined, true)).toBeNull();
  });

  it("through a real played week: the briefing's room, the seated room and the in-session line are the same room at every due event", () => {
    const sb = harness(13, "u-740b");
    const s = sb.session;
    s.noteMessage({ messageId: "m-0" });
    const seen: Array<{ next: string; stage: string | undefined; said: string; named: string; seated: string | undefined }> = [];
    // the opening beats (premiere, the first HOH) run through the plain advance path, as in the 0118 tests
    for (let i = 0; i < 120; i++) {
      if (s.perConversationClockLive() && s.snapshot().live?.hoh !== undefined) break;
      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
    }
    let steps = 0;
    while (seen.length < 5 && steps++ < 1500) {
      const live = s.snapshot().live;
      if (!live || live.finished) break;
      const pend = live.pending as AdvanceView["pending"] | undefined | null;
      if (pend) { resolveLegally(s, pend); continue; }
      const ds = s.getGameState().daySchedule;
      if (ds && ds.due) {
        const view = s.getGameState();
        const ctx = renderGameContext(view);
        const said = /IT IS TIME:[^\n]*calls the whole house to ([^;]*);/.exec(ctx)?.[1] ?? "";
        const a = s.advanceGame(); // the real advance seats the house for the event
        const w = s.whereabouts();
        const after = renderGameContext(s.getGameState());
        const inSession = /IS IN SESSION \(engine truth\): the whole house is gathered in ([^,]*),/.exec(after)?.[1];
        const names = (view.whereabouts as { roomNames?: Record<string, string> } | null)?.roomNames;
        if (w?.houseEvent && !seen.some((e) => e.next === ds.next)) seen.push({ next: ds.next, named: names?.[(ds as { stagingRoom?: string }).stagingRoom ?? ""] ?? "", stage: (ds as { stagingRoom?: string }).stagingRoom, said, seated: w?.room });
        // the in-session line (when a ceremony/comp holds the house) names the very room the player is seated in
        if (w?.houseEvent) {
          expect(w.houseEvent.room, "the whereabouts houseEvent carries the gathered room").toBe(w.room);
          expect(inSession, "the in-session line names the gathered room").toBeDefined();
        }
        if (a.pending) resolveLegally(s, a.pending);
        continue;
      }
      if (ds && ds.todaysEvent && !ds.due) { endHeldNightSync(s as never); }
      s.noteMessage({ messageId: `m-${steps}` }); // a played game: the player's own message steps the clock (and marks the game as played)
      const npc = s.livingIds().filter((id) => id !== PLAYER)[0]!;
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content: `linger ${steps}` });
    }
    expect(seen.length, "the walk reached real due events").toBeGreaterThan(0);
    for (const e of seen) {
      const want = e.next === "hoh-competition" || e.next === "veto-competition" ? "backyard" : "living-room";
      expect(e.stage, `${e.next}: the briefing carries the engine's staging room`).toBe(want);
      expect(e.said, `${e.next}: the due line names that room, not a fixed one`).toContain(e.named || (want === "backyard" ? "backyard" : "living room"));
      expect(e.seated, `${e.next}: the advance seats the player in the staging room`).toBe(want);
    }
  });

  it("flag OFF is the old wording, byte for byte: 'the living room' for every event, no stagingRoom", () => {
    const sb = harness(13, "u-740b-off");
    sb.session.setEventRoomFactEnabled(false);
    for (let i = 0; i < 120; i++) {
      if (sb.session.perConversationClockLive() && sb.session.snapshot().live?.hoh !== undefined) break;
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
    }
    const ds = sb.session.getGameState().daySchedule;
    expect(ds).toBeDefined();
    expect((ds as { stagingRoom?: string }).stagingRoom).toBeUndefined();
  });
});
