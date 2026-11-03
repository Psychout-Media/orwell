import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { EdgeRecord } from "../../src/domain/saveState";
import type { Deal } from "../../src/domain/deal";
import { conditionFor } from "../../src/domain/deal";
import type { EntityId } from "../../src/domain/ids";
import { resolvePending } from "./answerPending";

/**
 * Shared live-driving helpers for the eviction-night scenarios (0047 + 0130). Everything here goes through the REAL
 * live adapter (`createCharacter` -> `advanceGame` / `submitDecision`) and the registry's in-memory snapshot/restore seam (a rebuild from a
 * snapshot; the disk save/load round-trip is exercised by the durable-persistence scenarios) - never a hand-built pure season. Roles only.
 */
export type LivePending = NonNullable<AdvanceView["pending"]>;

export interface LiveGame {
  reg: GameSessionRegistry;
  user: string;
  session: GameSessionAdapter;
  seed: number;
}

let games = 0;
/** A fresh live game on its own registry. */
export function newLiveGame(seed: number, tag = "night"): LiveGame {
  const reg = new GameSessionRegistry();
  const user = `${tag}${games++}`;
  const session = reg.sandboxFor(user).session;
  session.createCharacter({ playerName: "P", seed });
  return { reg, user, session, seed };
}

/** The live game's full engine snapshot as an independent deep copy (safe to edit before a restore). */
export function cloneSnapshot(g: LiveGame): SessionSnapshot {
  return structuredClone(g.reg.snapshot(g.user));
}

/** Restore a snapshot into a FRESH registry (a restart) and return the resumed game. The snapshot is cloned, never shared. */
export function resumeFrom(snap: SessionSnapshot, seed: number, tag = "resumed"): LiveGame {
  const reg = new GameSessionRegistry();
  const user = `${tag}${games++}`;
  reg.restore(user, structuredClone(snap));
  return { reg, user, session: reg.sandboxFor(user).session, seed };
}

/** Answer whatever player decision `v` raised with the shared faithful driver (unknown kinds throw). */
export function answer(g: LiveGame, p: LivePending): void {
  resolvePending(p, (req) => g.session.submitDecision(req));
}

/**
 * Advance the live game (answering any player decision on the way with the shared driver) until `stop` accepts a view
 * or `bound` advances pass. `stop` is tried on each advance view BEFORE its pending is answered, so a caller can park the
 * game exactly AT a pending. Returns the accepting view, or `null` if the game finished / the bound ran out.
 */
export function advanceUntil(g: LiveGame, stop: (v: AdvanceView) => boolean, bound = 8000, trail?: AdvanceView[]): AdvanceView | null {
  for (let i = 0; i < bound; i++) {
    const v = g.session.advanceGame();
    trail?.push(v);
    if (stop(v)) return v;
    if (v.finished) return null;
    if (v.pending) answer(g, v.pending);
  }
  return null;
}

/** Try seeds 1..max with `probe` (which returns a found value or `undefined`); fail LOUDLY if none ever reaches the state. */
export function searchSeeds<T>(what: string, max: number, probe: (seed: number) => T | undefined): T {
  for (let seed = 1; seed <= max; seed++) {
    const found = probe(seed);
    if (found !== undefined) return found;
  }
  throw new Error(`no seed in 1..${max} reached: ${what}`);
}

/**
 * The live game parked AT the player's own pending decision of `kind` (the first seed that gets there). `accept` may refuse a
 * parked pending (the game then answers it and plays on, within the same seed, to the next one of that kind).
 */
export function liveGameAtPlayerPending(
  kind: LivePending["kind"], max = 60, accept?: (game: LiveGame, pending: LivePending) => boolean,
): { game: LiveGame; pending: LivePending; seen: AdvanceView[] } {
  return searchSeeds(`the player at a${accept ? " suitable" : ""} '${kind}' decision`, max, (seed) => {
    const game = newLiveGame(seed, `at-${kind}-`);
    const seen: AdvanceView[] = [];
    for (;;) {
      const v = advanceUntil(game, (view) => view.pending?.kind === kind, 8000, seen);
      if (!v?.pending) return undefined;
      if (!accept || accept(game, v.pending)) return { game, pending: v.pending, seen };
      answer(game, v.pending);
    }
  });
}

/** Directed relationship edge `from -> to` in a snapshot (throws if absent: an edge the scenario reads must exist). */
export function edgeIn(snap: SessionSnapshot, from: EntityId, to: EntityId): EdgeRecord {
  const e = snap.relationships.find((r) => r.from === from && r.to === to);
  if (!e) throw new Error(`no ${from} -> ${to} relationship edge in the snapshot`);
  return e;
}

/** A snapshot with one extra OPEN deal between `parties` (wronged party first, the would-be breaker second) in the ledger. */
export function withOpenDeal(snap: SessionSnapshot, parties: [EntityId, EntityId], kind: Deal["kind"], week: number): SessionSnapshot {
  const out = structuredClone(snap);
  const deal: Deal = {
    id: "deal:bdd-0047-1",
    parties,
    kind,
    terms: "keep each other safe",
    condition: conditionFor(kind, parties),
    status: "open",
    madeWeek: week,
  };
  out.deals = [...(out.deals ?? []), deal];
  return out;
}

/** Per-scenario scratch for the live eviction-night steps (one object on the world, so no step leaks state into another). */
export interface NightScratch {
  game?: LiveGame;
  /** The pending decision the game is parked at. */
  pending?: LivePending;
  /** Every advance view seen on the way to the parked pending (the earlier beats of the night). */
  seen: AdvanceView[];
  /** The engine snapshot taken at the parked pending. */
  snap?: SessionSnapshot;
  /** The result of the decision submitted at the pending. */
  submitted?: AdvanceView;
  /** The views the engine produced after the decision, up to and including the result. */
  chain: AdvanceView[];
  /** Free-form named branches (same-seed re-plays) for the comparison scenarios. */
  branches: Record<string, BranchResult>;
  /** Scenario-specific facts (ids read from the live state). */
  facts: Record<string, unknown>;
}

/** One same-seed re-play from a shared snapshot: its post-decision views and state captures. */
export interface BranchResult {
  views: AdvanceView[];
  submitted?: AdvanceView;
  snap: SessionSnapshot;
  stateJson: string;
}

export const freshScratch = (): NightScratch => ({ seen: [], chain: [], branches: {}, facts: {} });
