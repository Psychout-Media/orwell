import { describe, it, expect, afterEach } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/**
 * ORW-881: the shared clones never outlive the state they were taken from. On a played game (through the player channel, nothing hand-set) with the flag on: a session `restore` (the rollback of a refused commit builds
 * a fresh sandbox the same way), the registry's rollback restore, and `resetUser` all start with no clones; an earlier snapshot is not changed by later play (the shared clones are read-only); and what is
 * saved after each is what a full clone gives. Roles only.
 */
const ENV = "ORWELL_SHARED_SNAPSHOT";
const saved = process.env[ENV];
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

describe("shared snapshot lifecycle", () => {
  it("restore, rollback and resetUser reset the clones; an earlier snapshot stays what it was", async () => {
    process.env[ENV] ??= "paranoid"; // frozen clones: a consumer that writes a snapshot throws
    const reg = composeRuntime({ clock: new FakeClock(), seed: 21 }).registry;
    const user = "shared-881";
    const mcp = reg.resolver()("player", user);
    const sess = (): any => reg.sandboxFor(user).session; // eslint-disable-line @typescript-eslint/no-explicit-any
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 21, archetype: "floater" });
    const play = async (from: number, to: number): Promise<void> => {
      for (let i = from; i < to; i++) {
        try { await mcp.callTool("noteMessage", { messageId: `m${i}` }); } catch (e) { throw new Error(`noteMessage ${i}: ${(e as Error).message}`); }
        if (i % 6 === 5) {
          const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> } };
          if (adv.pending) {
            const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
            try { await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) }); } catch { /* the next loop advances */ }
          }
        }
      }
    };
    await play(0, 90);
    const mid = reg.snapshot(user); const jm = JSON.stringify(mid);
    const s1 = sess().snapshot(); const j1 = JSON.stringify(s1);
    expect((sess().sharedSnapshotStats()?.reused ?? 1), "the clones were shared").toBeGreaterThan(0);
    await play(90, 150);
    expect(JSON.stringify(sess().snapshot()), "play moved the state").not.toBe(j1);
    expect(JSON.stringify(s1), "an earlier snapshot is not changed by later play").toBe(j1);
    expect(JSON.stringify(mid), "nor the registry's cached export").toBe(jm);

    reg.restore(user, mid); // the rollback of a refused commit: a fresh sandbox from the baseline
    expect(JSON.stringify(sess().snapshot().live), "after the registry rollback the live loop is the baseline's").toBe(JSON.stringify(JSON.parse(jm).live));
    expect((sess().sharedSnapshotStats()?.reused ?? 0), "a rolled-back sandbox starts with no shared clones").toBe(0);

    const here = sess().snapshot(); const jh = JSON.stringify(here);
    sess().restore(here); // a session restore of its own snapshot
    expect(JSON.stringify(sess().snapshot()), "after a session restore").toBe(jh);

    reg.resetUser(user);
    const fresh = sess().snapshot();
    expect(fresh.started, "a reset user has no season").toBe(false);
    expect(fresh.live).toBeNull();
    expect(JSON.stringify(s1), "and the old snapshots still read as they were").toBe(j1);
  }, 300_000);
});
