import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";

/** ORW-731: an old save (written before refusals saved their why-record, so with no decision-why or stated reasons) loads through the real restore path. A save-format test, not a played one (it edits a save file). */
describe("ORW-731: an old save without the why-records still loads", () => {
  it("a save written before the record existed (no decision-why, no stated reasons) still loads and plays on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "refused-why-old-"));
    try {
      const user = "refused-why-old", seed = 3;
      const rt = composeRuntime({ saveStore: new FileSaveStore(dir), seed });
      await (rt.registry.resolver()("player", user).callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" }) as Promise<unknown>);
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      for (const f of walk(dir).filter((x) => x.endsWith(".json"))) {
        const snap = JSON.parse(readFileSync(f, "utf8")) as { live?: Record<string, unknown> };
        if (snap.live) { delete snap.live["decisionWhy"]; delete snap.live["statedReasons"]; writeFileSync(f, JSON.stringify(snap)); }
      }
      const resumed = composeRuntime({ saveStore: new FileSaveStore(dir), seed });
      const status = await (resumed.registry.resolver()("player", user).callTool("gameStatus", {}) as Promise<{ week?: number }>);
      expect(status.week, "the old save resumed into a running game").toBeGreaterThanOrEqual(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);
});
