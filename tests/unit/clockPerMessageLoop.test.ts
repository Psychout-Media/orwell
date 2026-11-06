import { toDayTwoMorning } from "../support/dayTwoMorning";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { MINUTES_PER_MESSAGE, MESSAGES_PER_MORNING } from "../../src/engine/sleepConstants";
import { milestoneDue, nextMilestone } from "../../src/engine/daySchedule";

/**
 * URGENT (Thursday, Coordinator 2026-11-05) - THE REAL LOOP bills ONE message-step per PLAYER MESSAGE, not per committed engine mutation (Ryne: ~5 in-game minutes a message, 3 messages
 * ~ 15 minutes). The earlier pace tests called `advanceClockPerConversation` directly, so nothing covered the real commit loop, where (a) a plain chat line with no tool call committed
 * nothing and advanced NOTHING, and (b) every auxiliary tool commit of one message billed its own step (two tool calls = 10 minutes).
 *
 * The contract: the front-end announces each player message once with the engine lever `noteMessage({ messageId })` (idempotent per id); the engine bills exactly MINUTES_PER_MESSAGE for
 * that id, however many commits the message then makes. This drives the production runtime (`composeRuntime`) through `callTool` - the same path the HTTP edge uses. Roles only.
 */
let n = 0;
interface Day { call: (name: string, args?: Record<string, unknown>) => Promise<unknown>; hour: () => number; live: () => ReturnType<GameSessionAdapter["snapshot"]>["live"] }
async function startedDay(): Promise<Day> {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const rt = composeRuntime({ clock: new FakeClock(), seed: 1 });
  const user = `cpm-${n++}`;
  const mcp = rt.registry.resolver()("player", user);
  const call = (name: string, args: Record<string, unknown> = {}): Promise<unknown> => mcp.callTool(name, args);
  await call("createCharacter", { playerName: "P", archetype: "floater", seed: 7 });
  const session = rt.registry.sandboxFor(user).session;
  session.setPerConversationClockEnabled(true);
  // the day-start (three advances: premiere exit -> the first NIGHT -> the first morning at 8am; ORW-116 a), as the other pace tests do
  toDayTwoMorning(session as GameSessionAdapter); // ORW-116: Day 2, 8am
  return { call, hour: () => session.snapshot().live?.nightDepth ?? 0, live: () => session.snapshot().live };
}

describe("the clock bills once per PLAYER MESSAGE through the real commit loop", () => {
  beforeEach(() => { /* per-test runtime; nothing shared */ });
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

  it("(a) 10 plain chat messages (no tool call) advance the clock 10 x 5 = 50 minutes", async () => {
    const g = await startedDay();
    const start = g.hour();
    for (let i = 0; i < 10; i++) {
      await g.call("noteMessage", { messageId: `m-a-${i}` });
      // the clock moves AFTER EACH plain message (not only after the 10th) - an event can come due mid-conversation
      expect((g.hour() - start) * 60, `after message ${i + 1}`).toBeCloseTo((i + 1) * MINUTES_PER_MESSAGE, 5);
    }
  });

  it("(b) one message that makes TWO tool calls advances 5 minutes, not 10", async () => {
    const g = await startedDay();
    const start = g.hour();
    await g.call("noteMessage", { messageId: "m-b" });
    await g.call("whereabouts");
    await g.call("diaryRoom", { entry: "a private thought" });
    await g.call("diaryRoom", { entry: "another private thought" });
    expect((g.hour() - start) * 60).toBeCloseTo(MINUTES_PER_MESSAGE, 5);
  });

  it("(c) one message with ONE tool call advances 5 minutes", async () => {
    const g = await startedDay();
    const start = g.hour();
    await g.call("noteMessage", { messageId: "m-c" });
    await g.call("diaryRoom", { entry: "a private thought" });
    expect((g.hour() - start) * 60).toBeCloseTo(MINUTES_PER_MESSAGE, 5);
  });

  it("is idempotent per message id: a retry / duplicate announcement bills nothing", async () => {
    const g = await startedDay();
    const start = g.hour();
    await g.call("noteMessage", { messageId: "m-dup" });
    await g.call("noteMessage", { messageId: "m-dup" });
    await g.call("noteMessage", { messageId: "m-dup" });
    expect((g.hour() - start) * 60).toBeCloseTo(MINUTES_PER_MESSAGE, 5);
  });

  it("(d) the event comes DUE exactly when the clock reaches the afternoon: one message earlier it is not, and the due gate flips on the step that reaches noon", async () => {
    const g = await startedDay();
    const ms = nextMilestone(g.live());
    expect(ms?.targetHour).toBe(12);
    // the day-start leaves the clock one step past 8:00; whole messages remaining until noon
    const needed = Math.round((12 - g.hour()) * 60 / MINUTES_PER_MESSAGE);
    expect(needed).toBeGreaterThan(MESSAGES_PER_MORNING - 3);
    for (let i = 0; i < needed - 1; i++) await g.call("noteMessage", { messageId: `m-d-${i}` });
    expect(milestoneDue(g.live()), "one message before noon").toBe(false);
    await g.call("noteMessage", { messageId: `m-d-${needed - 1}` });
    expect(g.hour()).toBeCloseTo(12, 5);
    expect(milestoneDue(g.live()), "the step that reaches noon").toBe(true);
  });

  it("the noted clock survives a reload: rebuild the runtime from the same store after 3 plain messages and the clock still reads +15 minutes (persist is covered by the commit path)", async () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const dir = mkdtempSync(join(tmpdir(), "cpm-store-"));
    try {
      const user = `cpm-reload-${n++}`;
      const rt1 = composeRuntime({ clock: new FakeClock(), seed: 1, saveStore: new FileSaveStore(dir) });
      const mcp1 = rt1.registry.resolver()("player", user);
      await mcp1.callTool("createCharacter", { playerName: "P", archetype: "floater", seed: 7 });
      rt1.registry.sandboxFor(user).session.setPerConversationClockEnabled(true);
      await mcp1.callTool("advanceGame", {});
      await mcp1.callTool("advanceGame", {});
      const hourOf = (rt: ReturnType<typeof composeRuntime>): number => rt.registry.sandboxFor(user).session.snapshot().live?.nightDepth ?? 0;
      const start = hourOf(rt1);
      for (let i = 0; i < 3; i++) await mcp1.callTool("noteMessage", { messageId: `m-r-${i}` });
      expect((hourOf(rt1) - start) * 60).toBeCloseTo(3 * MINUTES_PER_MESSAGE, 5);
      const rt2 = composeRuntime({ clock: new FakeClock(), seed: 1, saveStore: new FileSaveStore(dir) });
      expect((hourOf(rt2) - start) * 60, "after a reload from the same store").toBeCloseTo(3 * MINUTES_PER_MESSAGE, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a hang-out between two notes leaves no stale skip: the NEXT note still bills a full step (no free message after a hang-out)", async () => {
    const g = await startedDay();
    await g.call("noteMessage", { messageId: "m-h-1" });
    await g.call("hangOut", {});
    const afterHang = g.hour();
    await g.call("noteMessage", { messageId: "m-h-2" });
    expect((g.hour() - afterHang) * 60).toBeCloseTo(MINUTES_PER_MESSAGE, 5);
  });

  it("noteMessage returns the post-commit beatSeq, so the next progression call carrying it is not stale", async () => {
    const g = await startedDay();
    const r = (await g.call("noteMessage", { messageId: "m-bs-1" })) as { accepted: boolean; beatSeq: number };
    expect(r.accepted).toBe(true);
    expect(typeof r.beatSeq).toBe("number");
    await expect(g.call("advanceGame", { expectedBeatSeq: r.beatSeq })).resolves.toBeDefined();
  });

  it("P0g: the dedupe ring survives a restart - a retry of an already-billed message id bills nothing, and a new id still bills", async () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const dir = mkdtempSync(join(tmpdir(), "cpm-ring-"));
    try {
      const user = `cpm-ring-${n++}`;
      const rt1 = composeRuntime({ clock: new FakeClock(), seed: 1, saveStore: new FileSaveStore(dir) });
      const mcp1 = rt1.registry.resolver()("player", user);
      await mcp1.callTool("createCharacter", { playerName: "P", archetype: "floater", seed: 7 });
      rt1.registry.sandboxFor(user).session.setPerConversationClockEnabled(true);
      await mcp1.callTool("advanceGame", {});
      await mcp1.callTool("advanceGame", {});
      await mcp1.callTool("noteMessage", { messageId: "m-ring-1" });
      const rt2 = composeRuntime({ clock: new FakeClock(), seed: 1, saveStore: new FileSaveStore(dir) });
      const mcp2 = rt2.registry.resolver()("player", user);
      const s2 = rt2.registry.sandboxFor(user).session;
      s2.setPerConversationClockEnabled(true);
      const hour = (): number => s2.snapshot().live?.nightDepth ?? 0;
      const h0 = hour();
      const retry = (await mcp2.callTool("noteMessage", { messageId: "m-ring-1" })) as { accepted: boolean };
      expect(retry.accepted, "a retry after a restart").toBe(false);
      expect(hour()).toBeCloseTo(h0, 5);
      await mcp2.callTool("noteMessage", { messageId: "m-ring-2" });
      expect((hour() - h0) * 60).toBeCloseTo(MINUTES_PER_MESSAGE, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P0g: a save with no announcement carries no seenMessageIds key (old saves round-trip byte-identical)", async () => {
    const g = await startedDay();
    expect(JSON.stringify(g.live())).not.toContain("seenMessageIds");
  });

  it("without any noteMessage the engine keeps the legacy per-commit billing (BDD / UAT / tests that never announce a message are unchanged)", async () => {
    const g = await startedDay();
    const start = g.hour();
    await g.call("diaryRoom", { entry: "a private thought" });
    expect(g.hour()).toBeGreaterThan(start);
  });
});
