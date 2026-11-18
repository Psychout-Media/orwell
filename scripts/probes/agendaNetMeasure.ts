/**
 * ORW-635 (stacking audit S-2): how much the agenda re-counts threat / grudge / belief on one option, before and after the netting + ceiling. Usage:
 *   npx tsx scripts/probes/agendaNetMeasure.ts [seeds=3] [messages=800]
 * Plays seeded chat-paced PLAYED seasons (the allianceLifetimes driver); at every agenda read it also computes the OLD read (netting and ceiling dialled off) on the same state, then reports,
 * for reads where an agenda pushes (value > 0): the share of reads the netting zeroed, and the stacked read (agenda + belief + memory on that option) average and max, old vs new.

 * STATUS: the quick-driver run read 0 pushing agenda reads in 8 seeds and the chat-paced run read 0 agenda reads at all before the clock line above was added (UNVERIFIED since): run it on a quiet box or CI and check the first line (all reads > 0) before trusting the numbers.
 * The engine follows the NEW read; the old one is only observed. Roles only, no output of any game content. Heavy: run on a quiet box / CI.
 */
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { REASONS } from "../../src/engine/agendaConstants";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { endHeldNight } from "../../tests/support/heldNight";

const SEEDS = Number(process.argv[2] ?? 3), MESSAGES = Number(process.argv[3] ?? 800);
type Pull = { value: number };
const proto = GameSessionAdapter.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const orig = proto.agendaPullOf!;
const R = REASONS as unknown as { netShare: number; stackKnee: number; stackCeiling: number };
const keep = { ...R };
const hist: number[] = []; let calls = 0; const rows: Array<{ oldA: number; newA: number; stackOld: number; stackNew: number }> = [];
proto.agendaPullOf = function (this: unknown, ...a: unknown[]): Pull {
  calls++; const now = orig.apply(this, a) as Pull;
  Object.assign(R, { netShare: 0, stackKnee: 1e9, stackCeiling: 2e9 });
  const old = orig.apply(this, a) as Pull;
  Object.assign(R, keep);
  if (old.value !== 0) hist.push(Math.round(old.value * 10) / 10);
  if (old.value > 0 || now.value > 0) {
    const me = this as unknown as { npcMemoryEnabled: boolean; memoryTiltFor(t: string, h: string): number; beliefNomTiltFor(t: string, h: string): number; npcBeliefNomsEnabled: boolean };
    const m = me.npcMemoryEnabled ? Math.max(0, me.memoryTiltFor(a[0] as string, a[1] as string)) : 0;
    const b = me.npcBeliefNomsEnabled ? Math.max(0, me.beliefNomTiltFor(a[0] as string, a[1] as string)) : 0;
    rows.push({ oldA: old.value, newA: now.value, stackOld: old.value + b + m, stackNew: now.value + b + m });
  }
  return now;
};
async function main(): Promise<void> {
  GameSessionAdapter.setTimeOfDayEnabled(true); // agendas are seeded only on a played game with the in-game clock on
  for (let seed = 1; seed <= SEEDS; seed++) {
    const user = `an-${seed}`; const mcp = composeRuntime({ clock: new FakeClock(), seed }).registry.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
    for (let i = 0; i < MESSAGES; i++) {
      await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
      if (i % 12 !== 11) continue;
      const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown };
      if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `an${seed}`);
      if (adv.pending) { const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
        if (k === "ceremony-step") await mcp.callTool("advanceGame", {}); else try { await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) }); } catch { await mcp.callTool("advanceGame", {}); } }
    }
  }
}
await main();
const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const f = (n: number): string => n.toFixed(3);
console.log(`all agenda reads: ${calls}; nonzero old values: ${JSON.stringify(hist)}`);
console.log(`agenda reads with a push: ${rows.length}; netted to zero: ${rows.filter((r) => r.oldA > 0 && r.newA === 0).length}`);
console.log(`agenda term     old avg ${f(avg(rows.map((r) => r.oldA)))} max ${f(Math.max(...rows.map((r) => r.oldA)))} | new avg ${f(avg(rows.map((r) => r.newA)))} max ${f(Math.max(...rows.map((r) => r.newA)))}`);
console.log(`stacked a+b+m   old avg ${f(avg(rows.map((r) => r.stackOld)))} max ${f(Math.max(...rows.map((r) => r.stackOld)))} | new avg ${f(avg(rows.map((r) => r.stackNew)))} max ${f(Math.max(...rows.map((r) => r.stackNew)))}`);
console.log(`stacked above 1.4: old ${rows.filter((r) => r.stackOld > 1.4).length} new ${rows.filter((r) => r.stackNew > 1.4).length}`);
