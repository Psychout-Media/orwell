import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EdgeRecord } from "../../src/domain/saveState";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { barterAppetite, BARTER_APPETITE } from "../../src/engine/secretBarterConstants";

/**
 * ORW-688 - the houseguest's own brake on trading secrets (`ORWELL_BARTER_APPETITE`). Roles only. One GIVER holds many secrets about a SUBJECT that one
 * WANTER values, so the giver would trade on most ticks; the brake is what slows it. The brake scales the fire chance AFTER the dedicated stream's draws.
 */
const GIVER = npc(1);
const SUBJECT = npc(2);
const WANTER = npc(3);
const ALL_NPCS: EntityId[] = Array.from({ length: 15 }, (_, i) => npc(i + 1));
const TICKS = 60;
const SECRETS = 40;

function edges(): EdgeRecord[] {
  const out: EdgeRecord[] = [];
  const e = (from: EntityId, to: EntityId, o: Partial<EdgeRecord>): void => {
    out.push({ from, to, trust: 0.3, affinity: 0.3, threat: 0.3, alignment: 0.3, confidence: 0.5, reliability: 0.3, ...o });
  };
  e(WANTER, SUBJECT, { threat: 0.9, affinity: 0.05 });
  e(WANTER, GIVER, { trust: 0.7 });
  for (const n of ALL_NPCS) {
    if (n === WANTER || n === SUBJECT || n === GIVER) continue;
    e(n, SUBJECT, { threat: 0.0, affinity: 0.9 });
    e(n, GIVER, { trust: 0.0 });
  }
  return out;
}

function game(user: string, o: { played: boolean; appetite: boolean; burned?: boolean }) {
  const reg = new GameSessionRegistry();
  reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed: 11 });
  const snap = reg.snapshot(user) as SessionSnapshot;
  const live: LiveSeasonState = { week: 1, beat: "hoh-competition", active: [PLAYER, ...ALL_NPCS], vetoUsed: false, evictionOrder: [], finished: false, ...(o.played ? { playedGame: true } : {}) };
  if (o.burned) live.npcMemory = { [GIVER]: { [SUBJECT]: [{ kind: "deal-broken", week: 1, severity: 1 }] } };
  snap.live = live;
  snap.relationships = edges();
  reg.restore(user, snap);
  const sb = reg.sandboxFor(user);
  for (let i = 0; i < SECRETS; i++) sb.engine.knowledge.seedBelief(GIVER, { content: `a real secret ${i}`, factId: `f${i}`, subject: SUBJECT, confidence: 1 }, "origin");
  sb.session.setSecretBarterEnabled(true);
  sb.session.setBarterAppetiteEnabled(o.appetite);
  return { reg, sb };
}
const run = (g: ReturnType<typeof game>): number => {
  for (let t = 0; t < TICKS; t++) g.sb.session.secretBarterTick(g.sb.engine.events, g.sb.engine.knowledge);
  return g.sb.session.snapshot().secretBarterCount ?? 0;
};

describe("ORW-688 - the appetite function (pure)", () => {
  it("is 1 for a houseguest who has not traded and was not burned, and only falls", () => {
    expect(barterAppetite(0, 0)).toBe(1);
    let prev = 1;
    for (let s = 0.5; s <= 6; s += 0.5) { const a = barterAppetite(s, 0); expect(a).toBeLessThan(prev); prev = a; }
    prev = 1;
    for (let b = 0.25; b <= 1; b += 0.25) { const a = barterAppetite(0, b); expect(a).toBeLessThan(prev); prev = a; }
    expect(barterAppetite(100, 1)).toBeGreaterThan(0);
    expect(barterAppetite(0, 1)).toBeCloseTo(1 - BARTER_APPETITE.burnWeight, 10);
    expect(barterAppetite(Number.NaN, Number.NaN)).toBe(1);
  });
});

describe("ORW-688 - the houseguests brake their own trading", () => {
  it("a houseguest who just traded trades less (positive control: trades still happen; OFF = today's volume)", () => {
    const off = run(game("off", { played: true, appetite: false }));
    const on = run(game("on", { played: true, appetite: true }));
    expect(off, "the giver does trade without the brake").toBeGreaterThan(5);
    expect(on, "the brake leaves trading alive").toBeGreaterThan(0);
    expect(on, "and slows it").toBeLessThan(off);
  });
  it("a headless (not played) game is untouched by the brake", () => {
    expect(run(game("h-on", { played: false, appetite: true }))).toBe(run(game("h-off", { played: false, appetite: false })));
  });
  it("a houseguest who was burned trades less than one who was not", () => {
    const fresh = run(game("fresh", { played: true, appetite: true }));
    const burned = run(game("burned", { played: true, appetite: true, burned: true }));
    expect(burned).toBeGreaterThan(0);
    expect(burned).toBeLessThan(fresh);
  });
  it("is deterministic, and the appetite survives a save and restore (no thinning)", () => {
    const a = run(game("d1", { played: true, appetite: true }));
    const g = game("d2", { played: true, appetite: true });
    expect(run(g)).toBe(a);
    const snap = g.reg.snapshot("d2") as SessionSnapshot;
    expect(snap.secretBarterRecent?.[GIVER]?.n ?? 0, "the giver's trading is on record").toBeGreaterThan(0);
    g.reg.restore("d2", JSON.parse(JSON.stringify(snap)) as SessionSnapshot);
    const after = g.reg.snapshot("d2") as SessionSnapshot;
    expect(after.secretBarterRecent).toEqual(snap.secretBarterRecent);
    expect(after.secretBarterCount).toBe(snap.secretBarterCount);
  });
  it("recovers with the days: a long quiet stretch brings the appetite back", () => {
    const g = game("rec", { played: true, appetite: true });
    run(g);
    const snap = g.reg.snapshot("rec") as SessionSnapshot;
    const last = snap.secretBarterRecent![GIVER]!;
    const nowSated = last.n * Math.pow(0.5, (snap.secretBarterTickCount! - last.t) / BARTER_APPETITE.satietyHalfLifeTicks);
    const later = last.n * Math.pow(0.5, (snap.secretBarterTickCount! + 10 * BARTER_APPETITE.satietyHalfLifeTicks - last.t) / BARTER_APPETITE.satietyHalfLifeTicks);
    expect(barterAppetite(later, 0)).toBeGreaterThan(barterAppetite(nowSated, 0));
    expect(barterAppetite(later, 0)).toBeGreaterThan(0.9);
  });
});
