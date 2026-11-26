import { createHash } from "node:crypto";
import { playSeason } from "../tests/support/whatFired/player";

/**
 * ORW-881: per-message cost of `session.snapshot()` on a played season with ORWELL_SHARED_SNAPSHOT off / 1 / commit, same seed, plus saved-bytes equality.
 * Run: npx tsx scripts/measure-shared-snapshot.ts [seed] [messages] [repeats]
 * Timing wraps only the snapshot() calls the engine makes during play (the commit path); the byte hash every 25 messages is taken outside the timer.
 */
const seed = Number(process.argv[2] ?? 1), messages = Number(process.argv[3] ?? 900), repeats = Number(process.argv[4] ?? 3);
const sha = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

async function run(mode: string | undefined): Promise<{ snapMs: number; calls: number; wallMs: number; hashes: string[]; msgs: number }> {
  if (mode === undefined) delete process.env.ORWELL_SHARED_SNAPSHOT; else process.env.ORWELL_SHARED_SNAPSHOT = mode;
  let snapMs = 0, calls = 0, timing = true; const hashes: string[] = [];
  const t0 = performance.now();
  const rec = await playSeason({
    seed, user: `wf-881-measure-${seed}`, maxMessages: messages, survive: true,
    beforeCreate: (sess: any) => { const orig = sess.snapshot.bind(sess); sess.snapshot = () => { const t = performance.now(); const s = orig(); if (timing) { snapMs += performance.now() - t; calls++; } return s; }; },
    watch: (ctx: any) => { if (ctx.msg % 25 === 0) { timing = false; hashes.push(sha(JSON.stringify(ctx.sess.snapshot()))); timing = true; } return false; },
  });
  return { snapMs, calls, wallMs: performance.now() - t0, hashes, msgs: rec.messages };
}

(async () => {
  const modes: Array<[string, string | undefined]> = [["off", undefined], ["on", "1"], ["commit", "commit"]];
  const base: Record<string, string> = {};
  for (let r = 0; r < repeats; r++) {
    for (const [name, m] of modes) {
      const x = await run(m);
      const h = x.hashes.join(",");
      if (name === "off" && r === 0) base.h = h;
      console.log(JSON.stringify({ rep: r + 1, mode: name, msgs: x.msgs, snapshotCalls: x.calls, snapshotMs: Math.round(x.snapMs), perMessageMs: +(x.snapMs / x.msgs).toFixed(2), wallMs: Math.round(x.wallMs), bytesEqualToOff: h === base.h }));
    }
  }
})();
