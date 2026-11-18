import { hallEntry, type HallEntry } from "./seasonMemory";
import { YOUR_EDIT, type EditFact, type YourEditView } from "./yourEdit";

/**
 * 0208 B3 (ORW-665) - THE HALL OF FAME: one record per finished season the player played, kept per user outside any game. PURE: no I/O, no rng, no Vault handle.
 *
 * It holds only what the finished season's retrospective already unsealed to the player (placement, who was crowned, the player's own comp wins, their best move and the
 * worst betrayal done to them, as facts with names). The narrator voices it live from these facts; nothing here is a line to recite and no number is shown. A past
 * season's NPC ids mean nothing to a later season, so people are held by name.
 */
export interface HallCounts { compWins: number; betrayalsReceived: number; blindsidesReceived: number; dealsBrokenOnYou: number; dealsBroken: number }

export interface HallRecord extends HallEntry {
  castSize: number;
  winnerName?: string;
  runnerUpName?: string;
  /** The player's own deeds the season (counts of their own acts and what was done to them); absent when the edit view was off. */
  counts?: HallCounts;
  /** The best thing the player did that season: an edit fact whose actor is the player and which reads well for its actor. */
  bestMove?: EditFact;
  /** The worst thing done to the player: a betrayal or blindside with the player as its subject. */
  worstBetrayal?: EditFact;
}

export interface HallInput {
  season: number;
  placement: number;
  juror: boolean;
  castSize: number;
  playerName: string;
  winnerName?: string;
  runnerUpName?: string;
  /** The player's side of the unsealed "your edit" (`YourEditView.you`), when that view was built. */
  you?: YourEditView["you"];
}

const against = new Set(["betrayal", "blindside"]);

export function buildHallRecord(inp: HallInput): HallRecord {
  const facts = inp.you?.because ?? [];
  const best = facts.find((f) => f.actor === inp.playerName && (YOUR_EDIT.actor[f.kind] ?? 0) > 0);
  const worst = facts.find((f) => against.has(f.kind) && f.subject === inp.playerName && f.actor !== inp.playerName);
  const y = inp.you;
  return {
    ...hallEntry(inp.season, inp.placement, inp.juror),
    castSize: inp.castSize,
    ...(inp.winnerName ? { winnerName: inp.winnerName } : {}),
    ...(inp.runnerUpName ? { runnerUpName: inp.runnerUpName } : {}),
    ...(y ? { counts: { compWins: y.compWins, betrayalsReceived: y.betrayalsReceived, blindsidesReceived: y.blindsidesReceived, dealsBrokenOnYou: y.dealsBrokenOnYou, dealsBroken: y.dealsBroken } } : {}),
    ...(best ? { bestMove: { ...best } } : {}),
    ...(worst ? { worstBetrayal: { ...worst } } : {}),
  };
}

/** The monotonic merge (non-degradation): every stored season stays exactly as first written (a finished season never changes); a new season is added; ordered by season. */
export function mergeHall(existing: readonly HallRecord[] | null, incoming: readonly HallRecord[]): HallRecord[] {
  const bySeason = new Map<number, HallRecord>();
  for (const r of incoming) bySeason.set(r.season, r);
  for (const r of existing ?? []) bySeason.set(r.season, r);
  return [...bySeason.values()].sort((a, b) => a.season - b.season);
}

/** Does `after` keep everything in `before` (the superset check the persistence gate runs)? */
export const hallKeepsAll = (before: readonly HallRecord[], after: readonly HallRecord[]): boolean =>
  before.every((b) => after.some((a) => a.season === b.season && JSON.stringify(a) === JSON.stringify(b)));

/** The player-facing read: the finished seasons in order, with how many were won. Public facts only. */
export interface HallOfFameView { seasonsPlayed: number; won: number; seasons: HallRecord[] }
export function hallView(records: readonly HallRecord[]): HallOfFameView {
  const seasons = mergeHall(null, records);
  return { seasonsPlayed: seasons.length, won: seasons.filter((s) => s.result === "won").length, seasons };
}
