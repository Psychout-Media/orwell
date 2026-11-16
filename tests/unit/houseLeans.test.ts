import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { LEAN_IDS, DIAL_IDS, LEANS, LEAN_TEXTURE, HOUSE_LEAN_TUNING, drawHouseLeans, dialMult, describeHouseLeans, type HouseLeans } from "../../src/engine/houseLeans";
import { PLAYER } from "../../src/domain/ids";

/** ORW-551 / spec 0168 slice 1: the house culture foundation. Roles only. */
type Live = { houseLeans?: HouseLeans; playedGame?: boolean };
const live = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live;
let n = 0;
function play(seed: number, opts: { flag: boolean; played: boolean }): GameSessionAdapter {
  const sb = new GameSessionRegistry().sandboxFor(`leans0159-${n++}`);
  sb.session.setHouseCultureEnabled(opts.flag);
  sb.session.createCharacter({ playerName: "The Player", seed });
  if (opts.played) {
    expect(sb.session.noteMessage({ messageId: "m1" }).accepted).toBe(true);
    sb.session.advanceGame({});
  } else {
    sb.session.advanceGame({});
  }
  return sb.session;
}
const snap = (s: GameSessionAdapter) => { const x = s.snapshot() as unknown as { live?: Live }; if (x.live) delete x.live.houseLeans; return JSON.stringify(x); };

describe("the draw", () => {
  it("is deterministic per seed, and varies across seeds", () => {
    expect(drawHouseLeans(7)).toEqual(drawHouseLeans(7));
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) seen.add(JSON.stringify(drawHouseLeans(s).leans.map((l) => l.id)));
    expect(seen.size).toBeGreaterThan(20);
  });
  it("is bounded: 2-3 distinct known leans, each weight positive, weights sum to 1", () => {
    for (let s = 0; s < 300; s++) {
      const d = drawHouseLeans(s);
      expect(d.leans.length).toBeGreaterThanOrEqual(2);
      expect(d.leans.length).toBeLessThanOrEqual(3);
      expect(new Set(d.leans.map((l) => l.id)).size).toBe(d.leans.length);
      for (const l of d.leans) { expect(LEAN_IDS).toContain(l.id); expect(l.w).toBeGreaterThan(0); }
      expect(d.leans.reduce((a, l) => a + l.w, 0)).toBeCloseTo(1, 10);
    }
  });
  it("the table is whole: 22 leans, 11 dials, every nudge in [-1,1], every lean has words", () => {
    expect(LEAN_IDS.length).toBe(22);
    expect(DIAL_IDS.length).toBe(11);
    for (const id of LEAN_IDS) {
      expect(LEAN_TEXTURE[id]).toBeTruthy();
      for (const [dial, v] of Object.entries(LEANS[id])) { expect(DIAL_IDS).toContain(dial); expect(Math.abs(v!)).toBeLessThanOrEqual(1); }
    }
  });
});

describe("dialMult", () => {
  it("is exactly 1 with no culture", () => {
    for (const d of DIAL_IDS) { expect(dialMult(undefined, d)).toBe(1); expect(dialMult({ leans: [] }, d)).toBe(1); }
  });
  it("stays within [1/F, F] for every lean alone, every drawn blend, and every dial", () => {
    const F = HOUSE_LEAN_TUNING.MAX_FACTOR;
    for (const id of LEAN_IDS) for (const d of DIAL_IDS) { const m = dialMult({ leans: [{ id, w: 1 }] }, d); expect(m).toBeGreaterThanOrEqual(1 / F); expect(m).toBeLessThanOrEqual(F); }
    for (let s = 0; s < 200; s++) for (const d of DIAL_IDS) { const m = dialMult(drawHouseLeans(s), d); expect(m).toBeGreaterThanOrEqual(1 / F); expect(m).toBeLessThanOrEqual(F); }
  });
  it("a lean pushes the dials it names the way it names them", () => {
    expect(dialMult({ leans: [{ id: "gossip-mill", w: 1 }] }, "gossip")).toBeGreaterThan(1);
    expect(dialMult({ leans: [{ id: "showmance", w: 1 }] }, "flirting")).toBeGreaterThan(1);
    expect(dialMult({ leans: [{ id: "chess-club", w: 1 }] }, "paranoia")).toBeGreaterThan(1);
    expect(dialMult({ leans: [{ id: "gossip-mill", w: 1 }] }, "compFocus")).toBe(1);
  });
});

describe("storage and byte-identity", () => {
  it("a played game stores a culture, write-once, and it round-trips through a save", () => {
    const s = play(5, { flag: true, played: true });
    const first = live(s).houseLeans!;
    expect(first.leans.length).toBeGreaterThanOrEqual(2);
    s.noteMessage({ messageId: "m2" });
    expect(live(s).houseLeans).toEqual(first);
    const sb2 = new GameSessionRegistry().sandboxFor(`leans0159-rt-${n++}`);
    sb2.session.restore(JSON.parse(JSON.stringify(s.snapshot())));
    expect(live(sb2.session).houseLeans).toEqual(first);
  });
  it("a save without it stays without it (non-degrading load)", () => {
    const s = play(5, { flag: false, played: true });
    expect(live(s).houseLeans).toBeUndefined();
    const sb2 = new GameSessionRegistry().sandboxFor(`leans0159-old-${n++}`);
    sb2.session.restore(JSON.parse(JSON.stringify(s.snapshot())));
    expect(live(sb2.session).houseLeans).toBeUndefined();
    sb2.session.noteMessage({ messageId: "zz" });
    expect(live(sb2.session).houseLeans, "a restored season already under way never gains a culture mid-season").toBeUndefined();
  });
  it("a headless (never-played) game gets no culture", () => {
    expect(live(play(5, { flag: true, played: false })).houseLeans).toBeUndefined();
  });
  it("a headless game's snapshot is byte-identical with the flag on or off", () => {
    expect(snap(play(3, { flag: true, played: false }))).toBe(snap(play(3, { flag: false, played: false })));
  });
});

describe("the wall", () => {
  it("no live surface carries a lean id, the field name or a weight; the retrospective stays sealed", async () => {
    const sb = new GameSessionRegistry().sandboxFor(`leans0159-wall-${n++}`);
    sb.session.setHouseCultureEnabled(true);
    sb.session.createCharacter({ playerName: "The Player", seed: 21 });
    sb.session.noteMessage({ messageId: "m1" });
    const culture = live(sb.session).houseLeans!;
    expect(culture).toBeTruthy();
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("seasonRetrospective", {}), await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.player.callTool("whereabouts", {}),
      await sb.mcp.admin.callTool("inspectNonVaultState", {}),
    ];
    const blob = JSON.stringify(surfaces);
    for (const id of LEAN_IDS) expect(blob.includes(`"${id}"`), `a live surface carries lean id ${id}`).toBe(false);
    for (const k of ["houseLeans", "houseCulture"]) expect(blob.includes(k), `a live surface carries ${k}`).toBe(false);
    for (const l of culture.leans) expect(blob.includes(String(l.w)), "a live surface carries a lean weight").toBe(false);
    expect(sb.session.seasonRetrospective()).toBeNull();
    expect(PLAYER).toBeTruthy();
  });
  it("after the crown the retrospective carries texture words only, no id, weight or number; absent without a culture", () => {
    const sb = new GameSessionRegistry().sandboxFor(`leans0159-retro-${n++}`);
    sb.session.setHouseCultureEnabled(true);
    sb.session.createCharacter({ playerName: "The Player", seed: 21 });
    sb.session.noteMessage({ messageId: "m1" });
    const culture = live(sb.session).houseLeans!;
    expect(sb.session.advanceToFinale().finished).toBe(true);
    const retro = sb.session.seasonRetrospective()!;
    expect(retro.houseCulture!.leans).toEqual(describeHouseLeans(culture));
    const blob = JSON.stringify(retro.houseCulture);
    for (const id of LEAN_IDS) expect(blob.includes(id)).toBe(false);
    expect(blob).not.toMatch(/\d/);
    expect(Object.keys(retro.houseCulture!)).toEqual(["leans"]);
    const none = new GameSessionRegistry().sandboxFor(`leans0159-none-${n++}`);
    none.session.setHouseCultureEnabled(false);
    none.session.createCharacter({ playerName: "The Player", seed: 21 });
    none.session.noteMessage({ messageId: "m1" });
    none.session.advanceToFinale();
    expect(none.session.seasonRetrospective()!.houseCulture).toBeUndefined();
  }, 300_000);
});
