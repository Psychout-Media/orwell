import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";
import type { FavorEntry } from "../../src/engine/favors";

/**
 * 0171 test seam. Drives the REAL adapter through a registry sandbox. TEST-ONLY seams: the live season (a played game), the relationship edges, the vote-doubt read and the private tally / swap-offer methods.
 * Roles only: a holder, a debtor, witnesses, a bystander.
 */
export type Edge = { trust: number; affinity: number; threat: number };
export type Seam = {
  live: { playedGame?: boolean; owedFavors?: Array<{ debtor: string; n: number; madeWeek: number }>; favorConditions?: Array<{ state: string; target: string; kind: string; owedBy: string; owedTo: string }>; grudges?: Record<string, unknown>; bonds?: Record<string, unknown>; npcMemory?: Record<string, Record<string, unknown[]>>; finished?: boolean; week: number; dayNumber?: number; dealOffer?: { id: string; from: string; kind: string; terms: string; madeWeek: number; replacesDealId?: string; counter?: { round: number; ask: { kind: string; target?: string } }; favor?: { favorId?: string } }; lastDealOfferWeek?: number; evictionOrder: string[]; agendas?: unknown };
  rel: { edge(a: string, b: string): Edge };
  gameSeed: number | null;
  voteStillInDoubt: (a: string, b: string) => boolean;
  agendaPullOf: (t: string, d: string) => { value: number };
  favorsAtTally(fn: readonly string[], voters: readonly string[]): void;
  favorCounterAsk(npc: string, deal: unknown, living: readonly string[]): { kind: string; target?: string } | undefined;
  resolveDealOffer(accept: boolean): unknown;
  presence?: Map<string, string>;
  deals: { make(parties: [string, string], kind: string, terms: string, ev?: string, week?: number): { id: string } };
};
export type Played = { sb: UserSandbox; session: GameSessionAdapter; seam: Seam; npcs: string[]; seed: number };

let n = 0;
export function playedSession(seed: number, opts: { favors?: boolean } = {}): Played {
  const sb = new GameSessionRegistry().sandboxFor(`favors0171-${n++}`);
  sb.session.setFavorsEnabled(opts.favors ?? true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const seam = sb.session as unknown as Seam;
  seam.live.playedGame = true;
  seam.voteStillInDoubt = () => true; // the count is close
  return { sb, session: sb.session, seam, npcs: sb.session.livingIds().filter((id) => id !== PLAYER), seed };
}

/** The seeded roll the called-in favor's debtor answers with (the same stream the adapter draws). */
export function callRoll(p: Played, favorId: string): number {
  return new SeededRandom(hashSeed(`${p.seam.gameSeed ?? 0}:favors:call:${favorId}:${p.seam.live.week}`)).next();
}

/** Find a seed where the first favor's call roll is below `cut` (honored for sure when p >= cut) or at/above it (refused for sure when p <= cut). */
export function sessionWithRoll(want: "honor" | "refuse"): Played {
  for (let seed = 1; seed < 400; seed++) {
    const p = playedSession(seed);
    const r = callRoll(p, "favor:1");
    if (want === "honor" ? r < 0.6 : r >= 0.4) return p;
  }
  throw new Error("no seed found");
}

export function setEdge(p: Played, a: string, b: string, e: Edge): void { Object.assign(p.seam.rel.edge(a, b), e); }
/** Make a debtor read the holder warmly (a favor is honored) or coldly and threatened (it is refused). */
export function warm(p: Played, debtor: string, holder: string): void { setEdge(p, debtor, holder, { trust: 0.9, affinity: 0.9, threat: 0 }); }
export function cold(p: Played, debtor: string, holder: string): void { setEdge(p, debtor, holder, { trust: 0, affinity: 0, threat: 1 }); }
export const ledger = (p: Played): readonly FavorEntry[] => p.session.favorLedger();

/** Put the listed houseguests in one room (awake and present) and everyone else in another. */
export function gather(p: Played, ids: readonly string[]): void {
  const m = new Map<string, string>();
  for (const id of [PLAYER, ...p.npcs]) m.set(id, ids.includes(id) ? "kitchen" : "elsewhere");
  p.seam.presence = m;
}
