import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { answerPending, type AnswerPolicy } from "../../features/support/answerPending";
import { NotReached } from "./firstSeedWhere";

/**
 * ORW-806 / ORW-811: a PLAYED game driven only through the levers a person and the front end use, for tests/realpath and tests/uat/realPath*. Nothing here writes
 * hidden or engine state: a real per-user sandbox, the real Orchestrator committing each turn (so the house lives between turns), and per turn one player message
 * (`noteMessage`), `advanceGame`, the pending answered by the shared faithful driver (`answerPending`), `hangOut` while the schedule holds the next event, and
 * `turnIn` at night. Tests add the player's own acts (recordInteraction, makeDeal, ...) through `sb.session` / `sb.mcp.player.callTool`. Roles only.
 */
export interface PlayedGame {
  reg: GameSessionRegistry;
  sb: ReturnType<GameSessionRegistry["sandboxFor"]>;
  s: GameSessionAdapter;
  /** One turn: a message, an advance, and the answer / wait it calls for. Returns the advance's view. */
  turn(): AdvanceView;
  /** Play turns until `done()` holds (checked before each turn), or throw after `max` turns. Returns the turns played. */
  playUntil(done: () => boolean, max?: number, what?: string): number;
  /** Play to the crown. */
  playToCrown(max?: number): void;
  /** How the next pending of each kind is answered; a test may replace an answer (the player's own choice) for its own path. */
  answer: (p: NonNullable<AdvanceView["pending"]>) => SubmitDecisionReq | null;
}

/** `from`: a save (`snapshot()`) of a played game to load instead of casting a new one: the persistence path, so two copies of one played moment can be played on differently. */
export function playedGame(opts: { seed: number; user?: string; before?: (s: GameSessionAdapter) => void; policy?: AnswerPolicy; from?: unknown }): PlayedGame {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(opts.user ?? `played-${opts.seed}`);
  const s = sb.session;
  opts.before?.(s);
  if (opts.from !== undefined) s.restore(JSON.parse(JSON.stringify(opts.from))); else s.createCharacter({ playerName: "The Player", seed: opts.seed });
  const orch = new Orchestrator(reg, new FakeClock(), { seed: opts.seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  let msg = 0, playing = opts.from !== undefined, finished = false;
  const g: PlayedGame = {
    reg, sb, s,
    answer: (p) => answerPending(p, opts.policy),
    turn(): AdvanceView {
      if (playing) s.noteMessage({ messageId: `turn-${msg++}` });
      const v = s.advanceGame();
      if (!playing && v.started && v.status?.phase !== "premiere") { s.noteMessage({ messageId: `turn-${msg++}` }); playing = true; }
      if (v.finished) { finished = true; return v; }
      if (v.pending) { const req = g.answer(v.pending); if (req) s.submitDecision(req); return v; }
      if (v.held) {
        if (v.held.reason === "schedule") { const h = s.hangOut(); if (!h.ok) s.turnIn(); } else s.turnIn();
      }
      return v;
    },
    playUntil(done, max = 20_000, what = "the condition"): number {
      for (let i = 0; i < max; i++) {
        if (done()) return i;
        if (finished) throw new NotReached(`the season ended before ${what}`);
        g.turn();
      }
      throw new NotReached(`${what} was not reached in ${max} turns`);
    },
    playToCrown(max = 20_000): void { g.playUntil(() => finished, max, "the crown"); },
  };
  return g;
}
