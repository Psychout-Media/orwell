import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playSeason, type SeasonRecord } from "../support/whatFired/player";
import { SHARED_CLONE_TOTALS } from "../../src/engine/sharedLiveClone";

/**
 * ORW-881: structure-shared live snapshots, on PLAYED seasons (the scripted talking player through the player channel on the production runtime; nothing is hand-set).
 *  1. Paranoid whole seasons: every snapshot also clones every shared key fresh and compares the bytes with the clone it would reuse (and the shared clones are frozen, so a consumer that writes a
 *     snapshot throws): zero differences, zero crashes. The reuse count proves the sharing actually happened.
 *  2. Byte identity: the whole snapshot's bytes after EVERY message, the season trace (state digests) and the durable save files are the same with the flag off, on, and commit-scoped.
 * Roles only.
 */
const ENV = "ORWELL_SHARED_SNAPSHOT";
const saved = process.env[ENV];
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

const sha = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);
const filesDigest = (dir: string): string => {
  const parts: string[] = [];
  const walk = (d: string): void => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else parts.push(`${p.slice(dir.length)}:${sha(readFileSync(p, "utf8"))}`); } };
  walk(dir);
  return parts.join("\n");
};

interface Run { rec: SeasonRecord; perMessage: string[]; files?: string }
async function play(mode: string | undefined, seed: number, o: { maxMessages: number; survive?: boolean; restartAt?: number; saveDir?: boolean; hashEvery?: number }): Promise<Run> {
  if (mode === undefined) delete process.env[ENV]; else process.env[ENV] = mode;
  const perMessage: string[] = [];
  const dir = o.saveDir ? mkdtempSync(join(tmpdir(), "orw881-")) : undefined;
  try {
    const rec = await playSeason({
      seed, user: `wf-881-${seed}`, maxMessages: o.maxMessages, ...(o.survive ? { survive: true } : {}), ...(dir ? { saveDir: dir } : {}), ...(o.restartAt !== undefined ? { restartAt: o.restartAt } : {}),
      watch: (ctx: any) => { if (ctx.msg % (o.hashEvery ?? 1) === 0) perMessage.push(sha(JSON.stringify(ctx.sess.snapshot()))); return false; }, // the WHOLE session core, saved bytes, key order included
    });
    return { rec, perMessage, ...(dir ? { files: filesDigest(dir) } : {}) };
  } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}

describe("ORW-881 shared live snapshots on played seasons", () => {
  for (const [seed, survive] of [[3, false], [11, false], [1, true]] as const) {
    it(`paranoid whole season, seed ${seed}${survive ? " (the player stays in)" : ""}: no difference from a fresh clone, no crash, and the clones were really shared`, async () => {
      const before = { ...SHARED_CLONE_TOTALS, divergences: SHARED_CLONE_TOTALS.divergences.length };
      const { rec } = await play("paranoid", seed, { maxMessages: survive ? 700 : 1500, survive, hashEvery: 5 });
      expect(SHARED_CLONE_TOTALS.divergences, "a write reached a shared key without going through its accessor").toEqual([]);
      expect(rec.crashes, "a tool threw (a paranoid difference or a frozen snapshot written would throw inside the commit)").toEqual([]);
      expect(SHARED_CLONE_TOTALS.compared - before.compared, "paranoid mode compared reused clones").toBeGreaterThan(500);
      expect(SHARED_CLONE_TOTALS.reused - before.reused, "clones were reused").toBeGreaterThan(500);
    }, 1_500_000);
  }

  it("the saved bytes after every message, the season trace and the durable save are identical with the flag off, on, and commit-scoped (seed 3, 350 messages)", async () => {
    const off = await play(undefined, 3, { maxMessages: 350, saveDir: true });
    for (const mode of ["1", "commit"]) {
      const on = await play(mode, 3, { maxMessages: 350, saveDir: true });
      expect(on.perMessage.length).toBe(off.perMessage.length);
      expect(on.perMessage, `mode ${mode}`).toEqual(off.perMessage);
      expect(on.rec.trace, `mode ${mode}`).toEqual(off.rec.trace);
      expect(on.files, `mode ${mode}: durable save files`).toBe(off.files);
    }
  }, 1_500_000);

  it("a restart in the middle of a season (state reloaded from the save) is byte-identical with the flag on (seed 11)", async () => {
    const off = await play(undefined, 11, { maxMessages: 260, saveDir: true, restartAt: 120 });
    const on = await play("1", 11, { maxMessages: 260, saveDir: true, restartAt: 120 });
    expect(on.perMessage).toEqual(off.perMessage);
    expect(on.rec.trace).toEqual(off.rec.trace);
    expect(on.files).toBe(off.files);
  }, 1_500_000);
});
