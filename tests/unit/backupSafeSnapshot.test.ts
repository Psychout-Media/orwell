import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

/** ORW-403 — backup takes a verified consistent copy of the live WAL database. */
const SCRIPT = join(process.cwd(), "deploy", "orwell-backup.sh");
const PY = `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA wal_autocheckpoint=0")
c.execute("CREATE TABLE t(v)"); c.executemany("INSERT INTO t VALUES (?)", [(i,) for i in range(50)]); c.commit()
# keep connection open (uncheckpointed WAL) until stdin closes
sys.stdout.write("ready\\n"); sys.stdout.flush(); sys.stdin.read()
`;
const READ = `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
print(c.execute("select count(*) from t").fetchone()[0], c.execute("pragma integrity_check").fetchone()[0])
`;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bk403-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT, join(root, "out")], { env: { ...process.env, APP_DIR: join(root, "app"), ...env }, encoding: "utf8" });
}

describe("orwell-backup.sh database snapshot (ORW-403)", () => {
  it("archives a consistent copy with uncheckpointed WAL rows, without sqlite3 CLI", async () => {
    const data = join(root, "app", "frontend", "data");
    mkdirSync(data, { recursive: true });
    mkdirSync(join(root, "app", "data"), { recursive: true });
    writeFileSync(join(data, "note.txt"), "x");
    const db = join(data, "app.db");
    const { spawn } = await import("node:child_process");
    const holder = spawn("python3", ["-c", PY, db], { stdio: ["pipe", "pipe", "inherit"] });
    await new Promise<void>((r) => holder.stdout!.once("data", () => r()));
    // PATH stripped of any sqlite3 CLI: only a dir with python3/bash/tar basics via symlinks
    const bin = join(root, "bin"); mkdirSync(bin);
    for (const t of ["bash", "python3", "tar", "gzip", "date", "mkdir", "stat", "id", "find", "wc", "tr", "chmod", "rm", "mktemp", "basename", "dirname", "env", "cat", "ls"]) {
      const w = spawnSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
      if (w) spawnSync("ln", ["-s", w, join(bin, t)]);
    }
    const r = run({ PATH: bin });
    holder.stdin!.end();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/checkpoint skipped/);
    const out = join(root, "out");
    const arch = readdirSync(out).find((f) => f.endsWith(".tar.gz"))!;
    const names = spawnSync("tar", ["-tzf", join(out, arch)], { encoding: "utf8" }).stdout;
    expect(names).not.toMatch(/app\.db-wal|app\.db-shm/);
    expect(names).toMatch(/frontend\/data\/app\.db$/m);
    expect(names).toMatch(/frontend\/data\/note\.txt/);
    const ex = join(root, "ex"); mkdirSync(ex);
    spawnSync("tar", ["-xzf", join(out, arch), "-C", ex]);
    const res = spawnSync("python3", ["-I", "-c", READ, join(ex, "frontend", "data", "app.db")], { encoding: "utf8" });
    expect(res.stdout.trim()).toBe("50 ok");
    expect(readdirSync(out).filter((f) => f.startsWith(".app.db.snapshot"))).toEqual([]);
  });

  it("prints the error and writes no backup when the database is corrupt", () => {
    const data = join(root, "app", "frontend", "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "app.db"), "not a database at all, just junk bytes ".repeat(200));
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/snapshot failed/);
    expect(r.stderr.length).toBeGreaterThan(30);
    const out = join(root, "out");
    expect(existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".tar.gz")) : []).toEqual([]);
    expect(existsSync(out) ? readdirSync(out).filter((f) => f.startsWith(".app.db.snapshot")) : [], "the failure path removes its temporary snapshot too").toEqual([]);
  });

  it("takes the snapshot inside its own temp directory (SQLite needs a journal beside it) and removes it", () => {
    const data = join(root, "app", "frontend", "data");
    mkdirSync(data, { recursive: true });
    const db = join(data, "app.db");
    const seed = spawnSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v)'); c.commit()", db], { encoding: "utf8" });
    expect(seed.status, `seeding the database failed: ${seed.stderr}`).toBe(0);
    expect(existsSync(db), "the seeded database exists").toBe(true);
    const bin = join(root, "pybin"); mkdirSync(bin);
    const real = spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    const log = join(root, "snap-path.log");
    writeFileSync(join(bin, "python3"), `#!/bin/bash\nprintf '%s\\n' "\${@: -1}" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const r = run({ PATH: `${bin}:${process.env.PATH}` });
    expect(r.status, r.stderr).toBe(0);
    const snap = readFileSync(log, "utf8").trim();
    expect(dirname(snap)).not.toBe(join(root, "out"));
    expect(dirname(dirname(snap))).toBe(join(root, "out"));
    expect(basename(dirname(snap))).toMatch(/^\.app\.db\.snapshot\./);
    expect(readdirSync(join(root, "out")).filter((f) => f.startsWith(".app.db.snapshot"))).toEqual([]);
  });
  it("sweeps an orphan snapshot of an earlier killed run, leaves the journal out, and archives the database owner-only (review of #2681, #2702)", () => {
    const data = join(root, "app", "frontend", "data");
    mkdirSync(data, { recursive: true });
    const db = join(data, "app.db");
    spawnSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v)'); c.commit()", db]);
    writeFileSync(join(data, "app.db-journal"), ""); // an empty journal is not hot, so the read-only snapshot still opens
    const out = join(root, "out"); mkdirSync(out);
    const orphan = join(out, ".app.db.snapshot.ORPHAN1"); mkdirSync(orphan);
    writeFileSync(join(orphan, "app.db"), "full copy left by a SIGKILL");
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    utimesSync(orphan, old, old);
    const r = spawnSync("bash", ["-c", `umask 022; exec bash '${SCRIPT}' '${out}'`], { env: { ...process.env, APP_DIR: join(root, "app") }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(orphan)).toBe(false);
    const arch = readdirSync(out).find((f) => f.endsWith(".tar.gz"))!;
    expect(spawnSync("tar", ["-tzf", join(out, arch)], { encoding: "utf8" }).stdout).not.toMatch(/app\.db-journal/);
    const listing = spawnSync("tar", ["-tvzf", join(out, arch)], { encoding: "utf8" }).stdout.split("\n").find((l) => /frontend\/data\/app\.db$/.test(l))!;
    expect(listing.slice(0, 10)).toBe("-rw-------");
  });
});
