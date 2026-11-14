/**
 * ORW-350: the house-life scene mix BY WEEK on a chat-paced seeded game (the same driver as tests/unit/houseMixGuard.test.ts, run long). Usage:
 *   npx tsx scripts/probes/houseMixByWeek.ts [messages=1100] [seeds=12]
 * Prints, per seed and pooled, the bonding/strategy/gossip/conflict share of house-life scenes in each game week the player lived through, plus the action mix of the gossip scenes. Read-only: it plays a throwaway game.
 */
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { endHeldNight } from "../../tests/support/heldNight";

const MESSAGES = Number(process.argv[2] ?? 1100), SEEDS = Number(process.argv[3] ?? 12);
const KINDS = ["bonding", "strategy", "gossip", "conflict"] as const;
type Row = Record<(typeof KINDS)[number], number> & { n: number };
const winActs = new Map<number, Map<string, number>>(); const win = new Map<number, Row>(); const WIN = 200; const pooled = new Map<number, Row>(); const pooledActs = new Map<number, Map<string, number>>();
const blank = (): Row => ({ bonding: 0, strategy: 0, gossip: 0, conflict: 0, n: 0 });

async function main() {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const user = `mixwk-${seed}`;
    const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
    const mcp = reg.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
    const weekAtEvent: number[] = []; // event index -> week, stamped as the game runs
    const outAtEvent: boolean[] = []; const msgAtEvent: number[] = []; // event index -> was the PLAYER already out of the game (a spectator's house is a different regime; read the live-play weeks apart)
    const sess = reg.sandboxFor(user).session as unknown as { house?: { player: { id: string } }; live?: { evictionOrder?: string[] } };
    let seen = 0, week = 1, continue_ = false; void continue_;
    for (let i = 0; i < MESSAGES; i++) {
      await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
      if (i % 12 === 11) {
        const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown; week?: number };
        if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `mw${seed}`);
        if (adv.pending) {
          const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
          if (k === "ceremony-step") { await mcp.callTool("advanceGame", {}); continue_ = true; } else try { await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) }); } catch { await mcp.callTool("advanceGame", {}); }
        }
      }
      const st = (await mcp.callTool("getGameState", {})) as { week?: number };
      week = st.week ?? week;
      const n = reg.sandboxFor(user).engine.events.queryAll().length;
      const out = !!sess.live?.evictionOrder?.includes(sess.house!.player.id);
      while (seen < n) { outAtEvent[seen] = out; msgAtEvent[seen] = i; weekAtEvent[seen++] = week; }
    }
    const evs = reg.sandboxFor(user).engine.events.queryAll();
    const by = new Map<number, Row>();
    evs.forEach((e, idx) => {
      if (!e.houseLife) return;
      if (outAtEvent[idx]) return; // player out: not a played week
      const w = weekAtEvent[idx] ?? week;
      { const k = Math.floor((msgAtEvent[idx] ?? 0) / WIN); { const m = winActs.get(k) ?? new Map<string, number>(); const a = String((e.houseLife as { action?: string }).action); m.set(a, (m.get(a) ?? 0) + 1); winActs.set(k, m); } const r2 = win.get(k) ?? blank(); if ((KINDS as readonly string[]).includes(e.type)) { (r2 as never as Record<string, number>)[e.type]++; r2.n++; } win.set(k, r2); }
      const r = by.get(w) ?? blank(), p = pooled.get(w) ?? blank();
      if ((KINDS as readonly string[]).includes(e.type)) { (r as never as Record<string, number>)[e.type]++; (p as never as Record<string, number>)[e.type]++; r.n++; p.n++; }
      by.set(w, r); pooled.set(w, p);
      if (e.type === "gossip") { const m = pooledActs.get(w) ?? new Map(); const a = String((e.houseLife as { action?: string }).action); m.set(a, (m.get(a) ?? 0) + 1); pooledActs.set(w, m); }
    });
    console.log(`seed ${seed}: ` + [...by.entries()].sort((a, b) => a[0] - b[0]).map(([w, r]) => `w${w}[${r.n}] ${KINDS.map((k) => Math.round((100 * r[k]) / Math.max(1, r.n))).join("/")}`).join("  "));
  }
  console.log(`POOLED played weeks only (${SEEDS} seeds, ${MESSAGES} messages; scenes after the player's eviction are left out): bonding/strategy/gossip/conflict % per week  (agreed 48/29/17/4)`);
  for (const [w, r] of [...pooled.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  week ${w}: scenes ${r.n}  ${KINDS.map((k) => ((100 * r[k]) / Math.max(1, r.n)).toFixed(1)).join(" / ")}   gossip actions: ${[...(pooledActs.get(w) ?? new Map()).entries()].map(([a, c]) => `${a} ${c}`).join(", ")}`);
  }
}
main().then(() => { for (const [k, m] of [...winActs.entries()].sort((a, b) => a[0] - b[0])) console.log(`  actions msgs ${k * WIN}-${k * WIN + WIN - 1}: ` + [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([a, c]) => `${a} ${c}`).join(", ")); console.log(`BY MESSAGE WINDOW (${WIN} messages, played scenes only):`); for (const [k, r] of [...win.entries()].sort((a, b) => a[0] - b[0])) console.log(`  msgs ${k * WIN}-${k * WIN + WIN - 1}: scenes ${r.n}  ${KINDS.map((q) => ((100 * r[q]) / Math.max(1, r.n)).toFixed(1)).join(" / ")}`); }).catch((e) => { console.error(e); process.exit(1); });
