import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { endHeldNight } from "./heldNight";
import type { Deal } from "../../src/engine/deals";

/**
 * Feature 0170: one chat-paced seeded game (a message per tick, an advance every 12th, the same loop the house-mix driver plays) that hands back the live session, so a test can read the
 * deal ledger. Roles only. `until` stops the game as soon as it returns true after a tick.
 */
export interface DealsGame {
  user: string;
  reg: ReturnType<typeof composeRuntime>["registry"];
  session: { deals: { serialize(): Deal[]; npcOnly(): Deal[] }; live?: { week: number }; snapshot(): unknown };
  week(): number;
  /** Play on for up to `messages` more ticks (stops early when `until` holds). */
  more(messages: number, until?: (g: DealsGame) => boolean): Promise<void>;
}

export async function playDealsGame(seed: number, messages: number, opts: { advanceEvery?: number; until?: (g: DealsGame) => boolean; user?: string; /** called once with the live session right after the character is created */ setup?: (session: DealsGame["session"]) => void } = {}): Promise<DealsGame> {
  const every = opts.advanceEvery ?? 12;
  const user = opts.user ?? `dealsdrv-${seed}`;
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  const session = reg.sandboxFor(user).session as unknown as DealsGame["session"];
  opts.setup?.(session);
  let tick = 0;
  const g: DealsGame = { user, reg, session, week: () => session.live?.week ?? 1, more: async (n, u) => { await play(n, u); } };
  const play = async (count: number, stop?: (x: DealsGame) => boolean): Promise<void> => {
  for (let n = 0; n < count; n++) {
    const i = tick++;
    await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
    if (i % every === every - 1) {
      const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown };
      if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `dd${seed}`, undefined, { stopWhenDue: true });
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
    if (stop?.(g)) break;
  }
  };
  await play(messages, opts.until);
  return g;
}
