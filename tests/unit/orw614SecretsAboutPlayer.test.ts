import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { EdgeRecord } from "../../src/domain/saveState";
import { assertNoSentinels } from "../support/assertions";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * ORW-614 (P-11): houseguests trade secrets ABOUT the player the way they trade ones about each other (same tick, same value core, same hidden told-by transfer). The Vault Wall holds: the content reaches no
 * player or admin surface and the player never witnesses the trade. Roles only.
 */
const GIVER = npc(1);
const WANTER = npc(3);
const ALL: EntityId[] = Array.from({ length: 15 }, (_, i) => npc(i + 1));
const FACT = "p614-fact";

function edges(subject: EntityId): EdgeRecord[] {
  const out: EdgeRecord[] = [];
  const e = (from: EntityId, to: EntityId, o: Partial<EdgeRecord>): void => { out.push({ from, to, trust: 0.3, affinity: 0.3, threat: 0.3, alignment: 0.3, confidence: 0.5, reliability: 0.3, ...o }); };
  e(WANTER, subject, { threat: 0.9, affinity: 0.05 });
  e(WANTER, GIVER, { trust: 0.7 });
  for (const n of ALL) if (n !== WANTER && n !== GIVER && n !== subject) { e(n, subject, { threat: 0, affinity: 0.9 }); e(n, GIVER, { trust: 0 }); }
  return out;
}
function game(user: string, subject: EntityId, played: boolean, content = "a buried matter") {
  const reg = new GameSessionRegistry();
  reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed: 7 });
  const snap = reg.snapshot(user) as SessionSnapshot;
  snap.live = { week: 1, beat: "hoh-competition", active: [PLAYER, ...ALL], vetoUsed: false, evictionOrder: [], finished: false, ...(played ? { playedGame: true } : {}) };
  snap.relationships = edges(subject);
  reg.restore(user, snap);
  const sb = reg.sandboxFor(user);
  sb.engine.knowledge.seedBelief(GIVER, { content, factId: FACT, subject, confidence: 1 }, "origin");
  sb.session.setSecretBarterEnabled(true);
  return { reg, sb };
}
const holds = (sb: ReturnType<GameSessionRegistry["sandboxFor"]>, who: EntityId): boolean => sb.engine.knowledge.knownTo(who).some((k) => (k.factId ?? k.id) === FACT);
const tick = (sb: ReturnType<GameSessionRegistry["sandboxFor"]>): void => { for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge); };

describe("ORW-614 P-11: houseguests trade secrets about the player", () => {
  it("parity: a secret about the player is bartered to the houseguest who values it, exactly like one about a houseguest", () => {
    const a = game("pl", PLAYER, true); tick(a.sb);
    const b = game("np", npc(2), true); tick(b.sb);
    expect(holds(a.sb, WANTER), "the valuing houseguest got the secret about the player").toBe(true);
    expect(holds(b.sb, WANTER), "same for a houseguest subject").toBe(true);
    expect(holds(a.sb, npc(4)), "a non-valuing houseguest never did").toBe(false);
  });
  it("the player is never a witness and never learns it; the transfer is hidden", () => {
    const { sb } = game("wit", PLAYER, true);
    const before = sb.engine.events.count();
    tick(sb);
    const ev = sb.engine.events.queryAll().slice(before).filter((e) => e.type === "gossip");
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) { expect(e.hidden).toBe(true); expect(e.witnessSet).not.toContain(PLAYER); }
    expect(holds(sb, PLAYER)).toBe(false);
  });
  it("wall: a planted sentinel never reaches a player or admin surface", () => {
    const SENT = "SENTINEL-614-ABOUT-THE-PLAYER";
    const { reg, sb } = game("wall", PLAYER, true, `[off-screen] ${SENT}`);
    tick(sb);
    expect(holds(sb, WANTER), "not vacuous: the sentinel was traded").toBe(true);
    reg.sandboxFor("wall").syncAdmin();
    const p = sb.player;
    const blob = [p.produce("player-visible log"), p.produce("scene narration"), JSON.stringify(p.assembleNarrationContext("scene")), JSON.stringify(p.getVisibleState()), p.socialRead(),
      JSON.stringify(sb.session.gameStatus()), JSON.stringify(sb.session.getGameState()), JSON.stringify(sb.session.whereabouts())].join("\n---\n");
    assertNoSentinels(blob, [SENT]);
    assertNoSentinels(JSON.stringify(sb.admin.inspect()), [SENT]);
  });
  it("not a played game, or the flag off: the player is never a subject (today's behaviour)", () => {
    const a = game("unplayed", PLAYER, false); tick(a.sb);
    expect(holds(a.sb, WANTER)).toBe(false);
    const b = game("off", PLAYER, true);
    (b.sb.session as unknown as { setSecretBarterPlayerEnabled(on: boolean): void }).setSecretBarterPlayerEnabled(false);
    tick(b.sb);
    expect(holds(b.sb, WANTER)).toBe(false);
  });
  it("persistence: the recipient keeps what it learned across a snapshot round trip", () => {
    const { sb } = game("persist", PLAYER, true); tick(sb);
    expect(holds(sb, WANTER)).toBe(true);
    const revived = new GameSessionAdapter();
    revived.restore(JSON.parse(JSON.stringify(sb.session.snapshot())));
    expect(revived.snapshot().secretBarterCount ?? 0).toBeGreaterThan(0);
  });
});
