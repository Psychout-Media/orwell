import { describe, it, expect } from "vitest";
import { liveFinale, driveFinaleSeam, JURY9 } from "../../features/support/liveFinale";
import { PLAYER, npc } from "../../src/domain/ids";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { GrudgeBook } from "../../src/engine/grudges";
import type { EvictionManner } from "../../src/engine/jury";
import { bitterJurorExtra, juryLean, mannerLeanOf, JURY_WEIGHTS } from "../../src/engine/jury";
import { JURY_GRUDGE, MANNER_LEAN } from "../../src/engine/juryConstants";
import { JURY_HOUSE } from "../../src/engine/juryHouseConstants";

/**
 * Feature 0182 (Theme 3 slice 5, ORW-569) PR 3: BITTER JURORS. A juror who holds a grudge against a finalist leans away from them at the finale, more when it is fresh, less when repaired
 * (never zero), and never twice for a wrong the manner / memory terms already count. Real Final-2 games driven through the live seam; roles only.
 */
const RIVAL = npc(10);
const EVEN = { trust: 0.5, affinity: 0.5, threat: 0.3 };
type Opts = { grudge?: "none" | "grudge"; weekNow?: number; grudgeWeek?: number; severity?: number; eased?: number; playedGame?: boolean; flag?: boolean; manner?: EvictionManner; kind?: "cut-by-ally" | "lied-to" };

async function game(seed: number, o: Opts = {}): Promise<{ playerVotes: number; total: number; adapter: GameSessionAdapter; user: string }> {
  const user = `bitter-${seed}-${(++uid).toString(36)}`;
  const { reg } = await liveFinale(user, seed, {
    finalists: [PLAYER, RIVAL], jury: JURY9, edgeTo: () => EVEN,
    ...(o.manner ? { manner: Object.fromEntries(JURY9.map((j) => [j, { [PLAYER]: o.manner! }])) } : {}),
  });
  const snap = reg.snapshot(user) as SessionSnapshot;
  const live = snap.live as unknown as { week: number; playedGame?: boolean; grudges?: GrudgeBook };
  live.week = o.weekNow ?? 9;
  live.playedGame = o.playedGame ?? true;
  if (o.grudge === "grudge") {
    live.grudges = Object.fromEntries(JURY9.map((j) => [`${j}|${PLAYER}`, {
      kind: o.kind ?? "lied-to", week: o.grudgeWeek ?? live.week, day: 1, severity: o.severity ?? 1, peak: o.severity ?? 1, eased: o.eased ?? 0, refKey: "k",
    }]));
  }
  reg.restore(user, snap);
  const adapter = reg.sandboxFor(user).session as GameSessionAdapter;
  adapter.setJuryMemoryEnabled(true);
  adapter.setAdvanceGateEnabled(false); // the schedule gate would hold a played game between beats; this lane drives the finale straight through
  adapter.setGrudgesEnabled(o.flag ?? true);
  const player = reg.resolver()("player", user) as Parameters<typeof driveFinaleSeam>[0];
  const views = await driveFinaleSeam(player);
  const reveals = views.filter((v) => v.event?.beat === "finale-reveal").map((v) => v.event!.content);
  return { playerVotes: reveals.filter((c) => c.endsWith("votes for Player")).length, total: reveals.length, adapter, user };
}
let uid = 0;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const sum = async (o: Opts): Promise<number> => { let n = 0; for (const s of SEEDS) n += (await game(s, o)).playerVotes; return n; };

describe("the pure overlap rule", () => {
  it("adds only what is not already counted; never twice; bounded", () => {
    expect(bitterJurorExtra(-0.2, 0)).toBeCloseTo(-0.2, 12);
    expect(bitterJurorExtra(-0.2, 0.05)).toBeCloseTo(-0.15, 12);
    expect(bitterJurorExtra(-0.2, 0.2)).toBe(-0);
    expect(bitterJurorExtra(-0.2, 0.9)).toBe(-0);
    expect(bitterJurorExtra(0.3, 0)).toBe(-0); // a positive raw is never a bonus
    expect(bitterJurorExtra(Number.NaN, Number.NaN)).toBe(-0);
    for (const raw of [-0.01, -0.1, -JURY_GRUDGE.max]) for (const c of [0, 0.05, 0.1, 0.3, 0.6]) {
      const x = bitterJurorExtra(raw, c);
      expect(x).toBeLessThanOrEqual(0);
      expect(c - x, "the grudge plus what is covered never exceeds the larger of the two").toBeLessThanOrEqual(Math.max(c, -raw) + 1e-12);
    }
  });
  it("the cap is sized under the betrayed manner term, like the jury-house cap", () => {
    expect(JURY_GRUDGE.max).toBeLessThan(Math.abs(MANNER_LEAN.betrayed) * JURY_WEIGHTS.manner);
    expect(JURY_GRUDGE.max).toBeLessThan(Math.abs(MANNER_LEAN.blindsided) * JURY_WEIGHTS.manner);
    expect(JURY_HOUSE.adjustmentCap).toBeLessThan(Math.abs(MANNER_LEAN.betrayed) * JURY_WEIGHTS.manner);
  });
});

describe("the provider (real adapter)", () => {
  it("fresh > stale, repaired < fresh but never zero, bounded, the player never holds one", async () => {
    const fresh = (await game(3, { grudge: "grudge", severity: 0.9 })).adapter;
    const stale = (await game(3, { grudge: "grudge", severity: 0.9, weekNow: 60, grudgeWeek: 1 })).adapter;
    const eased = (await game(3, { grudge: "grudge", severity: 0.9, eased: 0.54 })).adapter;
    const j = JURY9[0]!;
    const f = fresh.juryGrudgeFor(j, PLAYER), st = stale.juryGrudgeFor(j, PLAYER), e = eased.juryGrudgeFor(j, PLAYER);
    expect(f).toBeLessThan(0);
    expect(st).toBeLessThan(0);
    expect(e).toBeLessThan(0);
    expect(f).toBeLessThan(st); // fresher hits harder (more negative)
    expect(f).toBeLessThan(e);  // repaired shrinks it
    for (const x of [f, st, e]) expect(Math.abs(x)).toBeLessThanOrEqual(JURY_GRUDGE.max + 1e-12);
    expect(fresh.juryGrudgeFor(PLAYER, RIVAL)).toBe(0);
    expect(fresh.juryGrudgeFor(j, RIVAL)).toBe(0); // no grudge against the other finalist
  });
  it("no provider off: flag off, or a game nobody is playing", async () => {
    expect((await game(3, { grudge: "grudge", flag: false })).adapter.juryGrudgeFor(JURY9[0]!, PLAYER)).toBe(0);
    expect((await game(3, { grudge: "grudge", playedGame: false })).adapter.juryGrudgeFor(JURY9[0]!, PLAYER)).toBe(0);
  });
});

describe("it moves real finale votes", () => {
  it("jurors holding a fresh grudge vote against that finalist more than the control (decision level)", async () => {
    const none = await sum({ grudge: "none" });
    const g = await sum({ grudge: "grudge", severity: 1 });
    if (process.env.BITTER_LOG) console.log(`LANE control=${none} grudge=${g} of ${SEEDS.length * 9}`);
    expect(none, "the control is mixed, so there is room to move").toBeGreaterThan(0);
    expect(g, `grudge ${g} < control ${none}`).toBeLessThan(none);
  }, 240000);
  it("fresh bites at least as hard as stale, and the stale one still bites (the floor)", async () => {
    const none = await sum({ grudge: "none", weekNow: 60 });
    const fresh = await sum({ grudge: "grudge", severity: 1, weekNow: 60, grudgeWeek: 60 });
    const stale = await sum({ grudge: "grudge", severity: 1, weekNow: 60, grudgeWeek: 1 });
    expect(fresh).toBeLessThanOrEqual(stale);
    expect(stale, `stale ${stale} <= control ${none}`).toBeLessThanOrEqual(none);
    expect(fresh).toBeLessThan(none);
  }, 240000);
  it("a repaired grudge bites less than an unrepaired one but still bites", async () => {
    const none = await sum({ grudge: "none" });
    const raw = await sum({ grudge: "grudge", severity: 1 });
    const eased = await sum({ grudge: "grudge", severity: 1, eased: 0.6 });
    expect(eased).toBeGreaterThanOrEqual(raw);
    expect(eased).toBeLessThanOrEqual(none);
  }, 240000);
  it("no double count: a juror whose only wrong is already a manner grievance votes exactly as without the grudge", async () => {
    const manner: EvictionManner = { betrayed: true };
    for (const seed of [3, 11]) {
      const a = await game(seed, { grudge: "none", manner });
      const b = await game(seed, { grudge: "grudge", severity: 1, manner });
      expect(b.playerVotes).toBe(a.playerVotes);
    }
    // and the sum stays bounded by the manner term alone: betrayed already outweighs the largest grudge
    expect(Math.abs(mannerLeanOf({ betrayed: true })) * JURY_WEIGHTS.manner).toBeGreaterThan(JURY_GRUDGE.max);
    expect(juryLean({ trust: 0.5, affinity: 0.5, threat: 0.3 } as never, { betrayed: true })).toBeLessThan(juryLean({ trust: 0.5, affinity: 0.5, threat: 0.3 } as never, {}));
  }, 240000);
});

describe("byte-identity and the wall", () => {
  it("headless (not a played game) and flag off: grudges change nothing, seeds 3 and 11", async () => {
    for (const seed of [3, 11]) {
      const base = await game(seed, { grudge: "none", playedGame: false });
      for (const o of [{ playedGame: false }, { flag: false }] as Opts[]) {
        const x = await game(seed, { grudge: "grudge", severity: 1, ...o });
        expect(x.playerVotes).toBe(base.playerVotes);
      }
    }
  }, 240000);
  it("the wall: no grudge, freshness or juryGrudge field in any finale view or read", async () => {
    const { adapter, user } = await game(3, { grudge: "grudge", severity: 1 });
    const dump = JSON.stringify([
      (adapter as unknown as { getMomentPrompt(a: unknown): { systemPrompt: string } }).getMomentPrompt({ moment: "social" }).systemPrompt,
      (adapter as unknown as { inspectNonVaultState?: () => unknown }).inspectNonVaultState?.() ?? null,
      user,
    ]);
    for (const w of ["juryGrudge", "grudges", "freshness", "lied-to"]) expect(dump).not.toContain(w);
  });
  it("the finale views the player sees carry no grudge field", async () => {
    const user = "bitter-wall-views";
    const { reg } = await liveFinale(user, 3, { finalists: [PLAYER, RIVAL], jury: JURY9, edgeTo: () => EVEN });
    const snap = reg.snapshot(user) as SessionSnapshot;
    const live = snap.live as unknown as { playedGame?: boolean; grudges?: GrudgeBook };
    live.playedGame = true;
    live.grudges = Object.fromEntries(JURY9.map((j) => [`${j}|${PLAYER}`, { kind: "lied-to", week: 9, day: 1, severity: 1, peak: 1, eased: 0, refKey: "k" }]));
    reg.restore(user, snap);
    (reg.sandboxFor(user).session as GameSessionAdapter).setAdvanceGateEnabled(false);
    const player = reg.resolver()("player", user) as Parameters<typeof driveFinaleSeam>[0];
    const views = await driveFinaleSeam(player);
    const dump = JSON.stringify(views);
    for (const w of ["juryGrudge", "grudges", "freshness", "lied-to", "refKey"]) expect(dump).not.toContain(w);
    const state = JSON.stringify(await player.callTool("getGameState", {}));
    for (const w of ["juryGrudge", "grudges", "freshness", "refKey"]) expect(state).not.toContain(w);
  }, 120000);
});
