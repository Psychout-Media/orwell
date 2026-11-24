import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/**
 * ORW-844 - `snapshotLite()` is what the per-message hooks read instead of a whole `snapshot()` (a full copy of the live loop, about a megabyte late in a season): every value in it is the one `snapshot()`
 * carries, at every point of a played game (before the house exists, in the premiere, after evictions). Real path: a played game through the player channel; nothing is set by hand. Roles only.
 */
describe("snapshotLite carries exactly the snapshot's values", () => {
  it("started, week, phase, seed, worldAvoid, the house and who has left are equal to the full snapshot's, message after message", async () => {
    const reg = composeRuntime({ clock: new FakeClock(), seed: 11 }).registry;
    const user = "lite-844";
    const mcp = reg.resolver()("player", user);
    const sess = (): any => reg.sandboxFor(user).session; // eslint-disable-line @typescript-eslint/no-explicit-any
    const same = (when: string): void => {
      const full = sess().snapshot(), lite = sess().snapshotLite();
      expect(lite.started, when).toBe(full.started);
      expect(lite.week, when).toBe(full.week);
      expect(lite.phase, when).toBe(full.phase);
      expect(lite.seed, when).toBe(full.seed);
      expect(JSON.stringify(lite.worldAvoid ?? null), when).toBe(JSON.stringify(full.worldAvoid ?? null));
      expect(JSON.stringify(lite.house), when).toBe(JSON.stringify(full.house));
      expect(JSON.stringify(lite.live?.evictionOrder ?? []), when).toBe(JSON.stringify(full.live?.evictionOrder ?? []));
      expect(lite.live === null, when).toBe(full.live === null);
    };
    same("before any character");
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 11, archetype: "floater" });
    same("character created");
    for (let i = 0; i < 360; i++) {
      await mcp.callTool("noteMessage", { messageId: `m${i}` });
      if (i % 6 === 5) {
        const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> } };
        if (adv.pending) {
          const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
          try { await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) }); } catch { /* the next loop advances */ }
        }
      }
      if (i % 40 === 0) same(`message ${i}`);
    }
    same("after play");
  }, 300_000);
});
