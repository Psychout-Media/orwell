import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** ORW-213 gate: every process-wide static override the adapter declares is reset after each cucumber scenario (features/support/resetStaticOverrides.ts), so a scenario cannot leak state into the next. */
describe("static test overrides cannot leak between scenarios", () => {
  const adapter = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
  const reset = readFileSync("features/support/resetStaticOverrides.ts", "utf8");
  const overrides = [...adapter.matchAll(/private static (\w+)Override: boolean \| null = null;/g)].map((m) => m[1]!);
  it("the adapter still declares static overrides (the pin is not vacuous)", () => { expect(overrides.length).toBeGreaterThanOrEqual(6); });
  it("each one has its public setter called with null in the after-scenario reset", () => {
    for (const name of overrides) {
      const setter = `set${name[0]!.toUpperCase()}${name.slice(1)}Enabled`;
      expect(adapter, `${setter} exists`).toContain(`static ${setter}(`);
      expect(reset, `${setter}(null) is in resetStaticOverrides.ts`).toContain(`${setter}(null)`);
    }
  });
});
