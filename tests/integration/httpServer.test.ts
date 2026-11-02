import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server, AddressInfo } from "node:net";
import { createHttpMcpServer } from "../../src/adapters/mcp/HttpMcpServer";
import { buildMcpServers } from "../../src/composition/appRoot";
import { bootFlagKeys } from "../../src/featureFlags";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createHttpMcpServer(buildMcpServers());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("HTTP MCP entrypoint (runnable engine)", () => {
  it("serves a health endpoint with uptime, counters, the failure ring, and embeddings status (G1)", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(typeof body["uptimeSeconds"]).toBe("number");
    expect(body["toolCalls"]).toMatchObject({ total: expect.any(Number), failed: expect.any(Number) });
    expect(Array.isArray(body["recentFailures"])).toBe(true);
    // no embeddingsStatus wired in this test ⇒ the deterministic, non-degraded default
    expect(body["embeddings"]).toEqual({ provider: "deterministic", degraded: false });
    // B2 (DEPLOY-12): the boot-time behavioral-flags block is present with every known layer as a
    // boolean — a pure env read (no game data / no Vault), so an operator can see what's live.
    const flags = body["flags"] as Record<string, unknown>;
    expect(flags, "the /health flags block is present").toBeTruthy();
    const expectedFlagKeys = bootFlagKeys();
    for (const k of expectedFlagKeys) {
      expect(typeof flags[k], `flags.${k} is a boolean`).toBe("boolean");
    }
    // Verify showrunner (one of the G9 flags that were missing before #1843) is in the registry
    expect(expectedFlagKeys).toContain("showrunner");
  });

  it("records a failed tool call in the /health ring — tool name + error class + timing, never args (G1)", async () => {
    const sentinel = "RING-SENTINEL-the-payload-that-must-not-leak";
    const res = await fetch(`${base}/player/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "inspectNonVaultState", args: { note: sentinel } }), // admin tool on player channel → refused
    });
    expect(res.status).toBe(400);

    const health = (await (await fetch(`${base}/health`)).json()) as {
      recentFailures: Array<{ ts: number; tool: string; errorClass: string; durationMs: number }>;
      toolCalls: { failed: number };
    };
    expect(health.toolCalls.failed).toBeGreaterThanOrEqual(1);
    const entry = health.recentFailures.find((f) => f.tool === "inspectNonVaultState");
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual(["durationMs", "errorClass", "tool", "ts"]);
    expect(typeof entry!.errorClass).toBe("string");
    expect(entry!.durationMs).toBeGreaterThanOrEqual(0);
    // the Vault rule: no args, no payloads, no error MESSAGES cross into /health
    expect(JSON.stringify(health)).not.toContain(sentinel);
  });

  it("exposes the player allowlist, all readsVault:false", async () => {
    const { tools } = (await (await fetch(`${base}/player/tools`)).json()) as { tools: Array<{ readsVault: boolean }> };
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.readsVault === false)).toBe(true);
  });

  it("dispatches moveHouseguest → recordHouseguestMove and validates its args (ADR 0009)", async () => {
    // Wired + routed: the call returns a HouseguestMoveResult ({status}). On this fresh (no-game)
    // server the legal-only contract yields "illegal", which proves the dispatch reached
    // recordHouseguestMove (rather than erroring as an unknown tool).
    const ok = await fetch(`${base}/player/call`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "moveHouseguest", args: { id: "npc:1", room: "kitchen" } }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { result?: { status?: string }; status?: string };
    const result = body.result ?? body;
    expect(["moved", "noop", "illegal"]).toContain(result.status);
    // Arg validation mirrors moveTo: a missing/non-string id is a clean 400 allowlist refusal.
    const bad = await fetch(`${base}/player/call`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "moveHouseguest", args: { room: "kitchen" } }),
    });
    expect(bad.status).toBe(400);
  });

  it("refuses a caller-supplied-stats competition resolution over HTTP (E20 — runCompetition is the one authority)", async () => {
    const res = await fetch(`${base}/player/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "resolveCompetition",
        args: {
          type: "endurance",
          participants: [
            { id: "player", stats: { physical: 0.5, mental: 0.5, social: 0.5 } },
            { id: "npc:1", stats: { physical: 0.6, mental: 0.5, social: 0.5 } },
          ],
          intents: [], seed: 1,
        },
      }),
    });
    expect(res.status).toBe(400); // an allowlist refusal, not an outcome
    const body = (await res.json()) as { error?: string; result?: unknown };
    expect(body.error).toMatch(/not available/);
    expect(body.result).toBeUndefined(); // no winner ever crosses from a seed-shopped resolution
  });

  it("onboards over HTTP: createCharacter -> getGameState -> getMomentPrompt (the front-end path)", async () => {
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}/player/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, args }),
      });
      const { result } = (await res.json()) as { result: Record<string, unknown> };
      return result;
    };

    const started = await call("createCharacter", { playerName: "The Player", seed: 7 });
    expect(started["started"]).toBe(true);
    expect((started["house"] as unknown[]).length).toBe(15);

    const state = await call("getGameState", {});
    expect((state["player"] as { name: string }).name).toBe("The Player");

    const prompt = await call("getMomentPrompt", { moment: "premiere" });
    expect(typeof prompt["systemPrompt"]).toBe("string");
    expect(prompt["systemPrompt"] as string).toContain("Big Brother");
  });

  it("rejects an admin tool on the player channel", async () => {
    const res = await fetch(`${base}/player/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "inspectNonVaultState", args: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe("/health reports the LIVE clock, not just the boot env", () => {
  it("flags.timeOfDay follows the wired runtime status", async () => {
    let live = false;
    const srv = createHttpMcpServer(buildMcpServers(), { timeOfDayStatus: () => live });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/health`;
    try {
      const read = async () => ((await (await fetch(url)).json()) as { flags: Record<string, boolean> }).flags;
      expect((await read()).timeOfDay).toBe(false);
      live = true; // the FE flipped the clock on at runtime
      expect((await read()).timeOfDay).toBe(true);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
