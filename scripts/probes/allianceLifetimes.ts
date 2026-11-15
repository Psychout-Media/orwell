/**
 * ORW-353: how many named alliances form and how long they last, on the chat-paced seeded game (the same driver as the house-mix probe). Usage:
 *   npx tsx scripts/probes/allianceLifetimes.ts [messages=800] [seeds=12]
 * Per seed and pooled: alliances formed, how many were still standing at the end, how many dissolved and of those how many FADED (the neglect check) vs left by betrayal / eviction, and the lifetimes in in-game days of those that dissolved.
 */
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { AllianceStore } from "../../src/engine/alliances";
import { endHeldNight } from "../../tests/support/heldNight";

const MESSAGES = Number(process.argv[2] ?? 800), SEEDS = Number(process.argv[3] ?? 12);
let faded = 0; const proto = AllianceStore.prototype as unknown as { fade?: (...a: unknown[]) => unknown[] };
if (proto.fade) { const orig = proto.fade; proto.fade = function (this: unknown, ...a: unknown[]) { const g = orig.apply(this, a); faded += g.length; return g; }; }

async function main() {
  const life: number[] = []; let formed = 0, standing = 0, fadedTotal = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const user = `alf-${seed}`; const reg = composeRuntime({ clock: new FakeClock(), seed }).registry; const mcp = reg.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
    const sess = reg.sandboxFor(user).session as unknown as { alliances: { all(): Array<{ id: string }> }; live?: { dayNumber?: number; week: number } };
    const first = new Map<string, number>(), last = new Map<string, number>(); const faded0 = faded;
    for (let i = 0; i < MESSAGES; i++) {
      await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
      if (i % 12 === 11) {
        const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown };
        if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `al${seed}`);
        if (adv.pending) { const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
          if (k === "ceremony-step") await mcp.callTool("advanceGame", {}); else try { await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) }); } catch { await mcp.callTool("advanceGame", {}); } }
      }
      const day = sess.live?.dayNumber ?? sess.live?.week ?? 0;
      for (const a of sess.alliances.all()) { if (!first.has(a.id)) first.set(a.id, day); last.set(a.id, day); }
    }
    const ids = new Set(sess.alliances.all().map((a) => a.id));
    const gone = [...first.keys()].filter((id) => !ids.has(id));
    formed += first.size; standing += ids.size; fadedTotal += faded - faded0;
    const ls = gone.map((id) => (last.get(id) ?? 0) - (first.get(id) ?? 0)); life.push(...ls);
    console.log(`seed ${seed}: formed ${first.size}, standing ${ids.size}, dissolved ${gone.length} (faded ${faded - faded0})  lifetimes(days) ${ls.sort((a, b) => a - b).join(",") || "-"}`);
  }
  life.sort((a, b) => a - b); const med = life.length ? life[Math.floor(life.length / 2)] : "-";
  console.log(`POOLED ${SEEDS} seeds x ${MESSAGES} msgs: formed ${formed} (${(formed / SEEDS).toFixed(1)}/seed), standing at end ${standing}, dissolved ${life.length} (faded ${fadedTotal}), lifetime of the dissolved in in-game days: median ${med}, max ${life[life.length - 1] ?? "-"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
