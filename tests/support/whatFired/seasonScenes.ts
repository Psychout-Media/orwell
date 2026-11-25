import { playSeason } from "./player";

/**
 * ORW-702: play ONE seeded season with the scripted talking player and print its house-life scenes (kind, week, player-out flag: counts only, no content) as one JSON line.
 * Run as a child process by `tests/uat/wholeSeasonMixGuard.test.ts` so the seeds play at the same time (`node --import tsx tests/support/whatFired/seasonScenes.ts <seed> [maxMessages]`).
 */
export const CURVE_BLOCK = 500;
async function main(): Promise<void> {
  const seed = Number(process.argv[2]), maxMessages = Number(process.argv[3] ?? 40000);
  const t0 = Date.now();
  // ORW-832: the cost curve of the season (milliseconds per message, per block of CURVE_BLOCK messages), so a season that slows as it goes shows in the report before it hits a time limit.
  const curve: number[] = [];
  let blockStart = t0;
  // ORW-892: the public couples a season reached (pairs whose pace record ever stepped to level 4, "known": the house-wide couple), counts only; ids never leave this function.
  let publicCouples = 0, pairsSeen = 0;
  const r = await playSeason({ seed, user: `wf-${seed}`, maxMessages, survive: true, after: ({ sess }) => {
    const store = ((sess as any).live?.showmancePace ?? {}) as Record<string, { level: number; steps?: Array<{ to: number }> }>;
    for (const rec of Object.values(store)) { pairsSeen++; if (rec.level >= 4 || (rec.steps ?? []).some((s) => s.to >= 4)) publicCouples++; }
  }, watch: async ({ msg }) => { if ((msg + 1) % CURVE_BLOCK === 0) { const now = Date.now(); curve.push(Math.round((now - blockStart) / CURVE_BLOCK)); blockStart = now; } return false; } });
  const out = { seed, stopped: r.stopped, week: r.week, messages: r.messages, playerOutWeek: r.playerOutWeek ?? null, publicCouples, pairsSeen, seconds: Math.round((Date.now() - t0) / 1000), msPerMessage: curve, scenes: r.scenes.map((s) => [s.type, s.week, s.playerOut ? 1 : 0]) };
  process.stdout.write(`SEASONSCENES ${JSON.stringify(out)}\n`);
}
main().then(() => process.exit(0), (e) => { process.stderr.write(`season failed: ${String((e as Error)?.message ?? e).slice(0, 200)}\n`); process.exit(1); });
