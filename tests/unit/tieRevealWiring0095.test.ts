import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";
import { TIE_REVEAL } from "../../src/engine/tieRevealConstants";
import type { PreGameTie } from "../../src/engine/seededRelationships";
import { npc, PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0095 — the live WIRING: the pre-show-tie reveal round-trips through the snapshot, is
 * Vault-sealed off every player AND admin surface until a pathway fires, `accuseTie` reaches the
 * engine over the MCP boundary and lands/misses correctly, and — with the layer OFF (the default) —
 * the whole pathway is a total no-op (the calibration guarantee). Roles only.
 */

afterEach(() => GameSessionAdapter.setTieRevealEnabled(null));

/** A live game whose seeded layer has at least one pre-game TIE (sparseness ⇒ most seeds have none). */
function gameWithATie(prefix: string): { reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]>; tie: PreGameTie } {
  for (let seed = 1; seed <= 300; seed++) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`${prefix}-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const ties = sb.session.snapshot().seededRelationships?.ties ?? [];
    if (ties.length > 0) return { reg, sb, tie: ties[0]! };
  }
  throw new Error("no seed produced a pre-game tie within the probe range");
}

type WithTieState = { tieExposureCount: number; tieRevealTickCount: number };
const peek = (s: GameSessionAdapter): WithTieState => s as unknown as WithTieState;

describe("0095 accuseTie — the single player-reachable authority (lands / misses)", () => {
  it("lands on a real seeded tie: exposes it, folds the fallout, no Vault read on a miss path", () => {
    const { sb, tie } = gameWithATie("accuse-hit");
    const res = sb.session.accuseTie(tie.a, tie.b);
    expect(res).toEqual({ landed: true });
    const after = sb.session.snapshot().seededRelationships!.ties.find(
      (t) => (t.a === tie.a && t.b === tie.b) || (t.a === tie.b && t.b === tie.a),
    );
    expect(after?.exposure).toBe("public");
  });

  it("misses on a pair with no seeded tie: no exposure, no edge touched, an ordinary scene", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("accuse-miss");
    sb.session.createCharacter({ playerName: "The Player", seed: 999 });
    const before = sb.session.snapshot().seededRelationships?.ties ?? [];
    const res = sb.session.accuseTie(npc(11), npc(12)); // near-strangers, no seeded tie between them
    expect(res).toEqual({ landed: false });
    const after = sb.session.snapshot().seededRelationships?.ties ?? [];
    expect(after).toEqual(before); // untouched
  });

  it("only houseguests actually present re-read the pair — one in another room does not (audit band D F5)", () => {
    const { sb, tie } = gameWithATie("accuse-presence");
    const s = sb.session;
    const others = s.livingIds().filter((id) => id !== PLAYER && id !== tie.a && id !== tie.b);
    const [away, here] = [others[0]!, others[1]!];
    // Step past any whole-house gathering (the premiere, a ceremony) — there everyone is present by design.
    let separated = false;
    for (let i = 0; i < 60 && !separated; i++) {
      const room = s.whereabouts()?.room;
      if (room) {
        s.recordHouseguestMove(away, room === "backyard" ? "kitchen" : "backyard");
        s.recordHouseguestMove(here, room);
        const present = s.whereabouts()!.present.map((p) => p.id);
        separated = !present.includes(away) && present.includes(here);
      }
      if (!separated) {
        const v = s.advanceGame();
        const p = v.pending;
        if (p?.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
        else if (p?.kind === "comp-intent" || p?.kind === "comp-round") s.submitDecision({ kind: p.kind, intent: "compete" });
        else if (p) s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
      }
    }
    expect(separated, "test setup: reached a moment with one houseguest in another room").toBe(true);
    if (!s.livingIds().includes(tie.a) || !s.livingIds().includes(tie.b)) return; // tie pair evicted — nothing to accuse
    const rel = (s as unknown as { rel: { edge(a: EntityId, b: EntityId): { trust: number } } }).rel;
    const awayBefore = rel.edge(away, tie.a).trust;
    const hereBefore = rel.edge(here, tie.a).trust;
    expect(s.accuseTie(tie.a, tie.b)).toEqual({ landed: true });
    expect(rel.edge(away, tie.a).trust).toBe(awayBefore); // not there ⇒ no reaction
    expect(rel.edge(here, tie.a).trust).toBeLessThan(hereBefore); // there ⇒ betrayal-grade re-read
  });

  it("shows no number and no tell distinguishing a hit from a miss beyond `landed`", () => {
    const { sb, tie } = gameWithATie("accuse-tell");
    const hit = sb.session.accuseTie(tie.a, tie.b);
    const miss = sb.session.accuseTie(npc(13), npc(14));
    expect(Object.keys(hit!).sort()).toEqual(["landed"]);
    expect(Object.keys(miss!).sort()).toEqual(["landed"]);
  });

  it("reaches the engine over the MCP boundary (the four-place wiring is live, not a silent no-op)", async () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("accuseTie");
    const { sb, tie } = gameWithATie("accuse-mcp");
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session: sb.session });
    const res = (await server.callTool("accuseTie", { aId: tie.a, bId: tie.b })) as { landed: boolean };
    expect(res.landed).toBe(true);
  });

  it("is capped per season — once the cap is spent, even a real tie can no longer expose further", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("accuse-cap");
    // Force two independent seeded ties by direct injection (bypassing the sparse seed search) so the
    // cap (default 2) is exercised deterministically regardless of how many ties this seed happened to load.
    sb.session.createCharacter({ playerName: "The Player", seed: 5 });
    const inject = sb.session as unknown as { seededRels: { ties: PreGameTie[] } };
    inject.seededRels.ties = [
      { a: npc(1), b: npc(2), nature: "old-acquaintance" },
      { a: npc(3), b: npc(4), nature: "shared-hometown" },
      { a: npc(5), b: npc(6), nature: "mutual-friend" },
    ];
    expect(sb.session.accuseTie(npc(1), npc(2))).toEqual({ landed: true });
    expect(sb.session.accuseTie(npc(3), npc(4))).toEqual({ landed: true });
    expect(peek(sb.session).tieExposureCount).toBe(TIE_REVEAL.maxExposuresPerSeason);
    expect(sb.session.accuseTie(npc(5), npc(6))).toEqual({ landed: false }); // cap spent — even a real tie misses
  });
});

describe("0095 — Vault Wall holds (player AND admin) until a pathway fires", () => {
  it("a sealed tie never appears on any player-facing surface", () => {
    const { sb, tie } = gameWithATie("vault-player");
    const ids = sb.session.snapshot().house!.npcs.map((n: { id: EntityId }) => n.id);
    const blob = JSON.stringify([
      ...ids.map((id: EntityId) => sb.session.npcVoice(id)),
      sb.session.gameStatus(),
      sb.session.whereabouts(),
    ]);
    expect(blob).not.toMatch(new RegExp(tie.nature));
    expect(blob).not.toMatch(/casting-callback|mutual-friend|shared-hometown|old-acquaintance/);
  });

  it("a sealed tie never appears on the admin/God-Mode surface", () => {
    const admin = buildSandbox(1).adminOutput();
    expect(admin).not.toMatch(/pre-game-tie|casting-callback|old-acquaintance/);
  });

  it("an exposed (public) tie DOES surface via the Vault-free `exposedTies` projection, a sealed one never does", async () => {
    const seededRel = await import("../../src/engine/seededRelationships");
    const sealed: PreGameTie = { a: npc(1), b: npc(2), nature: "old-acquaintance" };
    const pub: PreGameTie = { a: npc(3), b: npc(4), nature: "mutual-friend", exposure: "public" };
    const exposed = seededRel.exposedTies([sealed, pub]);
    expect(exposed).toEqual([{ a: npc(3), b: npc(4) }]);
  });
});

describe("0095 — persistence: exposure survives a restart, monotonic, non-degrading", () => {
  it("round-trips an exposed tie through a snapshot/restore", () => {
    const { sb, tie } = gameWithATie("persist");
    sb.session.accuseTie(tie.a, tie.b);
    const snap = sb.session.snapshot();
    const revived = new GameSessionAdapter();
    revived.restore(snap);
    const restoredTie = revived.snapshot().seededRelationships!.ties.find(
      (t) => (t.a === tie.a && t.b === tie.b) || (t.a === tie.b && t.b === tie.a),
    );
    expect(restoredTie?.exposure).toBe("public");
    expect(peek(revived).tieExposureCount).toBe(1);
  });

  it("a pre-0095 save (no exposure field on any tie) restores every tie to sealed, re-derives cleanly", () => {
    const { sb } = gameWithATie("legacy");
    const snap = sb.session.snapshot();
    for (const t of snap.seededRelationships?.ties ?? []) delete (t as Partial<PreGameTie>).exposure;
    delete (snap as unknown as Record<string, unknown>)["tieExposureCount"];
    delete (snap as unknown as Record<string, unknown>)["tieRevealTickCount"];
    const revived = new GameSessionAdapter();
    expect(() => revived.restore(snap)).not.toThrow();
    for (const t of revived.snapshot().seededRelationships?.ties ?? []) expect(t.exposure ?? "sealed").toBe("sealed");
    expect(peek(revived).tieExposureCount).toBe(0);
  });
});

describe("0095 — calibration-neutral: OFF is a total no-op", () => {
  it("advanceTieReveal returns [] and touches nothing when the flag is off (it defaults ON since 2026-11-05, so this pins it OFF explicitly)", () => {
    GameSessionAdapter.setTieRevealEnabled(false);
    const { sb } = gameWithATie("off-default");
    const before = sb.session.snapshot().seededRelationships;
    const events = sb.session.advanceTieReveal(sb.engine.knowledge);
    expect(events).toEqual([]);
    expect(sb.session.snapshot().seededRelationships).toEqual(before);
    expect(peek(sb.session).tieRevealTickCount).toBe(0);
  });

  it("advanceTieReveal is a no-op even when forced off explicitly via the static override", () => {
    GameSessionAdapter.setTieRevealEnabled(false);
    const { sb } = gameWithATie("off-forced");
    expect(sb.session.advanceTieReveal(sb.engine.knowledge)).toEqual([]);
    expect(peek(sb.session).tieRevealTickCount).toBe(0);
  });
});
