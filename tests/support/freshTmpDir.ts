import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temp dir that the test FILE removes itself when it finishes (afterAll), so it never outlives the run even if the per-run TMPDIR teardown is skipped (a killed run). */
const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
export function freshTmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
