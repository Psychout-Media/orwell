/**
 * ORW-353: where house-life CONFLICT and BETRAYAL come from, per seed, and the late mix read two ways: only while the player is still in the game, and for NPC life regardless of the player's status. Usage:
 *   npx tsx scripts/probes/houseLifeSources.ts [messages=800] [seeds=12]
 */
import { playMixGame, mixShares } from "../../tests/support/houseMixDriver";

const MESSAGES = Number(process.argv[2] ?? 800), SEEDS = Number(process.argv[3] ?? 12);
const f = (x: ReturnType<typeof mixShares>): string => `n=${x.n} ${x.bonding.toFixed(0)}/${x.strategy.toFixed(0)}/${x.gossip.toFixed(0)}/${x.conflict.toFixed(0)}`;
(async () => {
  const conflict = new Map<string, number>(); let betrayals = 0, clash = 0; const allLate: Array<ReturnType<typeof playMixGame> extends Promise<infer G> ? G["scenes"][number] : never> = []; const playedLate: typeof allLate = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const g = await playMixGame(seed, MESSAGES);
    const c = new Map<string, number>(); for (const s of g.scenes) if (s.type === "conflict") { c.set(s.action, (c.get(s.action) ?? 0) + 1); conflict.set(s.action, (conflict.get(s.action) ?? 0) + 1); }
    betrayals += g.betrayals; clash += g.goalClashBreaks;
    allLate.push(...g.scenes.filter((s) => s.msg >= 600)); playedLate.push(...g.scenes.filter((s) => s.msg >= 600 && !s.playerOut));
    console.log(`seed ${seed}: conflict by action ${[...c.entries()].map(([a, n]) => `${a} ${n}`).join(", ") || "-"}; betrayals ${g.betrayals} (goal clash ${g.goalClashBreaks}); late all ${f(mixShares(g.scenes.filter((s) => s.msg >= 600)))}; late played ${f(mixShares(g.scenes.filter((s) => s.msg >= 600 && !s.playerOut)))}`);
  }
  console.log(`POOLED ${SEEDS} seeds: conflict scenes by action ${[...conflict.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join(", ")}; betrayals ${betrayals} (goal clash ${clash})`);
  console.log(`  late (msgs >= 600), NPC life regardless of the player: ${f(mixShares(allLate))}   while the player is in: ${f(mixShares(playedLate))}`);
})();
