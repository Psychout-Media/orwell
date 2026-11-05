import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { UserSandbox } from "../../src/composition/registry";
import type { ExposeResult, TradeResult } from "../../src/ports/GameSession";

/**
 * AMEND 3a item 8 / A24 - the secret levers land in the NPC MEMORY LEDGER (the 0024 ledger that #2106 and the P4g scene writers use; B7 scope, approved by Ryne: memory feeds every
 * decision). A landed public expose makes the subject remember the exposer (a grudge); an accepted secret trade makes the recipient remember the player (a favor). Written only under
 * the memory-writers flag (default ON). Roles only.
 */
function season(user: string, seed: number): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}
const edge = (sb: UserSandbox, a: EntityId, b: EntityId) => sb.engine.relationships.edge(a, b);
const ledger = (sb: UserSandbox): Record<string, Record<string, unknown[]>> =>
  ((sb.session.snapshot().live ?? {}) as unknown as { npcMemory?: Record<string, Record<string, unknown[]>> }).npcMemory ?? {};
const memoriesAboutPlayer = (sb: UserSandbox): number =>
  Object.values(ledger(sb)).reduce((n, bySubject) => n + (bySubject[PLAYER]?.length ?? 0), 0);

describe("secret levers vs the NPC memory ledger (AMEND 3a #8 / A24: the levers write the ledger)", () => {
  it("a LANDED public expose leaves the subject remembering the exposer (a grudge entry about the player)", () => {
    const sb = season("slm-expose", 5);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!;
    for (const id of npcs) { const e = edge(sb, id, PLAYER); e.trust = 0.95; e.affinity = 0.9; e.threat = 0.02; const s = edge(sb, id, subject); s.threat = 0.9; s.affinity = 0.05; }
    const before = memoriesAboutPlayer(sb);
    const res = sb.session.exposeSecret({ bluff: true, subject }) as ExposeResult | null;
    expect(res?.exposed, "the expose must actually land for this to prove anything").toBe(true);
    expect(memoriesAboutPlayer(sb), "the ledger gained an entry about the player").toBeGreaterThan(before);
  });

  it("an ACCEPTED secret trade leaves the recipient remembering the player (a favor entry)", () => {
    const sb = season("slm-trade", 6);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!;
    const recipient = npcs[1]!;
    const rp = edge(sb, recipient, PLAYER); rp.trust = 0.9; rp.affinity = 0.8; rp.threat = 0.05;
    const rs = edge(sb, recipient, subject); rs.threat = 0.9; rs.affinity = 0.05;
    const before = memoriesAboutPlayer(sb);
    const res = sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient, askKind: "vote" }) as TradeResult;
    expect(res.accepted, "the trade must actually be accepted for this to prove anything").toBe(true);
    expect(memoriesAboutPlayer(sb), "the ledger gained an entry about the player").toBeGreaterThan(before);
  });
});

describe("the lever memory writers are scoped", () => {
  it("a BOUNCED bluff expose (the house does not buy it) and a refused trade write no memory", () => {
    const sb = season("slm-bounce", 7);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!;
    const recipient = npcs[1]!;
    const rp = edge(sb, recipient, PLAYER); rp.trust = 0; rp.affinity = 0; rp.threat = 0.9;
    const rs = edge(sb, recipient, subject); rs.threat = 0.05; rs.affinity = 0.9;
    const before = memoriesAboutPlayer(sb);
    const res = sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient, askKind: "vote" }) as TradeResult;
    expect(res.accepted).toBe(false);
    expect(memoriesAboutPlayer(sb), "a refused trade writes nothing").toBe(before);
  });

  it("with the memory writers OFF the levers write nothing", () => {
    const sb = season("slm-off", 8);
    sb.session.setNpcMemoryWritersEnabled(false);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!;
    const recipient = npcs[1]!;
    const rp = edge(sb, recipient, PLAYER); rp.trust = 0.9; rp.affinity = 0.8; rp.threat = 0.05;
    const rs = edge(sb, recipient, subject); rs.threat = 0.9; rs.affinity = 0.05;
    const res = sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient, askKind: "vote" }) as TradeResult;
    expect(res.accepted).toBe(true);
    expect(memoriesAboutPlayer(sb)).toBe(0);
  });
});
