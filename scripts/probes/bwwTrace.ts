// Diagnostic for ORW-433: what the engine says on eviction night after the vote. One seed, no beds; prints the advance view + schedule while phase = eviction.
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { answerPending } from "../../features/support/answerPending";
async function main() {
  const seed = Number(process.argv[2] ?? 1), N = Number(process.argv[3] ?? 1500);
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const mcp = reg.resolver()("player", "t");
  const call = async <T>(n: string, a: Record<string, unknown> = {}): Promise<T> => (await mcp.callTool(n, a)) as T;
  await call("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  let voted = false, shown = 0;
  for (let i = 0; i < N; i++) {
    await call("noteMessage", { messageId: `m${i}` });
    if (i % 12 !== 11) continue;
    const adv = await call<Record<string, any>>("advanceGame");
    const st = await call<Record<string, any>>("getGameState");
    if (st.phase === "eviction" && (st.timeOfDay === "evening" || adv.pending?.kind === "eviction-vote")) voted = true;
    if (voted && shown < 40 && st.whereabouts?.houseEvent?.kind === "eviction") { shown++;
      const { pending, held, ...rest } = adv; const c = adv.ceremony ?? {}; const cer = `step=${c.kind ?? "?"}:${c.step ?? "?"} ev=${JSON.stringify(adv.event ?? null)?.slice(0, 90)} ann=${JSON.stringify(adv.announcements ?? null)?.slice(0, 90)} evic=${JSON.stringify(adv.eviction ?? null)?.slice(0, 120)}`;
      console.log(`#${i} ${st.clockLabel} ${st.phase} ${st.timeOfDay} pend=${pending?.kind ?? "-"} held=${JSON.stringify(held ?? null)} he=${st.whereabouts?.houseEvent?.kind ?? "-"} ${cer}`); }
    if (adv.pending) { const r = answerPending(adv.pending); if (r) { try { await call("submitDecision", r as never); } catch (e) { console.log("submit threw " + String(e).slice(0, 100)); } } else await call("advanceGame"); }
    if (voted && st.phase !== "eviction" && shown > 2) break;
  }
}
main().then(() => process.exit(0));
