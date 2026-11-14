import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { endHeldNight } from "./heldNight";

/**
 * ORW-350: ONE chat-paced seeded game, played the way the house-life mix guard has always played it (a message per tick, an advance every 12th), long enough to reach the weeks after the first. Returns every house-life scene tagged with the
 * message it came from, the game week, and whether the PLAYER was already out of the game (a spectator's house is a different regime; the played mix is read without it). Shared by `houseMixLateGuard.test.ts` and `scripts/probes/houseMixByWeek.ts`.
 */
export interface MixScene { type: string; action: string; msg: number; week: number; playerOut: boolean }

export async function playMixGame(seed: number, messages: number): Promise<MixScene[]> {
  const user = `mixdrv-${seed}`;
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  const sess = reg.sandboxFor(user).session as unknown as { house?: { player: { id: string } }; live?: { evictionOrder?: string[] } };
  const stamp: Array<{ msg: number; week: number; out: boolean }> = [];
  let seen = 0, week = 1;
  for (let i = 0; i < messages; i++) {
    await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
    if (i % 12 === 11) {
      const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown };
      if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `md${seed}`);
      if (adv.pending) {
        const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
        if (k === "ceremony-step") await mcp.callTool("advanceGame", {});
        else {
          try {
            await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) });
          } catch { await mcp.callTool("advanceGame", {}); }
        }
      }
    }
    week = ((await mcp.callTool("getGameState", {})) as { week?: number }).week ?? week;
    const n = reg.sandboxFor(user).engine.events.queryAll().length;
    const out = !!sess.live?.evictionOrder?.includes(sess.house!.player.id);
    while (seen < n) { stamp[seen++] = { msg: i, week, out }; }
  }
  const scenes: MixScene[] = [];
  reg.sandboxFor(user).engine.events.queryAll().forEach((e, idx) => {
    if (!e.houseLife) return;
    const s = stamp[idx] ?? { msg: messages - 1, week, out: false };
    scenes.push({ type: e.type, action: String((e.houseLife as { action?: string }).action), msg: s.msg, week: s.week, playerOut: s.out });
  });
  return scenes;
}

export const MIX_KINDS = ["bonding", "strategy", "gossip", "conflict"] as const;
/** The percentage share of each of the four scene kinds among the given scenes (the other kinds, a showmance, are not in the denominator). */
export function mixShares(scenes: readonly MixScene[]): { n: number; bonding: number; strategy: number; gossip: number; conflict: number } {
  const c: Record<string, number> = {}; let n = 0;
  for (const s of scenes) if ((MIX_KINDS as readonly string[]).includes(s.type)) { c[s.type] = (c[s.type] ?? 0) + 1; n++; }
  const p = (k: string): number => (100 * (c[k] ?? 0)) / Math.max(1, n);
  return { n, bonding: p("bonding"), strategy: p("strategy"), gossip: p("gossip"), conflict: p("conflict") };
}
