import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";

/**
 * ORW-731: a houseguest who REFUSES a deal writes why they refused (the decision-why and stated-reason records) into the live state, and the refusal used to save nothing: the record was kept in memory only until the next
 * commit, so a restart in between lost it (a lost record, not a reroll: consent is a keyed hash). The refusal now saves through the background write (no beat, no checkpoint, no tick).
 * REAL PATH: a deal refused through the real `makeDeal` lever, a restart through the real restore path (a new runtime over the same save folder); nothing is set by hand.
 */
describe("ORW-731 REAL PATH: a refused deal's why-record survives a restart", () => {
  it("the record written by the refusal is in the resumed game", async () => {
    const dir = mkdtempSync(join(tmpdir(), "refused-why-"));
    try {
      const user = "refused-why-user", seed = 3;
      const rt = composeRuntime({ saveStore: new FileSaveStore(dir), seed });
      const call = (n: string, a: Record<string, unknown>): Promise<any> => rt.registry.resolver()("player", user).callTool(n, a) as Promise<any>;
      await call("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
      const whyCount = (r: ReturnType<typeof composeRuntime>): number => ((r.registry.sandboxFor(user).session as any).live?.decisionWhy ?? []).filter((w: { kind?: string }) => w.kind === "deal-consent").length;
      const wa = await call("whereabouts", {});
      const others: string[] = (wa?.present ?? []).map((x: { id: string }) => x.id).filter((id: string) => id !== "player");
      let refused = 0;
      // stop at the FIRST consent refusal: the last thing the game did is the refusal, so no later commit can save its record for it
      for (const npc of others) {
        for (const kind of ["final-two", "safety", "vote"]) {
          if (refused > 0) break;
          const r = await call("makeDeal", { with: npc, kind, terms: "let's look after each other" });
          if (r && r.refused === true && r.illegal === undefined) refused++;
        }
      }
      expect(refused, "the real lever refused at least one deal on consent").toBeGreaterThan(0);
      const before = whyCount(rt);
      expect(before).toBeGreaterThan(0);
      const resumed = composeRuntime({ saveStore: new FileSaveStore(dir), seed });
      expect(whyCount(resumed), "the why-record written by the refusals is still there after a restart").toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);
});
