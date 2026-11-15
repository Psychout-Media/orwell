import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/** Review of #2747: the non-degradation baseline follows the sandbox's in-memory life. */
const baselines = (rt: ReturnType<typeof composeRuntime>) => (rt.orchestrator as unknown as { baselines: Map<string, unknown> }).baselines;

describe("non-degradation baseline lifecycle", () => {
  it("an LRU-unloaded sandbox releases its baseline, and its from-disk resume re-baselines unconditionally", () => {
    const rt = composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orw-bl-"))), clock: new FakeClock(), maxResidentSandboxes: 2 });
    rt.registry.sandboxFor("u1").session.createCharacter({ playerName: "The Player", seed: 1 });
    rt.registry.sandboxFor("u2").session.createCharacter({ playerName: "The Player", seed: 2 });
    rt.registry.sandboxFor("u3").session.createCharacter({ playerName: "The Player", seed: 3 }); // unloads u1
    expect(rt.registry.usernames()).not.toContain("u1");
    expect(baselines(rt).has("u1"), "an unloaded user pins no snapshot").toBe(false);
    baselines(rt).set("u1", "STALE"); // a baseline left over from a previous object graph
    rt.registry.sandboxFor("u1"); // resume from disk
    expect(baselines(rt).get("u1")).not.toBe("STALE");
    expect(baselines(rt).get("u1")).toMatchObject({ started: true });
  });
});
