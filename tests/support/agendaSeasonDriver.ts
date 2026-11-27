import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { resolvePending } from "../../features/support/answerPending";

/**
 * ORW-312: drives a PLAYED season (a person is playing: `noteMessage`) headlessly through the real loop - ceremonies due on schedule, the player turning in at night - and mimics the
 * orchestrator's sleep step (`settleOvernight`) after each night. Roles only. `maxSteps` bounds the loop; `stopAtWeek` ends it after that many weeks have closed (for the 3-week case).
 */
/** The beats with no day-schedule slot that the front end resolves as engine-driven phases (mirrors chat_helpers `_CEREMONY_RESOLVE_PHASES` minus the scheduled ceremonies). */
const ENGINE_DRIVEN_BEATS: ReadonlySet<string> = new Set(["twist-reveal", "battle-back", "final-eviction"]);
export interface PlayedSeason { s: GameSessionAdapter; nights: number; finished: boolean; sb: ReturnType<GameSessionRegistry["sandboxFor"]> }
export function playSeason(seed: number, opts: { stopAtWeek?: number; maxSteps?: number; mull?: boolean; ownViewOff?: boolean; configure?: (s: GameSessionAdapter) => void; observe?: (live: Record<string, unknown> & { week: number }) => void } = {}): PlayedSeason {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(`agenda-${seed}-${Math.random()}`);
  const s = sb.session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  opts.configure?.(s);
  s.setPerConversationClockEnabled(true);
  if (opts.ownViewOff) (s as unknown as { setOwnViewEnabled(on: boolean): void }).setOwnViewEnabled(false); // ORW-574: a test that isolates one effect can take the decider's own view out of the season
  const live = () => s.snapshot().live as unknown as { evictionOrder?: string[]; nightDepth?: number; timeOfDay?: string; finished?: boolean; week: number; beat?: string };
  for (let i = 0; i < 80 && live().nightDepth === undefined; i++) s.advanceGame();
  s.noteMessage({ messageId: "agenda-0" });
  let nights = 0;
  const max = opts.maxSteps ?? 30000;
  for (let step = 0; step < max; step++) {
    const l = live();
    opts.observe?.(s.snapshot().live as unknown as Record<string, unknown> & { week: number });
    if (l.finished || (opts.stopAtWeek !== undefined && l.week > opts.stopAtWeek)) break;
    const d = (s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule;
    // ORW-1106: the reactive twists and the Final-3 eviction have no day-schedule slot; the front end resolves them as engine-driven phases (chat_helpers
    // `_CEREMONY_RESOLVE_PHASES`), so the driver advances them too. Without this a season that arms a twist sat at "twist-reveal" for good.
    if (d?.due || (l.beat !== undefined && ENGINE_DRIVEN_BEATS.has(l.beat))) {
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    } else if (l.timeOfDay === "night" || l.timeOfDay === "late-night") {
      const r = s.turnIn({}) as { held?: unknown } | undefined;
      if (!r?.held) { nights++; if (opts.mull !== false) s.settleOvernight(1); }
      if (l.evictionOrder?.includes(PLAYER)) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
    } else s.advanceClockPerConversation();
  }
  return { s, nights, finished: live().finished === true, sb };
}

/** A freshly cast, PLAYED game (a person has started talking): the agendas exist, the cast and pre-show ties already do. Also hands back the sandbox (its event store) for a scenario that reads the scenes. */
export function startPlayedSandbox(seed: number) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(`agenda-bdd-${seed}-${Math.random()}`);
  const s = sb.session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true);
  s.noteMessage({ messageId: "agenda-bdd-0" });
  return { s, sb };
}

/** A freshly cast, PLAYED game (a person has started talking): the agendas exist, the cast and pre-show ties already do. */
export function startPlayedSeason(seed: number): GameSessionAdapter {
  return startPlayedSandbox(seed).s;
}
