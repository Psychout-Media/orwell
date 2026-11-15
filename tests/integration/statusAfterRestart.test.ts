import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, AddressInfo } from "node:net";
import { composeRuntime } from "../../src/composition/runtime";
import { createHttpMcpServer } from "../../src/adapters/mcp/HttpMcpServer";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/** Every update restarts the engine over the same save: the public status must carry the saved part of day immediately, before any new player message (the header read "Week 1  Premiere" with nothing after it). Real object graph behind the HTTP entrypoint, a new runtime over the same save dir. Roles only. */
async function boot(dir: string): Promise<{ server: Server; post: (name: string, args?: Record<string, unknown>) => Promise<any> }> {
  const runtime = composeRuntime({ clock: new FakeClock(), saveStore: new FileSaveStore(dir) });
  const server = createHttpMcpServer({ resolve: runtime.registry.resolver() });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`${base}/player/call`, { method: "POST", headers: { "content-type": "application/json", "x-orwell-user": "restart-user" }, body: JSON.stringify({ name, args }) });
    return ((await r.json()) as { result?: any }).result;
  };
  return { server, post };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe("the status after an engine restart over a saved game", () => {
  it("carries the saved part of day and day number before any new player message, and keeps following the clock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-status-restart-"));
    const a = await boot(dir);
    await a.post("updateCasting", { playerName: "The Player", motivation: "to outlast the house", interviewNotes: ["one", "two"] });
    await a.post("createCharacter", { playerName: "The Player" });
    for (let i = 0; i < 4; i++) await a.post("noteMessage", { messageId: `m${i}` });
    const before = await a.post("gameStatus");
    expect(before.timeOfDay).toBe("evening");
    const labelBefore = (await a.post("getGameState")).clockLabel as string;
    await close(a.server);

    const b = await boot(dir); // a new registry over the same save dir
    const after = await b.post("gameStatus"); // before any message
    expect(after.phase).toBe("premiere");
    expect(after.timeOfDay).toBe("evening");
    expect(after.dayNumber).toBe(1);
    expect((await b.post("getGameState")).clockLabel, "the saved clock itself came back, not only the preview").toBe(labelBefore);
    await b.post("noteMessage", { messageId: "after-restart" });
    expect((await b.post("gameStatus")).timeOfDay).toBe("evening");
    await close(b.server);
  });
});
