import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { createHttpMcpServer } from "../../src/adapters/mcp/HttpMcpServer";
import type { McpServer } from "../../src/adapters/mcp/McpServer";
import { createShutdown } from "../../src/composition/shutdown";

/** ORW-404 follow-up: once shutdown has begun, NEW tool calls get a retryable 503; /health answers; in-flight finish. Roles only. */
async function withServer(shuttingDown: () => boolean, tool: () => Promise<unknown>, fn: (base: string) => Promise<void>): Promise<void> {
  const stub = { listTools: () => [], callTool: tool } as unknown as McpServer;
  const server = createHttpMcpServer({ resolve: () => stub }, { shuttingDown });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); }
}
const post = (base: string, path: string) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "getGameState", args: {} }) });

describe("HTTP transport while shutting down", () => {
  it("answers a new /call with 503 + a retryable JSON body and never runs the tool", async () => {
    let ran = 0;
    await withServer(() => true, async () => { ran++; return {}; }, async (base) => {
      const r = await post(base, "/player/call");
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBeTruthy();
      expect(await r.json()).toMatchObject({ code: "engine-restarting", retryable: true });
      expect((await post(base, "/admin/call")).status).toBe(503);
      expect((await post(base, "/player/rpc")).status).toBe(503);
      expect(ran).toBe(0);
    });
  });

  it("/health keeps answering and reports shuttingDown; the static tool list still answers", async () => {
    await withServer(() => true, async () => ({}), async (base) => {
      const h = await fetch(`${base}/health`);
      expect(h.status).toBe(200);
      expect(await h.json()).toMatchObject({ ok: true, shuttingDown: true });
      expect((await fetch(`${base}/player/tools`)).status).toBe(200);
    });
  });

  it("serves normally when not shutting down, and /health says so", async () => {
    await withServer(() => false, async () => ({ ok: 1 }), async (base) => {
      expect((await post(base, "/player/call")).status).toBe(200);
      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ shuttingDown: false });
    });
  });

  it("a request already in progress when shutdown begins still finishes", async () => {
    let flag = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const began = new Promise<void>((r) => { started = r; });
    await withServer(() => flag, async () => { started(); await gate; return { done: true }; }, async (base) => {
      const inflight = post(base, "/player/call");
      await began;
      flag = true; // shutdown starts while the call is running
      expect((await post(base, "/player/call")).status).toBe(503);
      release();
      const r = await inflight;
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ result: { done: true } });
    });
  });

  it("a throwing probe never refuses traffic", async () => {
    await withServer(() => { throw new Error("probe"); }, async () => ({}), async (base) => {
      expect((await post(base, "/player/call")).status).toBe(200);
    });
  });
});

describe("createShutdown onStart", () => {
  it("runs onStart first (before the flush), once, even if it throws", async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      onStart: () => { order.push("start"); throw new Error("boom"); },
      flush: async () => { order.push("flush"); },
      exit: () => { order.push("exit"); },
      hardExitMs: 5_000,
    });
    await Promise.all([shutdown(), shutdown()]);
    expect(order).toEqual(["start", "flush", "exit"]);
  });
});
