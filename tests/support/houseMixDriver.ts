import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { endHeldNight } from "./heldNight";

/**
 * ORW-350: ONE chat-paced seeded game, played the way the house-life mix guard has always played it (a message per tick, an advance every 12th), long enough to reach the weeks after the first. Returns every house-life scene tagged with the
 * message it came from, the game week, and whether the PLAYER was already out of the game (a spectator's house is a different regime; the played mix is read without it). Used by `tests/property/houseMixLate.property.test.ts`; the probe `scripts/probes/houseMixByWeek.ts` plays the same loop inline (it is not shared).
 */
export interface MixScene { type: string; action: string; msg: number; week: number; playerOut: boolean }

export interface MixGame { scenes: MixScene[]; /** alliance betrayals recorded (events of type betrayal) */ betrayals: number; /** of those, the ones a goal clash caused (an NPC turning on a fellow member) */ goalClashBreaks: number; /** alliance betrayals by game week (the week the event happened in) */ betrayalsByWeek: Record<number, number> }

export async function playMixGame(seed: number, messages: number, opts: { /** ORW-852: the sandbox name (part of the game's identity with the seed); default `mixdrv-<seed>` */ user?: string; /** a report hook: the player states how they present (never set by default) */ playerGender?: string; /** a report/BDD hook: stop after the message on which this returns true (read-only) */ stopWhen?: (session: unknown) => boolean; advanceEvery?: number; /** stop as soon as the game reaches this week (default: play all `messages`) */ stopAtWeek?: number; /** 0178: read the finished sandbox (a report hook; read-only) */ inspect?: (session: unknown) => void; /** ORW-634: read the live sandbox after each message (read-only; a report hook) */ onStep?: (session: unknown) => void; /** 0178: an active player - called after each message, may call tools (the report makes deals) */ onMessage?: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>, i: number) => Promise<void> } = {}): Promise<MixGame> {
  const every = opts.advanceEvery ?? 12; // ORW-518: the late-game guard advances faster so EVERY seed reaches the late weeks (at 12 a played week is ~400 messages)
  const user = opts.user ?? `mixdrv-${seed}`;
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater", ...(opts.playerGender ? { genderPresentation: opts.playerGender } : {}) });
  const sess = reg.sandboxFor(user).session as unknown as { house?: { player: { id: string } }; live?: { evictionOrder?: string[] } };
  const stamp: Array<{ msg: number; week: number; out: boolean }> = [];
  let seen = 0, week = 1;
  for (let i = 0; i < messages; i++) {
    await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
    if (opts.onMessage) await opts.onMessage((n, a) => mcp.callTool(n, a), i);
    if (i % every === every - 1) {
      const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown };
      if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `md${seed}`, undefined, { stopWhenDue: true }); // ORW-445: a due 4pm event must fire, not be slept through (the phase now agrees with milestoneDue at the edge)
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
    opts.onStep?.(reg.sandboxFor(user).session); // ORW-634: a read-only look at the live sandbox after each message (a report hook)
    if (opts.stopAtWeek !== undefined && week >= opts.stopAtWeek) break;
    if (opts.stopWhen?.(reg.sandboxFor(user).session)) break;
  }
  const scenes: MixScene[] = [];
  let betrayals = 0, goalClashBreaks = 0; const betrayalsByWeek: Record<number, number> = {};
  reg.sandboxFor(user).engine.events.queryAll().forEach((e, idx) => {
    if (e.type === "betrayal") { betrayals++; const wk = (stamp[idx]?.week ?? week); betrayalsByWeek[wk] = (betrayalsByWeek[wk] ?? 0) + 1; if (/turned on the alliance/.test(String(e.content)) && (e.witnessSet ?? []).length === 2) goalClashBreaks++; }
    if (!e.houseLife) return;
    const s = stamp[idx] ?? { msg: messages - 1, week, out: false };
    scenes.push({ type: e.type, action: String((e.houseLife as { action?: string }).action), msg: s.msg, week: s.week, playerOut: s.out });
  });
  opts.inspect?.(reg.sandboxFor(user).session);
  return { scenes, betrayals, goalClashBreaks, betrayalsByWeek };
}

export const MIX_KINDS = ["bonding", "strategy", "gossip", "conflict"] as const;
/** The percentage share of each of the four scene kinds among the given scenes (the other kinds, a showmance, are not in the denominator). */
export function mixShares(scenes: readonly MixScene[]): { n: number; bonding: number; strategy: number; gossip: number; conflict: number } {
  const c: Record<string, number> = {}; let n = 0;
  for (const s of scenes) if ((MIX_KINDS as readonly string[]).includes(s.type)) { c[s.type] = (c[s.type] ?? 0) + 1; n++; }
  const p = (k: string): number => (100 * (c[k] ?? 0)) / Math.max(1, n);
  return { n, bonding: p("bonding"), strategy: p("strategy"), gossip: p("gossip"), conflict: p("conflict") };
}
