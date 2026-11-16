import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** ORW-426: the repository is public. ci/check_no_internal_details.py fails on a tracked file with an internal address, host name or a real user's /home path. */
const script = fileURLToPath(new URL("../../ci/check_no_internal_details.py", import.meta.url));

function run(files: Record<string, string>): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "no-internal-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = spawnSync("python3", [script, dir], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("no internal details in tracked files", () => {
  it.each([
    ["a lab LAN address", "see http://10.0.1.10/x", "internal LAN address"],
    ["a private address that is not a documented example", "ssh me@192.168.1.12", "private 192.168"],
    ["a real user's home path", "cd /home/alice/project", "/home path"],
    ["an internal host name", "run on proxnode04", "internal host name"],
  ])("fails on %s and names the kind, never the line", (_n, text, kind) => {
    const r = run({ "docs/a.md": text });
    expect(r.status).toBe(1);
    expect(r.out).toContain(kind);
    expect(r.out).toContain("docs/a.md:1");
    expect(r.out).not.toContain(text);
  });

  it("passes the documented examples, the SSRF block lists and the generic home paths", () => {
    const r = run({
      "docs/ok.md": "192.168.1.50 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12 /home/user/x /home/runner/work <user>@<host> ORW-414",
    });
    expect(r.status, r.out).toBe(0);
  });

  it("passes on the real tracked tree of this repository", () => {
    const r = spawnSync("python3", [script], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
