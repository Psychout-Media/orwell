import { it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { endHeldNight } from "../support/heldNight";

/**
 * The house-life MIX guard (ORW-324 mix, ORW-341 retune). House life got "too friendly" once (ORW-324) and then drifted the other way when agenda-driven alliances landed (ORW-341: bonding 48 to 28,
 * gossip 17 to 36, conflict 4 to 7.5 on 12 seeds, found by a manual read, not by any test). This pins a small seeded chat-paced game and fails if any scene share moves more than 5 points from the agreed mix
 * (bonding 48 / strategy 29 / gossip 17 / conflict 4, measured on 12 seeds before ORW-340), so a change that reshapes who does what in house life cannot land quietly. Bounded, not just detected: the cap on live
 * alliances (`ALLIANCE.agendaMaxLive`) is what holds it. A deliberate re-agreement of the mix means changing AGREED here, in the open, with the measurement in the PR.
 */
const AGREED = { bonding: 48, strategy: 29, gossip: 17, conflict: 4 } as const;
const TOLERANCE = 5; // points
const SEEDS = [3, 5];
const MESSAGES = 360;

it("the seeded house-life scene mix stays within 5 points of the agreed mix", async () => {
  const counts: Record<string, number> = {};
  let scenes = 0;
  for (const seed of SEEDS) {
    const user = `mix-guard-${seed}`;
    const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
    const mcp = reg.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
    for (let i = 0; i < MESSAGES; i++) {
      await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
      if (i % 12 === 11) {
        const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown };
        if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `mg${seed}`);
        if (adv.pending) {
          const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
          await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) });
        }
      }
    }
    for (const e of reg.sandboxFor(user).engine.events.queryAll()) if (e.houseLife) { scenes++; counts[e.type] = (counts[e.type] ?? 0) + 1; }
  }
  expect(scenes, "enough scenes to read a mix").toBeGreaterThan(300);
  const share = (k: string): number => (100 * (counts[k] ?? 0)) / scenes;
  const got = { bonding: share("bonding"), strategy: share("strategy"), gossip: share("gossip"), conflict: share("conflict") };
  console.log(`MIXGUARD scenes=${scenes} ${JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, +v.toFixed(1)])))}`);
  for (const k of Object.keys(AGREED) as Array<keyof typeof AGREED>) {
    expect(Math.abs(got[k] - AGREED[k]), `${k} is ${got[k].toFixed(1)}% against the agreed ${AGREED[k]}%`).toBeLessThanOrEqual(TOLERANCE);
  }
}, 600_000);
