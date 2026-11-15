import { describe, it, expect, vi } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { runInToolCall, OUTSIDE_A_TOOL_CALL } from "../../src/ports/BeatCause";
import type { BeatLogView } from "../../src/ports/GameSession";

/**
 * ORW-439 - every beat-counter bump names the tool whose call caused it (diagnostic only; in memory; never saved).
 * Roles only. Each test drives production code: the real McpServer.callTool (which sets the cause context), the real commit
 * funnel (registry.commit -> GameSessionAdapter.bumpBeatSeq) and the real `beatLog` read. Where a test needs a tool that
 * commits twice or lands a commit later, it replaces ONE session method on the live instance and still goes through the real
 * server, context and funnel.
 */
async function game() {
  const rt = composeRuntime({ clock: new FakeClock(), seed: 1 });
  const mcp = rt.registry.resolver()("player", "u");
  await mcp.callTool("createCharacter", { playerName: "P", archetype: "floater", seed: 7 });
  const session = rt.registry.sandboxFor("u").session;
  const npcs = session.livingIds().filter((i) => i !== "player");
  return { rt, mcp, session, npcs };
}
const log = (s: { beatLog(n: number): BeatLogView }, since: number): BeatLogView => s.beatLog(since);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("a committing tool call records one entry naming that tool", () => {
  it("diaryRoom (a real committing tool through the real funnel)", async () => {
    const { mcp, session } = await game();
    const before = session.beatSeqNow();
    await mcp.callTool("diaryRoom", { entry: "a private thought" });
    const v = log(session, before);
    expect(session.beatSeqNow()).toBeGreaterThan(before);
    expect(v.truncated).toBe(false);
    expect(v.bumps.length).toBe(session.beatSeqNow() - before);
    expect(v.bumps.every((b) => b.tool === "diaryRoom")).toBe(true);
    expect(v.bumps.map((b) => b.seq)).toEqual(Array.from({ length: v.bumps.length }, (_, i) => before + 1 + i));
    expect(v.beatSeq).toBe(session.beatSeqNow());
  });

  it("a tool that commits twice records two entries naming it", async () => {
    const { mcp, session } = await game();
    vi.spyOn(session, "noteMessage").mockImplementation((() => { session.bumpBeatSeq(); session.bumpBeatSeq(); return { accepted: true, beatSeq: 0 }; }) as never);
    const before = session.beatSeqNow();
    await mcp.callTool("noteMessage", { messageId: "m-1" });
    expect(log(session, before).bumps.map((b) => b.tool)).toEqual(["noteMessage", "noteMessage"]);
  });
});

describe("attribution survives async interleaving, deferral and no-context commits", () => {
  it("two tool calls in flight at once each get their own name", async () => {
    const { mcp, session } = await game();
    let openA!: () => void; let openB!: () => void;
    const gateA = new Promise<void>((r) => { openA = r; });
    const gateB = new Promise<void>((r) => { openB = r; });
    vi.spyOn(session, "noteMessage").mockImplementation((async () => { await gateA; session.bumpBeatSeq(); return { accepted: true }; }) as never);
    vi.spyOn(session, "turnIn").mockImplementation((async () => { await gateB; session.bumpBeatSeq(); return { ok: true }; }) as never);
    const before = session.beatSeqNow();
    const a = mcp.callTool("noteMessage", { messageId: "m-a" });
    const b = mcp.callTool("turnIn", {});
    openB(); await tick(); // B commits first although A started first
    openA();
    await Promise.all([a, b]);
    expect(log(session, before).bumps.map((x) => [x.seq, x.tool])).toEqual([[before + 1, "turnIn"], [before + 2, "noteMessage"]]);
  });

  it("a commit outside any tool call is recorded as outside-a-tool-call", async () => {
    const { session } = await game();
    const before = session.beatSeqNow();
    session.bumpBeatSeq();
    expect(log(session, before).bumps.map((b) => b.tool)).toEqual([OUTSIDE_A_TOOL_CALL]);
    expect(OUTSIDE_A_TOOL_CALL).toBe("outside-a-tool-call");
  });

  it("a commit that lands AFTER its tool call returned is still attributed to that tool", async () => {
    const { mcp, session } = await game();
    vi.spyOn(session, "noteMessage").mockImplementation((() => { setTimeout(() => session.bumpBeatSeq(), 0); return { accepted: true }; }) as never);
    const before = session.beatSeqNow();
    await mcp.callTool("noteMessage", { messageId: "m-late" });
    expect(session.beatSeqNow()).toBe(before); // the call has returned and nothing has committed yet
    await tick();
    expect(session.beatSeqNow()).toBe(before + 1);
    expect(log(session, before).bumps.map((b) => b.tool)).toEqual(["noteMessage"]); // asserted: attributed to the tool that started it
  });

  it("a nested context keeps the outermost tool", () => {
    const seen: string[] = [];
    runInToolCall("outer", () => runInToolCall("inner", () => { seen.push("ran"); }));
    expect(seen).toEqual(["ran"]);
  });
});

describe("the ring", () => {
  it("is bounded at 64 and reports truncated exactly when it no longer reaches back", async () => {
    const { session } = await game();
    const start = session.beatSeqNow();
    for (let i = 0; i < 70; i++) runInToolCall("bulk", () => session.bumpBeatSeq());
    const cur = session.beatSeqNow();
    expect(cur).toBe(start + 70);
    const all = log(session, 0);
    expect(all.bumps.length).toBe(64);
    expect(all.truncated).toBe(true);
    expect(all.bumps[0]!.seq).toBe(cur - 63);
    const edge = log(session, cur - 64);
    expect(edge.truncated).toBe(false);
    expect(edge.bumps.length).toBe(64);
    expect(log(session, cur - 65).truncated).toBe(true);
    const none = log(session, cur);
    expect(none.bumps).toEqual([]);
    expect(none.truncated).toBe(false);
  });

  it("a rolled-back commit does not remain in the log", async () => {
    const { rt, mcp } = await game();
    await mcp.callTool("diaryRoom", { entry: "kept" });
    const baseSeq = rt.registry.sandboxFor("u").session.beatSeqNow();
    // A genuine refusal: the durable save fails, so the orchestrator rolls the sandbox back via registry.restore(baseline).
    const save = vi.spyOn(rt.registry, "saveUser").mockImplementation(() => { throw new Error("disk"); });
    await expect(mcp.callTool("diaryRoom", { entry: "refused" })).rejects.toThrow();
    save.mockRestore();
    const s = rt.registry.sandboxFor("u").session;
    expect(s.beatSeqNow()).toBe(baseSeq); // the counter was rolled back...
    const v = log(s, 0);
    expect(v.bumps.every((b) => b.seq <= baseSeq)).toBe(true); // ...and so was the log
    expect(v.bumps.some((b) => b.seq === baseSeq && b.tool === "diaryRoom")).toBe(true); // earlier history is carried across the rebuild
    expect(v.beatSeq).toBe(baseSeq);
    // a later commit is attributed correctly and reuses the rolled-back seq number exactly once
    const m2 = rt.registry.resolver()("player", "u");
    await m2.callTool("diaryRoom", { entry: "after" });
    expect(log(s, baseSeq).bumps.map((b) => [b.seq, b.tool])).toEqual([[baseSeq + 1, "diaryRoom"]]);
  });
});

describe("the beatLog read tool", () => {
  it("does not bump, save or change state; its result for a fixed state is stable", async () => {
    const { rt, mcp, session } = await game();
    await mcp.callTool("diaryRoom", { entry: "x" });
    const save = vi.spyOn(rt.registry, "saveUser");
    const before = session.beatSeqNow();
    const events = rt.registry.sandboxFor("u").engine.events.count();
    const snapBefore = JSON.stringify(session.snapshot());
    const r1 = await mcp.callTool("beatLog", { sinceBeatSeq: 0 });
    const r2 = await mcp.callTool("beatLog", { sinceBeatSeq: 0 });
    expect(r2).toEqual(r1);
    expect(session.beatSeqNow()).toBe(before);
    expect(rt.registry.sandboxFor("u").engine.events.count()).toBe(events);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(session.snapshot())).toBe(snapBefore);
    expect((r1 as BeatLogView).beatSeq).toBe(before);
    expect((r1 as Record<string, unknown>)["beatSeq"]).toBe(before); // a read never gains an extra echoed token
  });

  it("requires a numeric sinceBeatSeq", async () => {
    const { mcp } = await game();
    await expect(mcp.callTool("beatLog", {})).rejects.toThrow(/sinceBeatSeq/);
    await expect(mcp.callTool("beatLog", { sinceBeatSeq: "0" })).rejects.toThrow(/sinceBeatSeq/);
  });

  it("is dispatchable on the player channel but not advertised to the model", async () => {
    const { rt } = await game();
    const mcp = rt.registry.resolver()("player", "u");
    expect(mcp.listTools().some((t) => t.name === "beatLog")).toBe(false);
  });
});

describe("diagnostic only: never persisted, nothing but seq/tool/at", () => {
  it("the session snapshot bytes are identical with and without ring entries", async () => {
    const { mcp, session } = await game();
    await mcp.callTool("diaryRoom", { entry: "x" });
    const withRing = JSON.stringify(session.snapshot());
    expect(session.beatLogEntries().length).toBeGreaterThan(0);
    session.adoptBeatLog([]); // empty the ring; no game state changes
    expect(session.beatLogEntries().length).toBe(0);
    expect(JSON.stringify(session.snapshot())).toBe(withRing);
    expect(withRing).not.toContain("outside-a-tool-call");
  });

  it("an entry holds exactly seq, tool and at", async () => {
    const { mcp, session } = await game();
    await mcp.callTool("diaryRoom", { entry: "secret-looking argument text" });
    session.bumpBeatSeq();
    const bumps = log(session, 0).bumps;
    expect(bumps.length).toBeGreaterThan(1);
    for (const b of bumps) {
      expect(Object.keys(b).sort()).toEqual(["at", "seq", "tool"]);
      expect(typeof b.at).toBe("number");
    }
    expect(JSON.stringify(bumps)).not.toContain("secret-looking");
  });

  it("a rolled-back bump that evicted the oldest ring entry gives that entry back (review of #2757)", async () => {
    const live = (await game()).session;
    const rebuilt = (await game()).session; // the restored copy: one bump behind
    for (let i = 0; i < 64; i++) { live.bumpBeatSeq(); rebuilt.bumpBeatSeq(); }
    const before = live.beatLog(0).bumps.map((x) => x.seq); // the full ring, as it was before the refused bump
    expect(before.length).toBe(64);
    live.bumpBeatSeq(); // the refused commit's bump: it evicts the oldest entry
    rebuilt.adoptBeatLog(live.beatLogEntries());
    expect(rebuilt.beatLog(0).bumps.map((x) => x.seq)).toEqual(before);
  });
});
