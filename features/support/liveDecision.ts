import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";

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

/** A simple, legal player policy: compete, take the first legal option, use a veto when holding one. */
export function resolveLegally(sb: UserSandbox, p: LivePending): void {
  const s = sb.session;
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") {
    s.submitDecision(p.options[0] ? { kind: "veto-decision", use: true, save: p.options[0].id } : { kind: "veto-decision", use: false });
  } else if (p.kind === "comp-intent" || p.kind === "comp-round") s.submitDecision({ kind: p.kind, intent: "compete" } as never);
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id } as never);
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

/** The live season state as a stable string — for "the game state is unchanged" checks. */
export const liveStateOf = (sb: UserSandbox): string => JSON.stringify(sb.session.snapshot().live);
