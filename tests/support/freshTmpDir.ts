import { afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temp dir that the test FILE removes itself when it finishes (afterAll), so it never outlives the run even if the per-run TMPDIR teardown is skipped (a killed run). */
const made: string[] = [];
const perTest: string[] = [];
const rm = (d: string): void => {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
};
afterAll(() => {
  for (const d of made.splice(0)) rm(d);
  for (const d of perTest.splice(0)) rm(d);
});
// a full-season save folder is 150-290 MB; a file that makes one per test used to keep every one until the end of the FILE (and the run): tens of GB on a shared volume. A dir made with
// `testTmpDir` goes when its test ends.
afterEach(() => {
  for (const d of perTest.splice(0)) rm(d);
});
export function freshTmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
/** A temp dir for ONE test: removed as soon as that test finishes (use freshTmpDir for a dir that several tests of the file share). */
export function testTmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  perTest.push(d);
  return d;
}
/** Remove a temp dir now (a search that rejected a candidate must not keep its saves until the test ends). */
export function dropTmpDir(d: string): void {
  rm(d);
}
