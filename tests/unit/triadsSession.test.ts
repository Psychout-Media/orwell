import { describe, it, expect } from "vitest";
import { playDealsGame } from "../support/npcDealsDriver";
import { PLAYER } from "../../src/domain/ids";
import { seamOf, triadSession, flatten, close, runDays } from "../support/triadsSeam";

/** Feature 0174 - the live session: a PLAYED chat-paced game keeps triad history only with the flag on, deterministically, and nothing of it reaches a view. Roles only. */
type Live = { week: number; triads?: { drift?: Record<string, number>; courted?: unknown[]; kingmakers?: Array<{ week: number; voter: string; evictee: string }> }; evictionOrder: string[]; voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }> };
async function season(seed: number, on: boolean, weeks = 5) {
  const prev = process.env.ORWELL_TRIADS; process.env.ORWELL_TRIADS = on ? "1" : "0";
  try {
    const g = await playDealsGame(seed, 2500, { advanceEvery: 6, user: `triads-${seed}-${on}`, until: (x) => x.week() >= weeks });
    const live = (g.session as unknown as { live: Live }).live;
    return { g, live, json: JSON.stringify(live.triads ?? null) };
  } finally { if (prev === undefined) delete process.env.ORWELL_TRIADS; else process.env.ORWELL_TRIADS = prev; }
}

describe("a played season (ORWELL_TRIADS)", () => {
  it("keeps triad drift and a kingmaker history, reproducibly, only with the flag on; the kingmaker is one of the ballots that evicted", async () => {
    const a = await season(2, true), b = await season(2, true), off = await season(2, false);
    expect(a.json).toBe(b.json);
    expect(off.live.triads).toBeUndefined();
    expect(Object.keys(a.live.triads?.drift ?? {}).length).toBeGreaterThan(0);
    for (const k of a.live.triads?.kingmakers ?? []) {
      const rec = a.live.voteRecord!.find((r) => r.week === k.week)!;
      expect(rec.evictee).toBe(k.evictee);
      expect(Object.keys(rec.voteOf)).toContain(k.voter); // a ballot that was cast (or the HOH tie-break in the record)
    }
  }, 600_000);
  it("no player or admin view carries a triad, a courted flag or a kingmaker while the season lives", async () => {
    const s = await season(3, true, 4);
    const sb = s.g.reg.sandboxFor(s.g.user);
    const out = JSON.stringify([await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {})]);
    expect(out).not.toMatch(/courted|"triads"|kingmaker|lastGaps|"drift"/i);
  }, 600_000);
});

describe("the daily drift is bounded", () => {
  it("a pair never drifts past the cap however many days pass, and the player's own edges are never nudged", () => {
    const p = triadSession(9); flatten(p);
    const [a, b, c] = p.npcs;
    close(p, c!, a!); close(p, c!, b!);
    const before = JSON.stringify([PLAYER, ...p.npcs].map((x) => p.seam.rel.edge(x, PLAYER)));
    runDays(p, 120);
    const drift = seamOf(p).live.triads!.drift!;
    for (const v of Object.values(drift)) expect(v).toBeLessThanOrEqual(0.1 + 0.012);
    expect(JSON.stringify([PLAYER, ...p.npcs].map((x) => p.seam.rel.edge(x, PLAYER)))).toBe(before);
  });
  it("the daily step runs once per in-game day", () => {
    const p = triadSession(9); flatten(p);
    const [a, b, c] = p.npcs; close(p, c!, a!); close(p, c!, b!);
    const s = seamOf(p); s.live.dayNumber = 5;
    s.triadsTick(); const once = JSON.stringify(s.live.triads); s.triadsTick();
    expect(JSON.stringify(s.live.triads)).toBe(once);
  });
});

describe("the vote pitch's own offer slot", () => {
  it("lets the ordinary approach and the pitch stand together, and the engine answers neither", () => {
    let raised = 0;
    for (let seed = 1; seed <= 24 && raised === 0; seed++) {
      const p = triadSession(seed); flatten(p);
      const n = p.npcs, s = seamOf(p), live = s.live;
      const [x, y, swing, a, b] = [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!];
      close(p, x, a); close(p, y, b);
      for (const k of [x, y, a, b]) close(p, k, swing, 0.8);
      live.dealOffer = { id: "ordinary", from: n[5]!, kind: "safety", terms: "an ordinary approach", madeWeek: live.week };
      live.lastDealOfferWeek = live.week;
      s.swingAtVote({ nominees: [x, y], voters: [swing, a, b, PLAYER], previews: [{ voter: a, pick: x, gap: 0.5 }, { voter: b, pick: y, gap: 0.5 }, { voter: swing, pick: x, gap: 0.5 }] });
      if (!live.votePitch) continue;
      raised++;
      expect(live.dealOffer?.id).toBe("ordinary");
      expect(live.pending).toBeUndefined();
      expect(JSON.stringify(live.votePitch)).not.toMatch(/courted|kingmaker|drift|gap/i);
    }
    expect(raised).toBeGreaterThan(0);
  });
  it("is never raised with the flag off", () => {
    const p = triadSession(3, { triads: false }); flatten(p);
    const n = p.npcs; close(p, n[0]!, n[3]!); close(p, n[1]!, n[4]!);
    seamOf(p).swingAtVote({ nominees: [n[0]!, n[1]!], voters: [n[2]!, n[3]!, n[4]!, PLAYER], previews: [{ voter: n[3]!, pick: n[0]!, gap: 0.5 }, { voter: n[4]!, pick: n[1]!, gap: 0.5 }] });
    expect(seamOf(p).live.votePitch).toBeUndefined();
    expect(seamOf(p).live.dealOffer).toBeUndefined();
  });
});
