import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seen: string[] = [];
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return { ...actual, existsSync: (p: import("node:fs").PathLike) => { seen.push(String(p)); return actual.existsSync(p); } };
});

import { FileSaveStore, resetSaveSyncLimiterForTests } from "../../src/adapters/engine/FileSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/** ORW-404 follow-up 2: the directory existence check runs once per user directory per process, not on every save. Roles only. */
const snap = (n: number): SessionSnapshot => ({ started: true, week: n, events: [] }) as unknown as SessionSnapshot;
const dirs: string[] = [];
afterEach(() => { resetSaveSyncLimiterForTests(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("save path stats the user directory once per process", () => {
  it("existsSync(userDir) is called for the first save only", async () => {
    const data = mkdtempSync(join(tmpdir(), "orw404e-")); dirs.push(data);
    const store = new FileSaveStore(data, { fsyncMode: "background", syncFile: async () => {}, syncDir: async () => {} });
    const userDir = join(data, Buffer.from("a", "utf8").toString("hex"));
    seen.length = 0;
    for (let i = 1; i <= 6; i++) store.saveFor("a", snap(i));
    expect(seen.filter((p) => p === userDir)).toHaveLength(1);
    await new Promise<void>((r) => setImmediate(r));
  });
});
