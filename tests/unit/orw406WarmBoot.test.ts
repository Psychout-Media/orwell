// ORW-406 slice 3: a booted engine with a save warms WITHOUT a request, reports it, and a request that
// arrives mid-warm-up gets the same result from the same single load.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";

function seeded(): string {
  const dir = mkdtempSync(join(tmpdir(), "orw406-"));
  const rt = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
  rt.registry.sandboxFor("player-a");
  rt.registry.saveUser("player-a");
  return dir;
}
const boot = (dir: string) => composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock(), deferResume: true });

describe("ORW-406 warm before taking traffic", () => {
  it("reports not-warmed until the background warm-up finishes, with no request made", async () => {
    const rt = boot(seeded());
    expect(rt.warmStatus()).toEqual({ warmed: false, warmMs: null });
    expect(rt.registry.usernames()).toEqual([]);
    await rt.warmSaved();
    expect(rt.registry.usernames()).toEqual(["player-a"]);
    const s = rt.warmStatus();
    expect(s.warmed).toBe(true);
    expect(typeof s.warmMs).toBe("number");
  });

  it("a request during warm-up gets the same sandbox as the warm-up (one load)", async () => {
    const rt = boot(seeded());
    const warming = rt.warmSaved();
    const early = rt.registry.sandboxFor("player-a"); // arrives before warm-up reached it
    await warming;
    expect(rt.registry.sandboxFor("player-a")).toBe(early);
    expect(rt.registry.usernames()).toEqual(["player-a"]);
    expect(rt.warmStatus().warmed).toBe(true);
  });

  it("review of #2720: a sandbox a request resumes first already has a non-degradation baseline", () => {
    const rt = boot(seeded());
    const baselines = (rt.orchestrator as unknown as { baselines: Map<string, unknown> }).baselines;
    expect(baselines.has("player-a")).toBe(false);
    rt.registry.sandboxFor("player-a"); // the warm-up has not reached it; its first commit must be checked
    expect(baselines.has("player-a")).toBe(true);
  });

  it("no save means warm at once; an eager (non-deferred) boot is warm too", () => {
    const empty = composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orw406-"))), deferResume: true });
    expect(empty.warmStatus().warmed).toBe(true);
    expect(composeRuntime({}).warmStatus().warmed).toBe(true);
  });
});

import type { AddressInfo } from "node:net";
import { createHttpMcpServer } from "../../src/adapters/mcp/HttpMcpServer";

async function health(warmStatus?: () => { warmed: boolean; warmMs: number | null }): Promise<Record<string, unknown>> {
  const server = createHttpMcpServer({ resolve: () => { throw new Error("unused"); } }, { warmStatus });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("ORW-406 /health readiness", () => {
  it("reports warmed:false then warmed:true with the duration", async () => {
    expect(await health(() => ({ warmed: false, warmMs: null }))).toMatchObject({ ok: true, warmed: false, warmMs: null });
    expect(await health(() => ({ warmed: true, warmMs: 1234 }))).toMatchObject({ ok: true, warmed: true, warmMs: 1234 });
  });
  it("an engine with no probe wired, or a throwing probe, reports warmed (never wedges an updater)", async () => {
    expect(await health()).toMatchObject({ warmed: true });
    expect(await health(() => { throw new Error("x"); })).toMatchObject({ ok: true, warmed: true });
  });
});
