import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { phaseForHour } from "../../src/engine/timeOfDay";
import { resolvePending } from "../../features/support/answerPending";

/**
 * 0148 / ORW-417 - the shared nap test world: a PLAYED, turn-driven game (a real per-user sandbox + the real orchestrator, so the house really lives the slept hours) parked at a quiet moment of a day-3+ morning.
 * Used by tests/unit/playerNap.test.ts and the BDD steps (features/step_definitions/player_nap.steps.ts). Roles only.
 */
type S = GameSessionAdapter;
export type NapPriv = { live: { nightDepth: number; timeOfDay: string; lastSleepDepth?: number; napHoursToday?: number; dayNumber?: number; playerRetired?: boolean; competition?: unknown; ceremony?: unknown; beat?: string; playedGame?: boolean; napWake?: unknown; pending?: unknown }; restDeficitOf(id: string): number; presence: Map<string, string>; napEnabled: boolean };
export const priv = (s: S): NapPriv => s as unknown as NapPriv;

/** Nothing in session, morning, day 3+, no one has talked yet (the world's `noteMessage` then makes it a played game). */
export const quiet = (s: S): boolean => !priv(s).live.competition && !priv(s).live.ceremony && !priv(s).live.pending && priv(s).live.timeOfDay === "morning" && (priv(s).live.dayNumber ?? 1) >= 3 && priv(s).live.playedGame !== true;

export function setup(seed = 3, until: (s: S) => boolean = quiet) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("u");
  const s = sb.session;
  s.createCharacter({ playerName: "The Player", seed });
  s.setPerConversationClockEnabled(true);
  const orch = new Orchestrator(reg, new FakeClock(), { seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  for (let i = 0; i < 300; i++) {
    const a = s.advanceGame();
    if (a.pending) resolvePending(a.pending, (req) => void s.submitDecision(req));
    if (s.getGameState().started && priv(s).live.timeOfDay !== undefined && until(s) && !(s.getGameState() as { pending?: unknown }).pending) break;
  }
  if (!(s.getGameState().started && priv(s).live.timeOfDay !== undefined && until(s))) throw new Error("napWorld.setup: the requested world was not reached in 300 advances"); // fail fast, never run a test on the wrong state
  s.noteMessage({ messageId: "warm" }); // a person is playing (live.playedGame)
  return { s, sb, orch, reg };
}

/** Put the clock at an exact hour with a night of `bedHour` behind the player (the player "stayed up until 4am" = hour 28), and no nap credit. */
export function at(s: S, hour: number, bedHour = 28): void {
  const l = priv(s).live;
  l.nightDepth = hour; l.timeOfDay = phaseForHour(hour); l.lastSleepDepth = bedHour; l.napHoursToday = undefined; l.playerRetired = false;
}
