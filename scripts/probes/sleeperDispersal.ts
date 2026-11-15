/**
 * ORW-383 / ORW-466: after the player wakes, how long do the houseguests stay in the bedrooms? (Since ORW-466 a played game seats sleepers in their own bed; there is no switch.) Usage:
 *   npx tsx scripts/probes/sleeperDispersal.ts [messages=700] [seeds=4]   (ORW-466: in a played game sleepers now wake in their own bed; the ORW-383 flag is gone)
 * Offsets count this probe's own noteMessage calls (loop iterations); endHeldNight's internal noteMessage calls are not sampled, so after a held night the offset is a lower bound on the real message count since the wake. Per wake (a day change), the share of houseguests in a bedroom at 0, 1, 2, 4, 8, 12, 16, 24 messages after the wake. Read-only: a throwaway game on a fake clock.
 */
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { endHeldNight } from "../../tests/support/heldNight";

const MESSAGES = Number(process.argv[2] ?? 700), SEEDS = Number(process.argv[3] ?? 4);
const BEDS = new Set(["bedroom-a", "bedroom-b", "bedroom-c"]);
const OFFS = [0, 1, 2, 4, 8, 12, 16, 24];
const sums = new Map<number, number>(); const counts = new Map<number, number>(); let wakes = 0;
async function main() {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const user = `sd-${seed}`; const reg = composeRuntime({ clock: new FakeClock(), seed }).registry; const mcp = reg.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
    const sess = reg.sandboxFor(user).session as unknown as { occupancy(): Map<string, string> | null; house?: { player: { id: string } } };
    let day = 0; const wakeAt: number[] = [];
    const share = (): number => { const o = sess.occupancy(); if (!o) return NaN; const me = sess.house?.player.id; const npc = [...o.entries()].filter(([id]) => id !== me); return npc.filter(([, r]) => BEDS.has(r)).length / Math.max(1, npc.length); };
    const shares: number[] = [];
    for (let i = 0; i < MESSAGES; i++) {
      await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
      if (i % 12 === 11) {
        const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown };
        if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `sd${seed}`);
        if (adv.pending) {
          const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
          try { await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : { kind: k, choice: o(0) } as never); } catch { /* a closed-set pick the driver cannot answer is skipped */ }
        }
      }
      const st = (await mcp.callTool("getGameState", {})) as { dayNumber?: number };
      if ((st.dayNumber ?? 0) !== day) { day = st.dayNumber ?? day; wakeAt.push(i); }
      shares[i] = share();
    }
    for (const w of wakeAt.slice(1)) {
      wakes++;
      // An offset past the end of the run, or a sample with no occupancy, is NOT a zero share: count only valid samples per offset and divide by that count.
      for (const k of OFFS) { const v = shares[w + k]; if (v !== undefined && Number.isFinite(v)) { sums.set(k, (sums.get(k) ?? 0) + v); counts.set(k, (counts.get(k) ?? 0) + 1); } }
    }
  }
  console.log(`sleeper dispersal (${SEEDS} seeds, ${wakes} wakes): share of houseguests in a bedroom, by messages after the wake`);
  console.log("  " + OFFS.map((k) => `+${k}: ${(100 * (sums.get(k) ?? 0) / Math.max(1, counts.get(k) ?? 0)).toFixed(0)}%`).join("  "));
}
main().then(() => process.exit(0));
