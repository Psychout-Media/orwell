/**
 * 0182 PR 3 (ORW-569): the PLAYED-GAME lane for bitter jurors. The headless calibration sims (juryReach, calibrationGradient, calibrationPoTarget) run with `playedGame` false, so they carry no grudge hook and cannot
 * measure a played-game effect. This probe plays chat-paced seeded games (the houseMixDriver loop, a message per tick, an advance every Nth) to the finale with ORWELL_GRUDGES on and off and reports, per policy
 * (active = declares `compete`; passive = `play-safe`): how many played games reached the finale, the player's finalist share and win rate, and the finale margin (winner's votes minus runner-up's) and the share of
 * jury votes cast against a finalist the juror held a grudge against. Read-only: throwaway games. Usage (heavy; run on CI or a quiet box):
 *   npx tsx scripts/probes/bitterJurorsPlayed.ts [seeds=12] [maxMessages=9000] [advanceEvery=6]
 * If the effect moves the active-vs-passive win rates (CLAUDE.md baseline: active ~20% vs passive ~7%), retune `JURY_GRUDGE.scale` in src/engine/juryConstants.ts ONLY; never `JURY_WEIGHTS.gameRespect`.
 */
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { endHeldNight } from "../../tests/support/heldNight";

const SEEDS = Number(process.argv[2] ?? 12), MAX = Number(process.argv[3] ?? 9000), EVERY = Number(process.argv[4] ?? 6);
type Sess = { setGrudgesEnabled(on: boolean): void; setAdvanceGateEnabled?(on: boolean): void; house?: { player: { id: string } }; live?: { finished?: boolean; winner?: string; grudges?: Record<string, unknown>; finale?: { finalists: [string, string]; jury: string[]; votes?: Record<string, string> } } };
interface Row { reached: boolean; playerFinalist: boolean; playerWon: boolean; margin: number; votes: number; /** votes cast AWAY from a finalist the juror holds a grudge against (only readable with the book on) */ away: number; /** votes cast FOR a finalist the juror holds a grudge against */ toward: number }

async function play(seed: number, on: boolean, active: boolean): Promise<Row> {
  const user = `bitter-${seed}-${on}-${active}`;
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  const sess = reg.sandboxFor(user).session as unknown as Sess;
  sess.setGrudgesEnabled(on);
  for (let i = 0; i < MAX; i++) {
    await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
    if (i % EVERY !== EVERY - 1) continue;
    const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }>; appeals?: string[] }; held?: unknown; finished?: boolean };
    if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `bp${seed}`, undefined, { stopWhenDue: true });
    if (adv.pending) {
      const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
      const intent = active ? "compete" : "play-safe";
      try {
        await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent }
          : k === "goodbye-message" ? { kind: k, vote: "respectful" } : k === "finale-statement" ? { kind: k, statement: "My case." } : k === "finale-answer" ? { kind: k, appeal: adv.pending.appeals?.[0] } : { kind: k, vote: o(0) });
      } catch { await mcp.callTool("advanceGame", {}); }
    }
    if (sess.live?.finished || adv.finished) break;
  }
  const f = sess.live?.finale, pid = sess.house?.player.id ?? "player";
  if (!f?.votes) return { reached: false, playerFinalist: false, playerWon: false, margin: 0, votes: 0, away: 0, toward: 0 };
  const tally = new Map<string, number>(); let away = 0, toward = 0;
  for (const [j, fin] of Object.entries(f.votes)) { tally.set(fin, (tally.get(fin) ?? 0) + 1); const other = f.finalists[0] === fin ? f.finalists[1] : f.finalists[0]; if (sess.live?.grudges?.[`${j}|${fin}`]) toward++; if (sess.live?.grudges?.[`${j}|${other}`]) away++; }
  const t = [...tally.values()].sort((a, b) => b - a);
  return { reached: true, playerFinalist: f.finalists.includes(pid), playerWon: sess.live?.winner === pid, margin: (t[0] ?? 0) - (t[1] ?? 0), votes: Object.keys(f.votes).length, away, toward };
}

async function main(): Promise<void> {
  for (const active of [true, false]) for (const on of [false, true]) {
    const rows: Row[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) rows.push(await play(seed, on, active));
    const r = rows.filter((x) => x.reached), n = Math.max(1, r.length), sum = (f: (x: Row) => number): number => r.reduce((a, x) => a + f(x), 0);
    console.log(`${active ? "active " : "passive"} grudges=${on ? "on " : "off"} games=${SEEDS} reachedFinale=${r.length} playerFinalist=${sum((x) => +x.playerFinalist)} playerWins=${sum((x) => +x.playerWon)} (${(100 * sum((x) => +x.playerWon) / SEEDS).toFixed(0)}% of games) meanMargin=${(sum((x) => x.margin) / n).toFixed(2)} votesAwayFromGrudged=${sum((x) => x.away)}/${sum((x) => x.votes)} votesTowardGrudged=${sum((x) => x.toward)} (book only read with grudges on)`);
  }
}
void main();
