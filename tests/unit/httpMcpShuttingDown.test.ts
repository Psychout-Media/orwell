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

describe("shutdown drains requests in flight (ORW-404)", () => {
  async function withDrainServer(
    tool: () => Promise<unknown>,
    fn: (base: string, server: ReturnType<typeof createHttpMcpServer>, setFlag: () => void) => Promise<void>,
  ): Promise<void> {
    let flag = false;
    const stub = { listTools: () => [], callTool: tool } as unknown as McpServer;
    const server = createHttpMcpServer({ resolve: () => stub }, { shuttingDown: () => flag });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, () => { flag = true; }); }
    finally { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); }
  }

  it("a slow request started before shutdown completes normally and exit is requested only after it finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const began = new Promise<void>((r) => { started = r; });
    await withDrainServer(async () => { started(); await gate; return { done: true }; }, async (base, server, setFlag) => {
      const order: string[] = [];
      const shutdown = createShutdown({
        onStart: setFlag,
        drain: () => server.drainInflight(5_000),
        flush: async () => { order.push("flush"); },
        exit: () => { order.push("exit"); },
        hardExitMs: 10_000,
        drainMs: 5_000,
      });
      const inflight = post(base, "/player/call");
      await began;
      const done = shutdown();
      await new Promise((r) => setTimeout(r, 150));
      expect(order).toEqual([]); // still draining: no flush, no exit
      expect((await post(base, "/player/call")).status).toBe(503); // new request during the drain
      release();
      const r = await inflight;
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ result: { done: true } });
      await done;
      expect(order).toEqual(["flush", "exit"]);
    });
  });

  it("a request stuck longer than the bound does not hold exit past the bound", async () => {
    let started!: () => void;
    const began = new Promise<void>((r) => { started = r; });
    await withDrainServer(async () => { started(); await new Promise(() => {}); return {}; }, async (base, server, setFlag) => {
      const order: string[] = [];
      const shutdown = createShutdown({
        onStart: setFlag,
        drain: () => server.drainInflight(60_000),
        flush: async () => { order.push("flush"); },
        exit: () => { order.push("exit"); },
        hardExitMs: 10_000,
        drainMs: 200,
      });
      void post(base, "/player/call").catch(() => undefined);
      await began;
      const t0 = Date.now();
      await shutdown();
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(order).toEqual(["flush", "exit"]);
    });
  });

  it("drainInflight resolves at once when nothing is in flight, and counts a request still reading its body", async () => {
    await withDrainServer(async () => ({}), async (base, server) => {
      await server.drainInflight(50);
      expect(server.inflightCount()).toBe(0);
      const net = await import("node:net");
      const port = Number(new URL(base).port);
      const sock = net.connect(port, "127.0.0.1");
      await new Promise<void>((r) => sock.on("connect", () => r()));
      sock.write("POST /player/call HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{");
      await new Promise((r) => setTimeout(r, 100));
      expect(server.inflightCount()).toBe(1);
      const t0 = Date.now();
      await server.drainInflight(150);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
      sock.destroy();
      await new Promise((r) => setTimeout(r, 100));
      expect(server.inflightCount()).toBe(0);
    });
  });
});

describe("shutdown drains JOBS, not only responses (review of #2747)", () => {
  it("a call whose response already closed (budget 503) but whose job still runs is awaited: its save is on disk and flushed before exit; a call after shutdown starts is refused", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FileSaveStore } = await import("../../src/adapters/engine/FileSaveStore");
    const dir = mkdtempSync(join(tmpdir(), "orw-drainjob-"));
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: async () => {}, syncDir: async () => {}, onError: () => {} });
    let flag = false;
    let started!: () => void;
    const began = new Promise<void>((r) => { started = r; });
    // The tool takes 1.2 s then saves; the response budget (100 ms) answers 503 long before, closing the response.
    const stub = { listTools: () => [], callTool: async () => { started(); await new Promise((r) => setTimeout(r, 1200)); store.saveFor("u", { started: true, week: 9, events: [] } as never); return {}; } } as unknown as McpServer;
    const server = createHttpMcpServer({ resolve: () => stub }, { shuttingDown: () => flag, responseBudgetMs: 100 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const order: string[] = [];
      const first = post(base, "/player/call");
      await began;
      expect((await first).status).toBe(503); // budget answered; response closed; job still running
      const shutdown = createShutdown({
        onStart: () => { flag = true; },
        drain: () => server.drainInflight(5_000),
        drainMs: 5_000,
        flush: async () => { order.push(`flush saved=${store.loadLatest("u") !== null}`); await store.flushDurableAsync(6_000); },
        exit: () => { order.push("exit"); },
        hardExitMs: 12_000, // drain 5 s + flush 6 s = 11 s < 12 s
      });
      const done = shutdown();
      expect((await post(base, "/player/call")).status).toBe(503); // refused after shutdown started
      await done;
      expect(order).toEqual(["flush saved=true", "exit"]);
      expect(store.durability().saveDurableVersion).toBe(1);
    } finally {
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createShutdown exits exactly once (review of #2744)", () => {
  it("the hard timer exits first, the flush returns later: exit is called once", async () => {
    let calls = 0;
    let finishFlush!: () => void;
    const shutdown = createShutdown({
      flush: () => new Promise<void>((r) => { finishFlush = r; }),
      exit: () => { calls++; },
      hardExitMs: 30,
    });
    const done = shutdown();
    await new Promise((r) => setTimeout(r, 80)); // the hard timer has fired
    expect(calls).toBe(1);
    finishFlush(); // the flush returns after the hard exit
    await done;
    expect(calls).toBe(1);
  });
});
