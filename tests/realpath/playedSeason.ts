import { playSeason, type Call, type PlayOpts } from "../support/whatFired/player";
import type { KnowledgeFact } from "../../src/domain/knowledge";
import { PLAYER } from "../../src/domain/ids";
import { NotReached } from "../support/firstSeedWhere";

/**
 * ORW-810: the shared played-season stop for the real-path tests in this folder. The season is played by the scripted talking player (tests/support/whatFired/player.ts):
 * one message per turn (noteMessage), talk in rotation (scenes, deals, confiding, the diary room), advanceGame, every pending answered, hangOut through a held day and turnIn at
 * night, through the player's MCP channel on the production runtime (composeRuntime, the real orchestrator commits each turn). Nothing hidden is written: `stopWhen` only READS
 * the live session and the engine's stores, and the test then acts through `call` (the player channel) like the front end would. Roles only.
 */
export interface Stop {
  /** The live session, untyped on purpose: the tests READ its private state (the live season, the stores the engine keeps); none of them writes it (the real-path guard). */
  sess: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  engine: { knowledge: { knownTo(e: string): KnowledgeFact[] }; events: { queryAll(): ReadonlyArray<any> }; vault: { readHidden(): ReadonlyArray<{ content: string }> } };
  call: Call;
  msg: number;
}

/** Play `seed` until `stopWhen` holds (checked after every message); throws if the season never gets there within `maxMessages`. */
export async function playUntil(seed: number, stopWhen: (s: Stop) => boolean | Promise<boolean>, opts: Omit<Partial<PlayOpts>, "seed" | "watch"> = {}): Promise<Stop> {
  let at: Stop | undefined;
  // The game that ships: the setup file (tests/support/premiereTestDefault.ts) leaves tests/realpath at the deploy defaults (ORW-827), so the premiere entrances and the bedtime gate are on.
  const rec = await playSeason({
    ...opts, seed, maxMessages: opts.maxMessages ?? 1500,
    watch: async (ctx) => { const s = ctx as unknown as Stop; if (await stopWhen(s)) { at = s; return true; } return false; },
  });
  if (!at) throw new NotReached(`seed ${seed}: the played season never reached the stop (${rec.stopped} after ${rec.messages} messages)`);
  return at;
}

/** The player's own knowledge that reached them through a houseguest (never the Diary Room, which has no in-game pathway). */
export const learned = (s: Stop): KnowledgeFact[] => s.engine.knowledge.knownTo(PLAYER).filter((f) => f.pathway !== "diary-room");

/** The night period with nothing open (no decision, no staged ceremony): the player may turn in. */
export const bedtimeNow = (s: Stop): boolean =>
  ["night", "late-night"].includes(s.sess.gameStatus().timeOfDay ?? "") && !s.sess.getGameState().pending && !s.sess.live?.ceremony;
