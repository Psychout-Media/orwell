import type { AdvanceView } from "../../src/ports/GameSession";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EvictionManner } from "../../src/engine/jury";
import type { EdgeSignals } from "../../src/engine/relationshipConstants";
import { npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { answerPending } from "./answerPending";

// Shared by 0037 (jury choreography) and 0014 (jury & endgame): a REAL per-user sandbox restored to Final 2 and
// driven only through the live adapter (advanceGame/submitDecision), so no scenario hand-builds a finale object.

export type Player = import("../../src/adapters/mcp/McpServer").McpServer;

export const adv = async (p: Player): Promise<AdvanceView> => (await p.callTool("advanceGame", {})) as AdvanceView;

export interface FinaleFixture {
  finalists: [EntityId, EntityId];
  jury: EntityId[];
  edgeTo?: (juror: EntityId, finalist: EntityId) => Partial<EdgeSignals>;
  manner?: Record<EntityId, Record<EntityId, EvictionManner>>;
}

/** A neutral directed edge (the live model's beliefs are graded, not binary). */
function edge(from: EntityId, to: EntityId, s: Partial<EdgeSignals>): { from: EntityId; to: EntityId } & EdgeSignals {
  return { from, to, trust: 0.5, affinity: 0.5, threat: 0.3, alignment: 0, confidence: 0.5, reliability: 0.3, ...s };
}

/**
 * Stand up a real per-user sandbox at Final 2 by creating a game (for the real names + house)
 * and RESTORING a crafted Final-2 snapshot through the registry — so the finale is driven
 * entirely through the live adapter (advanceGame/submitDecision), not a hand-built object.
 */
export async function liveFinale(user: string, seed: number, fx: FinaleFixture): Promise<{ reg: GameSessionRegistry; player: Player }> {
  const reg = new GameSessionRegistry();
  const player = reg.resolver()("player", user) as Player;
  await player.callTool("createCharacter", { playerName: "Player", seed });
  const snap = reg.snapshot(user) as SessionSnapshot;

  const live: LiveSeasonState = {
    week: 9, beat: "finale", active: [...fx.finalists], vetoUsed: false,
    evictionOrder: [...fx.jury], finished: false,
    ...(fx.manner ? { mannerByEvictee: fx.manner } : {}),
  };
  // Craft the jury leans as directed relationship edges (juror → finalist).
  const edges: Array<{ from: EntityId; to: EntityId } & EdgeSignals> = [];
  for (const j of fx.jury) for (const f of fx.finalists) edges.push(edge(j, f, fx.edgeTo?.(j, f) ?? {}));
  snap.live = live;
  snap.relationships = edges;
  reg.restore(user, snap);
  return { reg, player: reg.resolver()("player", user) as Player };
}

/** The default 9-juror panel ids (kept distinct from the two finalists). */
export const JURY9 = Array.from({ length: 9 }, (_, i) => npc(i + 1));

/** Drive the finale to completion, answering player decisions with a fixed policy. Collect views. */
export async function driveFinaleSeam(
  p: Player, policy: { appeal?: string; jurorVote?: (d: NonNullable<AdvanceView["pending"]>) => string; onView?: (v: AdvanceView) => Promise<void> } = {},
): Promise<AdvanceView[]> {
  const views: AdvanceView[] = [];
  for (let i = 0; i < 2000; i++) {
    const v = await adv(p);
    views.push(v);
    if (policy.onView) await policy.onView(v);
    if (v.finished) break;
    if (v.pending) {
      const d = v.pending;
      if (d.kind === "finale-statement") await p.callTool("submitDecision", { kind: "finale-statement", statement: "My case." });
      else if (d.kind === "finale-answer") await p.callTool("submitDecision", { kind: "finale-answer", appeal: policy.appeal ?? d.appeals![0]! });
      else if (d.kind === "juror-vote") await p.callTool("submitDecision", { kind: "juror-vote", vote: policy.jurorVote ? policy.jurorVote(d) : d.options[0]!.id });
      else if (d.kind === "nominations") await p.callTool("submitDecision", { kind: "nominations", choice: [d.options[0]!.id, d.options[1]!.id] });
      else if (d.kind === "veto-decision") await p.callTool("submitDecision", { kind: "veto-decision", use: false });
      else if (d.kind === "replacement") await p.callTool("submitDecision", { kind: "replacement", replacement: d.options[0]!.id });
      else {
        const req = answerPending(d); // any other kind: the shared driver (unknown kinds throw)
        if (req) await p.callTool("submitDecision", req as unknown as Record<string, unknown>);
      }
    }
  }
  return views;
}

