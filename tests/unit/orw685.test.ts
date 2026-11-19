import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { COVER, decideCover, pickAskedClaim, slipChance, sourceNote } from "../../src/engine/claimSource";
import { routeDisclosureFull, type RouteCtx } from "../../src/engine/disclosureRoute";
import { SPIN } from "../../src/engine/copresenceSpread";
import type { SpokenClaim } from "../../src/engine/spokenClaims";
import type { ConfidenceSignals } from "../../src/engine/confidence";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { GameHouse } from "../../src/engine/characterFactory";

/** ORW-685 (T2-14 leftovers). Roles only. (3) a liar's cover when asked who told them, and the claim actually asked about; (1) the disclosure spin reaches the player. */
const claim = (id: string, subject: string, object?: string): SpokenClaim => ({ id, speaker: "h", listener: PLAYER, kind: "going-after", subject, ...(object ? { object } : {}), isTrue: true, intent: "inform" } as unknown as SpokenClaim);

describe("the liar's cover (pure)", () => {
  it("slip chance is bounded, falls with cunning and rises with nerves", () => {
    for (const c of [0, 0.5, 1]) for (const v of [0, 0.5, 1]) { const p = slipChance(c, v); expect(p).toBeGreaterThanOrEqual(COVER.slipMin); expect(p).toBeLessThanOrEqual(COVER.slipMax); }
    expect(slipChance(0.1, 0.3)).toBeGreaterThan(slipChance(0.9, 0.3));
    expect(slipChance(0.5, 0.9)).toBeGreaterThan(slipChance(0.5, 0.1));
  });
  it("is deterministic per claim, and a poor actor slips far more often than a good one while all three plays occur", () => {
    const base = { seed: 5, holder: "h", cunning: 0.5, volatility: 0.3 };
    expect(decideCover({ ...base, claimId: "x" })).toBe(decideCover({ ...base, claimId: "x" }));
    const rate = (cunning: number) => { let k = 0; const seen = new Set<string>(); for (let i = 0; i < 600; i++) { const r = decideCover({ ...base, cunning, claimId: `c${i}` }); seen.add(r); if (r === "slip") k++; } return { k, seen }; };
    const poor = rate(0.05), good = rate(0.95);
    expect(poor.k).toBeGreaterThan(good.k + 100);
    expect([...poor.seen].sort()).toEqual(["protect", "slip", "witnessed"]);
  });
  it("the slip note names no one and carries no truth, intent or id", () => {
    const n = sourceNote("slip", "Holder");
    expect(n).toContain("the player asked Holder");
    expect(n).not.toMatch(/isTrue|mislead|intent|claim:|false|lie|mistak|wrong/i);
  });
});

describe("the claim actually asked about", () => {
  const nameOf = (id: string) => ({ a: "Alma Stone", b: "Bram Hale", c: "Cora Vance" } as Record<string, string>)[id] ?? id;
  it("a claim the player names beats a newer one; with no name the newest wins", () => {
    const newest = claim("n", "a", "b"), older = claim("o", "c", "b");
    expect(pickAskedClaim([newest, older], "Who told you Cora is going after Bram?", nameOf)?.id).toBe("o");
    expect(pickAskedClaim([newest, older], "who told you that?", nameOf)?.id).toBe("n");
    expect(pickAskedClaim([], "who told you that?", nameOf)).toBeUndefined();
  });
});

describe("through the session: a planted lie, asked about", () => {
  type Priv = { presence: Map<string, string>; claimSourceNote: string | null; live: { playedGame?: boolean; coverSlips?: string[] } };
  function lieSeason(seed: number, flagOn: boolean) {
    const s = new GameSessionRegistry().sandboxFor(`orw685-${seed}-${Math.random()}`).session as GameSessionAdapter;
    s.setNpcBeliefsEnabled(true);
    s.setCoverSlipsEnabled(flagOn);
    s.createCharacter({ playerName: "P", seed });
    const p = s as unknown as Priv;
    p.live.playedGame = true;
    const [a, , c] = s.livingIds().filter((i) => i !== PLAYER) as [string, string, string];
    s.tellClaim({ speaker: a, listener: PLAYER, kind: "targets-you", subject: c, isTrue: false, intent: "mislead" });
    p.presence.set(a, p.presence.get(PLAYER)!);
    return { s, a, p };
  }
  it("some liars play it off and some slip; a slip is recorded once, folds once, round-trips, and the note leaks nothing", () => {
    let slips = 0, offs = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { s, a, p } = lieSeason(seed, true);
      const rel = (s as unknown as { rel: RelationshipModel }).rel;
      const before = rel.edge(a, PLAYER).threat;
      s.resolvePlayerMove({ text: "Who told you that?" });
      const note = p.claimSourceNote!;
      expect(note).toBeTruthy();
      expect(note).not.toMatch(/isTrue|mislead|intent|claim:|false|lie|mistak|wrong/i);
      if (/does not hold together/.test(note)) {
        slips++;
        expect(p.live.coverSlips).toHaveLength(1);
        const after = rel.edge(a, PLAYER).threat;
        expect(after).toBeGreaterThanOrEqual(before);
        s.resolvePlayerMove({ text: "who told you that?" }); // asked again: same answer, nothing folds twice
        expect(p.claimSourceNote).toMatch(/does not hold together/);
        expect(p.live.coverSlips).toHaveLength(1);
        expect(rel.edge(a, PLAYER).threat).toBe(after);
        expect(JSON.parse(JSON.stringify(p.live)).coverSlips).toHaveLength(1); // persistence round-trip
      } else { offs++; expect(p.live.coverSlips).toBeUndefined(); }
    }
    expect(slips).toBeGreaterThan(0);
    expect(offs).toBeGreaterThan(0);
  });
  it("flag off, or an unplayed game: always 'saw it themself', nothing recorded (today's behaviour)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { s, p } = lieSeason(seed, false);
      s.resolvePlayerMove({ text: "Who told you that?" });
      expect(p.claimSourceNote).toMatch(/saw it themself/);
      expect(p.live.coverSlips).toBeUndefined();
    }
  });
});

describe("the disclosure spin (pure)", () => {
  const sig: ConfidenceSignals = { npcTrust: 0.8, npcAffinity: 0.8, npcThreat: 0.1, playerTrust: 0.8, playerAffinity: 0.8, goodwill: 0.8, archetype: "floater" };
  const ctx = (over: Partial<RouteCtx>): RouteCtx => ({ signals: sig, audience: 0, pressure: 1, risk: 0.3, roll: 0.01, ...over });
  it("a cunning style can slant a share, a plain one tells it straight, and the decision is the same one routeDisclosure makes", () => {
    expect(routeDisclosureFull(ctx({ style: "strategic" }))).toMatchObject({ decision: "share", spin: "spun" });
    expect(routeDisclosureFull(ctx({ style: "loyal" }))).toMatchObject({ decision: "share", spin: "truthful" });
    expect(routeDisclosureFull(ctx({ style: "strategic", roll: 0.999 })).spin).toBeUndefined();
  });
});

describe("the disclosure spin through the session (played game)", () => {
  const SENTINEL = "SEALED-SENTINEL-685-detail";
  function started(seed: number, spinOn: boolean) {
    const session = new GameSessionAdapter();
    const confided: Array<{ content: string; confidence: number }> = [];
    session.setOnConfide((_n, content, confidence) => { confided.push({ content, confidence }); return true; });
    session.setDisclosureSpinEnabled(spinOn);
    session.createCharacter({ playerName: "The Player", seed });
    const house = (session as unknown as { house: GameHouse }).house;
    const npc = house.npcs.find((n) => (n.character.hiddenElements ?? []).length > 0)!;
    npc.character.hiddenElements![0]!.detail = SENTINEL;
    npc.character.strategyStyle = "strategic";
    const presence = (session as unknown as { presence?: Map<string, string> }).presence;
    if (presence) { presence.set(PLAYER, "kitchen"); presence.set(npc.id, "kitchen"); }
    const rel = (session as unknown as { rel: RelationshipModel }).rel;
    for (const [a, b] of [[npc.id, PLAYER], [PLAYER, npc.id]] as const) { const e = rel.edge(a, b); e.trust = 0.95; e.affinity = 0.95; e.threat = 0.05; }
    for (const kind of ["final-two", "safety", "vote"] as const) session.makeDeal({ with: npc.id, kind, terms: "ride or die" }); // ORW-727: one live deal per pair and kind, so the goodwill is three DIFFERENT open pacts
    session.noteMessage({ messageId: "first" });
    return { session, npc: npc.id, confided };
  }
  it("a slanted truthful confidence is taken at the spun confidence, the narrator is handed `slants`, and only with the flag on", () => {
    let slanted = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const on = started(seed, true);
      const r = on.session.confide(on.npc)!;
      const ev = on.session.disclosureThisBeat(on.npc);
      const voice = JSON.stringify(on.session.npcVoice(on.npc) ?? {});
      expect(voice).not.toContain(SENTINEL);
      if (ev?.slant) {
        slanted++;
        expect(r.truthful).toBe(true);
        expect(on.confided[0]!.confidence).toBeCloseTo(0.85 * SPIN.spunConfidence, 6);
        expect(JSON.parse(voice).slants).toBe(true);
        const off = started(seed, false);
        off.session.confide(off.npc);
        expect(off.session.disclosureThisBeat(off.npc)?.slant).toBeUndefined();
        expect(off.confided[0]?.confidence).toBeCloseTo(0.85, 6);
        expect(JSON.parse(JSON.stringify(off.session.npcVoice(off.npc) ?? {})).slants).toBeUndefined();
      } else expect(voice).not.toContain("slants");
    }
    expect(slanted).toBeGreaterThan(0); // positive control: the path is reachable
  });
});
