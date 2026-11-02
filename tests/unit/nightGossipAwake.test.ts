import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { linger } from "../support/linger";

/**
 * #1913 — at night, a houseguest who has gone to bed neither starts, hears nor relays a rumor (ADR 0006).
 * Drives the registry's own seams (rumor threads, the to-player relay, the deal-reputation spread) with an
 * asleep NPC and proves nothing reaches them. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

interface Seams {
  onThreadGossip: (origin: EntityId, rumor: string, subject: EntityId) => void;
  onThreadSurfaceToPlayer: (subject: EntityId, rumor: string) => boolean;
  onTieSurfaceToPlayer: (subject: EntityId, observation: string) => boolean;
  dealReputationSink: (honorer: EntityId, other: EntityId) => void;
}

function resolve(s: GameSession, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round" || p.kind === "comp-intent") s.submitDecision({ kind: p.kind, intent: "compete" });
  else s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}

/** A started season at night with at least one houseguest asleep and one awake. */
function nightHouse(): { sb: ReturnType<GameSessionRegistry["sandboxFor"]>; asleep: EntityId; awake: EntityId[] } {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  for (const seed of [3, 5, 8, 13, 21, 34, 55]) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`night-${seed}`);
    const s = sb.session;
    s.createCharacter({ playerName: "The Player", seed });
    for (let i = 0; i < 40; i++) {
      const npcs = s.livingIds().filter((id) => id !== PLAYER);
      if (s.gameStatus().timeOfDay) {
        const up = s.awakeAmong(npcs);
        if (up.length < npcs.length && up.length >= 2) {
          return { sb, asleep: npcs.find((id) => !up.includes(id))!, awake: up };
        }
        linger(s);
        const up2 = s.awakeAmong(npcs);
        if (up2.length < npcs.length && up2.length >= 2) {
          return { sb, asleep: npcs.find((id) => !up2.includes(id))!, awake: up2 };
        }
      }
      const v = s.advanceGame();
      if (v.pending) resolve(s, v.pending);
    }
  }
  throw new Error("no seed reached a thinned night — test setup");
}

describe("#1913 — sleepers don't gossip", () => {
  it("a rumor whose origin is asleep is never seeded — not even in the origin", () => {
    const { sb, asleep, awake } = nightHouse();
    const seams = sb.session as unknown as Seams;
    const before = sb.engine.knowledge.knownTo(asleep).length;
    seams.onThreadGossip(asleep, "a rumor about someone", awake[0]!);
    expect(sb.engine.knowledge.knownTo(asleep).length).toBe(before);
  });

  it("the deal-reputation spread waits when the partner is asleep", () => {
    const { sb, asleep, awake } = nightHouse();
    const seams = sb.session as unknown as Seams;
    const before = sb.engine.knowledge.knownTo(asleep).length;
    seams.dealReputationSink(awake[0]!, asleep);
    expect(sb.engine.knowledge.knownTo(asleep).length).toBe(before);
  });

  it("the to-player relay is told by someone awake", () => {
    const { sb, awake } = nightHouse();
    const seams = sb.session as unknown as Seams;
    const subject = awake[awake.length - 1]!;
    const tellerOf = (content: string): EntityId | undefined =>
      sb.engine.knowledge.knownTo(PLAYER).find((k) => k.content === content)?.pathway?.replace("told-by:", "") as EntityId | undefined;
    expect(seams.onThreadSurfaceToPlayer(subject, "a rumor for the player"), "the relay reached the player").toBe(true);
    const t1 = tellerOf("a rumor for the player");
    expect(t1).toBeDefined();
    expect(sb.session.awakeAmong([t1!])).toEqual([t1]);
    expect(seams.onTieSurfaceToPlayer(subject, "those two seem tight"), "the tie relay reached the player").toBe(true);
    const t2 = tellerOf("those two seem tight");
    expect(t2).toBeDefined();
    expect(sb.session.awakeAmong([t2!])).toEqual([t2]);
  });
});
