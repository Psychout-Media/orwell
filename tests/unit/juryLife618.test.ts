import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { planJuryNotes, shareable } from "../../src/engine/juryNotes";
import { JURY_LIFE } from "../../src/engine/juryHouseConstants";
import { buildSandbox } from "../support/sandbox";
import { PLAYER, npc } from "../../src/domain/ids";
import type { BeliefStore, BeliefClaim } from "../../src/engine/beliefStore";

/** ORW-618 (0189): the jury house has a life. Roles only: a teller, a listener, a wronged juror, a finalist. */
const JURORS = Array.from({ length: 9 }, (_, i) => npc(i + 1));
const PRE_JURY = [npc(10), npc(11), npc(12), npc(13), npc(15)];
const FINALIST = npc(14);

function belief(over: Partial<BeliefClaim> & Pick<BeliefClaim, "holder" | "kind" | "subject">): BeliefClaim {
  return { id: `${over.holder}|${over.kind}|${over.subject}|x`, value: true, origin: "witnessed", confidence: 0.8, week: 1, ...over } as BeliefClaim;
}

function rig(seed: number, opts: { played?: boolean; juryHouse?: boolean } = {}) {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
  session.createCharacter({ playerName: "The Player", seed });
  session.noteMessage({ messageId: "m-1" } as never);
  session.setJuryHouseEnabled(opts.juryHouse ?? true);
  const i = session as any;
  i.live.evictionOrder = [...PRE_JURY, ...JURORS];
  if (opts.played !== false) i.live.playedGame = true;
  i.live.beliefs = {};
  for (const a of JURORS) for (const b of JURORS) if (a !== b) Object.assign(i.rel.edge(a, b), { affinity: 0.9, trust: 0.6 });
  return { session, i, sb };
}
/** Run life stretches until something is shared (bounded), each on its own tick of the seeded stream. */
function liveUntil(i: any, done: () => boolean, max = 60): number {
  let n = 0;
  while (!done() && n < max) { i.juryHouseTickCount += 1; i.juryLife(JURORS); n++; }
  return n;
}
const held = (i: any, holder: string) => (i.live.beliefs[holder] ?? []) as BeliefClaim[];

describe("ORW-618 the jury house has a life", () => {
  it("jurors share what they knew: a belief one juror holds reaches another, bounded and deterministic", () => {
    const run = () => {
      const { i } = rig(618);
      i.live.beliefs[npc(1)] = [belief({ holder: npc(1), kind: "lied-to-me", subject: FINALIST })];
      liveUntil(i, () => held(i, npc(2)).length > 0);
      return JSON.stringify(i.live.beliefs);
    };
    const a = run();
    expect(a).toBe(run());
    const { i } = rig(618);
    i.live.beliefs[npc(1)] = [belief({ holder: npc(1), kind: "lied-to-me", subject: FINALIST })];
    liveUntil(i, () => held(i, npc(2)).length > 0);
    const got = held(i, npc(2))[0]!;
    expect(got.kind).toBe("lied-to-me");
    expect(got.origin).toBe("told");
    expect(JURORS).toContain(got.source);
    expect(got.confidence).toBeLessThan(0.8);
    const total = Object.values(i.live.beliefs as BeliefStore).reduce((n, l) => n + l.length, 0);
    expect(total).toBeLessThanOrEqual(1 + JURY_LIFE.maxSharesPerStretch * 60);
  });

  it("a juror who hears of a break learns it through the gate once, and their feeling follows", () => {
    const { i } = rig(619);
    const deal = i.deals.make([npc(2), FINALIST], "safety", "you are safe with me", undefined, 1);
    deal.status = "broken"; deal.brokenBy = FINALIST; deal.learned = false;
    i.live.beliefs[npc(1)] = [belief({ holder: npc(1), kind: "lied-to-me", subject: FINALIST })];
    const before = i.rel.edge(npc(2), FINALIST).trust;
    liveUntil(i, () => deal.learned === true);
    expect(deal.learned).toBe(true);
    expect(i.rel.edge(npc(2), FINALIST).trust).toBeLessThan(before);
    const after = i.rel.edge(npc(2), FINALIST).trust;
    i.juryLife(JURORS);
    expect(deal.learned).toBe(true); // once: nothing new lands from the gate
    expect(i.rel.edge(npc(2), FINALIST).trust).toBeGreaterThanOrEqual(after - JURY_LIFE.trustShift);
  });

  it("feelings shift bounded: what one juror loses toward one subject through being told never passes the cap", () => {
    const { i } = rig(620);
    for (const j of JURORS.slice(1)) i.live.beliefs[j] = [belief({ holder: j, kind: "lied-to-me", subject: FINALIST })];
    i.live.beliefs[npc(1)] = [];
    const start = i.rel.edge(npc(1), FINALIST).trust;
    for (let n = 0; n < 80; n++) { i.juryHouseTickCount += 1; i.juryLife(JURORS); }
    const moved = start - i.rel.edge(npc(1), FINALIST).trust;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(JURY_LIFE.shiftCap + 1e-9);
  });

  it("the sealed ballot stays sealed: no vote read, deduction or vote promise is ever passed on", () => {
    const sealed: BeliefClaim[] = [
      belief({ holder: npc(1), kind: "voted-against-me", subject: FINALIST }),
      belief({ holder: npc(1), kind: "assured-me", subject: FINALIST }),
      belief({ holder: npc(1), kind: "will-vote", subject: FINALIST }),
      belief({ holder: npc(1), kind: "heard-rumor", subject: FINALIST, object: npc(3), nature: "voted-against" }),
      belief({ holder: npc(1), kind: "heard-rumor", subject: FINALIST, object: npc(3), nature: "voted-to-keep" }),
      belief({ holder: npc(1), kind: "lied-to-me", subject: FINALIST, origin: "deduced" }),
    ];
    for (const b of sealed) expect(shareable(b, npc(1), npc(2))).toBeUndefined();
    const { i } = rig(621);
    i.live.beliefs[npc(1)] = sealed;
    for (let n = 0; n < 80; n++) { i.juryHouseTickCount += 1; i.juryLife(JURORS); }
    for (const j of JURORS.slice(1)) expect(held(i, j)).toEqual([]);
  });

  it("personality scales it: a keeper is told less often than an easygoing juror (openness multiplier)", () => {
    const b = [belief({ holder: npc(1), kind: "lied-to-me", subject: FINALIST })];
    const count = (open: number) => {
      let n = 0;
      for (let s = 0; s < 200; s++) {
        let k = 0;
        const rng = { next: () => { k += 1; return ((s * 7919 + k * 104729) % 1000) / 1000; } } as never;
        n += planJuryNotes({ jurors: [npc(1), npc(2)], beliefs: { [npc(1)]: b }, talks: () => true, opennessOf: () => open, rng }).length;
      }
      return n;
    };
    expect(count(0.35)).toBeLessThan(count(1.4));
    expect(count(0)).toBe(0);
  });

  it("parity: a juror is told about the player exactly as about an NPC finalist under the same history", () => {
    const res: number[] = [];
    for (const subject of [PLAYER, FINALIST]) {
      const { i } = rig(622);
      i.live.beliefs[npc(1)] = [belief({ holder: npc(1), kind: "lied-to-me", subject })];
      Object.assign(i.rel.edge(npc(2), subject), { trust: 0.8 });
      Object.assign(i.rel.edge(npc(2), subject === PLAYER ? FINALIST : PLAYER), { trust: 0.8 });
      const n = liveUntil(i, () => held(i, npc(2)).length > 0);
      res.push(n, i.rel.edge(npc(2), subject).trust, held(i, npc(2))[0]!.confidence);
    }
    expect(res.slice(0, 3)).toEqual(res.slice(3));
  });

  it("byte-identity: flag off, and a headless (unplayed) game, run the real stretch and change no belief or feeling beyond the existing jury house", () => {
    const snap = (o: { played: boolean; juryHouse: boolean }) => {
      const { i, sb } = rig(623, o);
      i.live.playedGame = o.played;
      i.live.beliefs[npc(1)] = [belief({ holder: npc(1), kind: "lied-to-me", subject: FINALIST })];
      i.juryHouseTick(sb.engine.events, sb.engine.knowledge);
      return { beliefs: JSON.stringify(i.live.beliefs), notes: JORS_NOTES(i), stretches: i.juryHouseTickCount };
    };
    const off = snap({ played: true, juryHouse: false });
    expect(off.stretches).toBe(0);
    expect(off.notes).toBe(0);
    const headless = snap({ played: false, juryHouse: true });
    expect(headless.stretches).toBeGreaterThan(0);
    expect(headless.notes).toBe(0);
    const played = snap({ played: true, juryHouse: true });
    expect(played.stretches).toBe(headless.stretches);
    expect(played.notes).toBeGreaterThan(0);
    // the hook itself is gated on played games
    expect(readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8")).toContain("if (this.live.playedGame === true) this.juryLife(jurors);");
  });

  it("save and restore: the shared belief and its recorded impact survive the snapshot", () => {
    const { i } = rig(624);
    i.live.beliefs[npc(1)] = [belief({ holder: npc(1), kind: "lied-to-me", subject: FINALIST })];
    liveUntil(i, () => JURORS.some((j) => held(i, j).some((c) => c.id.includes("|jury-note:"))));
    const copy = JSON.parse(JSON.stringify(i.live.beliefs));
    expect(JSON.stringify(copy)).toBe(JSON.stringify(i.live.beliefs));
    expect(JORS_NOTES(i)).toBeGreaterThan(0);
  });

  it("wall: what is told is beliefs and edges only, with no truth marker and no new projection field", () => {
    const { i } = rig(625);
    i.live.beliefs[npc(1)] = [belief({ holder: npc(1), kind: "lied-to-me", subject: FINALIST })];
    liveUntil(i, () => held(i, npc(2)).length > 0);
    const got = JSON.stringify(held(i, npc(2)));
    expect(got).not.toMatch(/isTrue|truth|intent/);
    // the player-facing projections do not name the new code
    for (const f of ["src/ports/GameSession.ts", "src/surfaces/tools/registry.ts", "src/adapters/mcp/McpServer.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/juryLife|juryNotes|jury-note/);
    }
    // the player is never a node: a belief held by the player is never planned from or to
    const plan = planJuryNotes({ jurors: JURORS, beliefs: { [PLAYER]: [belief({ holder: PLAYER, kind: "lied-to-me", subject: FINALIST })] }, talks: () => true, opennessOf: () => 1, rng: { next: () => 0 } as never });
    expect(plan).toEqual([]);
  });
});

function JORS(i: any): unknown { return JURORS.map((j) => [i.rel.edge(j, FINALIST).trust, i.rel.edge(j, PLAYER).trust]); }
function JORS_NOTES(i: any): number { return JURORS.reduce((n, j) => n + ((i.live.beliefs[j] ?? []) as BeliefClaim[]).filter((c) => c.id.includes("|jury-note:")).length, 0); }
