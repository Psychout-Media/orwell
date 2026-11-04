import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Guard for the /tmp leak (Coordinator 2026-11-04): the suite must run under ONE private per-run TMPDIR (removed by the global teardown), so any test's
 * `mkdtemp(join(tmpdir(), "orwell-..."))` - cleaned up or not - can never accumulate in the host /tmp. Fails if the global setup is dropped from vitest.config.ts.
 */
describe("the test run owns a private, auto-removed TMPDIR", () => {
  it("os.tmpdir() is the per-run directory, and a mkdtemp lands inside it", () => {
    expect(basename(tmpdir())).toMatch(/^orwell-run-/);
    const d = mkdtempSync(join(tmpdir(), "orwell-leaky-test-"));
    expect(existsSync(d)).toBe(true);
    expect(dirname(d)).toBe(tmpdir());
  });
});
