import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import { selectableReplacements } from "../../src/domain/eligibility";
import { PLAYER } from "../../src/domain/ids";
import { resolvePending } from "./answerPending";

/**
 * 0019/0020 — a LIVE game parked at a player decision. The 0019/0020 BDDs used to exercise
 * `src/engine/decisions.ts`, a decision seam production replaced with `liveSeason.applyDecision`
 * (audit 2026-10-25). These helpers play a real season through `advanceGame`/`submitDecision` until the
 * PLAYER faces the wanted decision kind, so the scenarios test the binding path the game actually runs.
 * Roles only.
 */
export type LivePending = NonNullable<AdvanceView["pending"]>;

export interface LiveDecisionGame {
  sb: UserSandbox;
  pending: LivePending;
}

/** A simple, legal player policy: compete, take the first legal option, use a veto when holding one. Unknown kinds throw (PAT-1). */
export function resolveLegally(sb: UserSandbox, p: LivePending): void {
  resolvePending(p, (req) => sb.session.submitDecision(req), { useVeto: true });
}

/** Play seeds in order until the player faces a `kind` decision; return the game parked there. */
export function liveGameAtPending(kind: LivePending["kind"], maxSeed = 40): LiveDecisionGame {
  for (let seed = 1; seed <= maxSeed; seed++) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`decision-${kind}-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    for (let i = 0; i < 3000; i++) {
      const v = sb.session.advanceGame();
      if (v.pending?.kind === kind) return { sb, pending: v.pending };
      if (v.finished) break;
      if (v.pending) resolveLegally(sb, v.pending);
    }
  }
  throw new Error(`no seed in 1..${maxSeed} parked the player at a '${kind}' decision`);
}

/** The engine's own replacement-nominee legal set (`selectableReplacements`), fed the LIVE week. */
export function liveReplacementLegalSet(sb: UserSandbox): string[] {
  const live = sb.session.snapshot().live!;
  return selectableReplacements({
    houseguests: live.active,
    player: PLAYER,
    hoh: live.hoh!,
    nominees: live.nominees!,
    ...(live.vetoHolder ? { vetoWinner: live.vetoHolder } : {}),
  });
}

/** The live season state as a stable string — for "the game state is unchanged" checks. */
// The BOARD, not the hidden layer: a free-text social scene legitimately writes the hidden NPC memory ledger (P4g, like the hidden relationship edge it already moves), so that ledger is
// excluded from "the game state did not move" - what must not move is every public/binding field (beat, week, pendings, nominees, votes...).
export const liveStateOf = (sb: UserSandbox): string => {
  const live = (sb.session.snapshot().live ?? null) as (Record<string, unknown> | null);
  if (!live) return JSON.stringify(live);
  const { npcMemory: _hiddenMemory, ...board } = live;
  void _hiddenMemory;
  return JSON.stringify(board);
};
