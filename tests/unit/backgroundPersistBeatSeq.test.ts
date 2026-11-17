import { describe, it, expect } from "vitest";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { Orchestrator } from "../../src/composition/orchestrator";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { PLAYER, npc } from "../../src/domain/ids";

// R-BND-1 / R-BND-2 (#628) — the background-write-back beatSeq invariant, pinned as a boundary gate
// (the fix-ledger's ENG-5 / CONS-2-hardening ask).
//
// The FE-driven, fail-soft enrichment write-backs (0070 `recordOffscreenSceneTexture`, 0062
// `recordWorldSnapshot`) change PROSE, not the board. They must persist DURABLY but must NOT bump the
// closed-set `beatSeq`: a background bump would make the engine's own enrichment task look like a
// concurrent board mutation to the FE's CAS layer and trip a phantom single-tab stale-409 (the A-S3
// fold-drop — a player scene's only consequence fold reconciled-and-skipped). The correct channel is
// the registry's `setOnBackgroundPersist` seam (syncAdmin + invalidateSnapshot + blind save — never
// `commit`). These tests drive the REAL registry-wired sandbox through the REAL MCP boundary, and
// assert durability through the REAL durable path: the registry's canonical R3-cached export
// (`reg.snapshot(user)`, primed before the write so a broken `invalidateSnapshot` would serve stale)
// and an instrumented `UserSaveStore` (what the blind `saveUser` actually wrote, plus a fresh-registry
// resume over the same store — "a restart is a fresh process over the SAME durable store", 0030).
// A regression that reroutes either tool back through the commit funnel, forgets to wire the
// background seam (which falls back to `onPersist` = commit), breaks `invalidateSnapshot`, or drops
// the blind save fails here deterministically. Roles only.

/** An instrumented in-memory UserSaveStore: captures every saveFor, serves loadLatest for a resume. */
class CapturingSaveStore implements UserSaveStore {
  readonly saved = new Map<string, SessionSnapshot[]>();
  saveFor(user: string, snapshot: SessionSnapshot): void {
    const list = this.saved.get(user) ?? [];
    list.push(snapshot);
    this.saved.set(user, list);
  }
  hasSave(user: string): boolean {
    return (this.saved.get(user)?.length ?? 0) > 0;
  }
  loadLatest(user: string): SessionSnapshot | null {
    const list = this.saved.get(user);
    return list && list.length > 0 ? list[list.length - 1]! : null;
  }
}

function wiredSandbox(user: string, seed: number): {
  sb: UserSandbox; server: McpServer; orch: Orchestrator; reg: GameSessionRegistry; store: CapturingSaveStore;
} {
  const store = new CapturingSaveStore();
  const reg = new GameSessionRegistry(store);
  const orch = new Orchestrator(reg, { now: () => seed }, { seed });
  const sb = reg.sandboxFor(user); // registry-wired: onPersist=commit(bump), onBackgroundPersist=blind save
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { sb, server: sb.mcp.player, orch, reg, store };
}

describe("R-BND (#628) — background write-backs persist durably WITHOUT bumping beatSeq", () => {
  it("sanity: a genuine committed mutation DOES bump beatSeq in this same harness (the counter is live)", () => {
    const { sb } = wiredSandbox("bg-bump-sanity", 9101);
    const before = sb.session.gameStatus().beatSeq;
    // A recorded player scene is ONE committed mutation through the single funnel (0065 Part A).
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "scene" });
    expect(sb.session.gameStatus().beatSeq).toBe(before + 1);
  });

  it("R-BND-1: recordOffscreenSceneTexture (0070) leaves beatSeq unchanged and persists the texture", async () => {
    const user = "bg-texture";
    const { sb, server, orch, reg, store } = wiredSandbox(user, 9102);
    // Generate off-screen skeletons (up to a few ticks — a tick may yield none in edge phases).
    let skeletons: { eventId: string }[] = [];
    for (let i = 0; i < 4 && skeletons.length === 0; i++) {
      orch.advance(user, "offscreen-tick");
      // ORW-570: the player-channel skeleton read returns NO hidden scene any more, so the ids of this tick's off-screen scenes come from the engine's own registry (the write-back tool still takes an id).
      skeletons = ((sb.session as unknown as { lastTickOffscreenIds: string[] }).lastTickOffscreenIds).map((eventId) => ({ eventId }));
    }
    expect(skeletons.length).toBeGreaterThan(0); // seeds above are known-good; roles only
    const before = sb.session.gameStatus().beatSeq;
    reg.snapshot(user); // prime the R3 cache: a broken invalidateSnapshot would serve this STALE copy below
    const savesBefore = store.saved.get(user)?.length ?? 0;

    const res = (await server.callTool("recordOffscreenSceneTexture", {
      eventId: skeletons[0]!.eventId,
      content: "R-BND-1 texture write-back",
    })) as { ok: boolean };
    expect(res.ok).toBe(true);

    // The closed-set counter did not move — a background prose enrichment is NOT a board beat.
    expect(sb.session.gameStatus().beatSeq).toBe(before);
    // The registry's CANONICAL export reflects the write: the texture write records no event, so the
    // R3 cache key (rev + event count) only recomputes because the seam ran `invalidateSnapshot`.
    const regSnap = reg.snapshot(user);
    expect(regSnap.textureOverrides?.[skeletons[0]!.eventId]).toBeDefined();
    expect(regSnap.beatSeq).toBe(before);
    // And the blind save actually REACHED the durable store (saveUser ran — the write is not pending
    // on some later unrelated commit).
    expect(store.saved.get(user)!.length).toBeGreaterThan(savesBefore);
    const durable = store.loadLatest(user)!;
    expect(durable.textureOverrides?.[skeletons[0]!.eventId]).toBeDefined();
    expect(durable.beatSeq).toBe(before); // the durably-saved counter matches the live one — no hidden bump
  });

  it("R-BND-2: recordWorldSnapshot (0062 zeitgeist) leaves beatSeq unchanged and freezes the capture", async () => {
    const user = "bg-zeitgeist";
    const { sb, server, reg, store } = wiredSandbox(user, 9103);
    const before = sb.session.gameStatus().beatSeq;
    reg.snapshot(user); // prime the R3 cache (see R-BND-1 above)
    const savesBefore = store.saved.get(user)?.length ?? 0;

    const res = (await server.callTool("recordWorldSnapshot", {
      slices: { news: ["a headline the house half-remembers"], mood: "restless" },
    })) as { accepted: boolean; source: string };
    expect(res.accepted).toBe(true);
    expect(res.source).toBe("web_search");

    // No closed-set movement…
    expect(sb.session.gameStatus().beatSeq).toBe(before);
    // …but the capture is durably frozen onto the season: visible through the registry's canonical
    // export AND written through to the durable store (non-degradation: persisted, not pending).
    const regSnap = reg.snapshot(user);
    expect(regSnap.worldSnapshot?.source).toBe("web_search");
    expect(regSnap.beatSeq).toBe(before);
    expect(store.saved.get(user)!.length).toBeGreaterThan(savesBefore);
    const durable = store.loadLatest(user)!;
    expect(durable.worldSnapshot?.source).toBe("web_search");
    expect(durable.beatSeq).toBe(before);
  });

  it("the background persist survives a RESTART — a fresh registry resumes it from the durable store", async () => {
    const user = "bg-roundtrip";
    const { sb, server, store } = wiredSandbox(user, 9104);
    const before = sb.session.gameStatus().beatSeq;
    await server.callTool("recordWorldSnapshot", { slices: { mood: "electric" } });
    expect(sb.session.gameStatus().beatSeq).toBe(before);

    // A restart is a fresh process (NEW registry) over the SAME durable store (0030): the resume must
    // rehydrate from what the blind saveUser wrote — the enrichment is there, at the same beatSeq.
    // This exercises the real durable reload path (hasSave → loadLatest → importSnapshot), not an
    // in-memory copy handed straight to restore().
    const reg2 = new GameSessionRegistry(store);
    const sb2 = reg2.sandboxFor(user);
    expect(sb2.session.gameStatus().beatSeq).toBe(before);
    expect(reg2.snapshot(user).worldSnapshot?.slices.mood).toBe("electric");
  });
});
