import { describe, it, expect, afterEach, vi } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { answerPending } from "../../features/support/answerPending";
import { SOCIETY_TICK_HOURS } from "../../src/engine/sleepConstants";
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
/**
 * ORW-939 (Overseer B): ORW-859's `dueHeldMessages` is written on every player message while the engine holds a due event's card, and it is not one of the chat-side keys the loop fingerprint strips. If a changing
 * key read as a beat commit, every held-card message would run an un-debounced off-screen tick and the house would wander off mid-conversation (the ORW-393 class). Played through the player channel to a held
 * comp-round card (nothing set by hand): five messages with the card open run at most the debounced number of off-screen ticks. Control (run once by hand): with `nightTurns` unstripped, the same spy sees 17 ticks
 * in one night hour, so the spy does see an un-debounced tick when there is one. Roles only.
 */
describe("ORW-939 a held card: player messages do not earn un-debounced society ticks", () => {
  it("five messages with the approach card open run at most the debounced number of off-screen ticks", () => {
    // ORW-1104: the seed is SCANNED (bounded), not pinned to 108: the first seed whose played season holds an approach card (a comp-round pending in week 2 or later) within 6000 messages.
    GameSessionAdapter.setTimeOfDayEnabled(true);
    let found: { s: any; orch: Orchestrator } | undefined; const tried: number[] = [];
    for (const seed of [108, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      if (found) break; tried.push(seed);
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor(`held-939-${seed}`);
      const s = sb.session as any;
      s.createCharacter({ playerName: "The Player", seed });
      s.setPerConversationClockEnabled(true);
      const orch = new Orchestrator(reg, new FakeClock(), { seed, turnDriven: true, auxTicksNever: true });
      reg.setCommit((u) => orch.commitPlayerTurn(u));
      reg.setOnReset((u) => orch.forgetUser(u));
      let m = 0, held = false;
      for (let i = 0; i < 6000 && !held; i++) {
        s.noteMessage({ messageId: `m${m++}` });
        const live = s.snapshot().live, g = s.getGameState();
        if (g.pending?.kind === "comp-round" && live.week >= 2) { held = true; break; }
        if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
        if (s.milestoneDue() || g.pending) { const v = s.advanceGame(); if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn(); continue; }
        if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
      }
      if (held) found = { s, orch };
    }
    expect(found, `an approach card is held on one of the seeds tried [${tried}]`).toBeDefined();
    const { s, orch } = found!;
    const spy = vi.spyOn(orch, "advance");
    const before = s.snapshot().live;
    for (let i = 0; i < 5; i++) s.noteMessage({ messageId: `h${i}` });
    const after = s.snapshot().live;
    const ticks = spy.mock.calls.filter((c) => c[1] === "offscreen-tick").length;
    const all = spy.mock.calls.map((c) => c[1]);
    const hours = Number(after.nightDepth ?? 0) - Number(before.nightDepth ?? 0);
    expect(after.dueHeldMessages, "the messages really were sent with the card held").toBeGreaterThanOrEqual(5);
    expect(all.filter((c) => c === "offscreen-tick").length).toBe(ticks);
    expect(ticks, `${ticks} off-screen ticks for 5 held-card messages (${hours.toFixed(2)} in-game hours)`).toBeLessThanOrEqual(Math.ceil(Math.max(hours, 0) / SOCIETY_TICK_HOURS) + 1);
  }, 900_000);
});
