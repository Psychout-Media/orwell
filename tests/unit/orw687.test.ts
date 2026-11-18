import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { GameHouse } from "../../src/engine/characterFactory";
import type { SpokenClaim } from "../../src/engine/spokenClaims";
import { COVER } from "../../src/engine/claimSource";
import { SPIN } from "../../src/engine/copresenceSpread";
import { ASK, answerFold, askChance, parseSourceDodge, readAnswer, sameStory, sourceAsksSuperset, trueSourceOf, type SourceAsk } from "../../src/engine/sourceAsk";

/**
 * ORW-687 - (1) a houseguest asks the PLAYER "who told you that?" and the player answers in their own words (the engine reads them, never answers for them); the asker's read is a structural comparison with the
 * engine's record of who really told the player. (2) the 0092 drip and the orientation disclosure carry the disclosure spin. Roles only.
 */
const claim = (over: Partial<SpokenClaim>): SpokenClaim => ({ id: "claim:1", speaker: "a", listener: PLAYER, kind: "going-after", subject: "s", object: "o", week: 1, isTrue: true, intent: "inform", origin: "engine", ...over });

describe("sourceAsk (pure)", () => {
  it("the same story is matched across a 'you' kind and its third-party form, never across subjects", () => {
    expect(sameStory(claim({ kind: "targets-you", subject: "s", object: undefined }), claim({ kind: "going-after", subject: "s", object: "x" }))).toBe(true);
    expect(sameStory(claim({ kind: "going-after", subject: "s", object: "o" }), claim({ kind: "going-after", subject: "s", object: "p" }))).toBe(false);
    expect(sameStory(claim({ subject: "s" }), claim({ subject: "t" }))).toBe(false);
    expect(sameStory(claim({ kind: "talking-about" }), claim({ kind: "going-after" }))).toBe(false);
  });
  it("the recorded teller is the newest EARLIER claim told to the player with the same story; none => nothing to compare", () => {
    const told1 = claim({ id: "claim:1", speaker: "a" }), told2 = claim({ id: "claim:2", speaker: "b" });
    const passed = claim({ id: "claim:3", speaker: PLAYER, listener: "l", origin: "player" });
    const later = claim({ id: "claim:4", speaker: "c" });
    expect(trueSourceOf([told1, told2, passed, later], passed)).toBe("b");
    expect(trueSourceOf([passed, told1], passed)).toBeUndefined();
    expect(trueSourceOf([claim({ id: "claim:1", subject: "z" }), passed], passed)).toBeUndefined();
    expect(trueSourceOf(undefined, passed)).toBeUndefined();
  });
  it("asking falls with trust in the player, inside the band", () => {
    expect(askChance(0.1)).toBeGreaterThan(askChance(0.9));
    for (const t of [-1, 0, 0.5, 1, 2, NaN]) { const c = askChance(t); expect(c).toBeGreaterThanOrEqual(ASK.min); expect(c).toBeLessThanOrEqual(ASK.max); }
  });
  it("the read is structural: the real teller named alone matches; one other name contradicts; no name plus a plain decline dodges; anything else reads nothing", () => {
    expect(readAnswer("a", ["a"], false)).toBe("matches");
    expect(readAnswer("a", ["a", "a"], false)).toBe("matches");
    expect(readAnswer("a", ["b"], false)).toBe("contradicted");
    expect(readAnswer("a", [], true)).toBe("dodged");
    expect(readAnswer("a", [], false)).toBeUndefined();
    expect(readAnswer("a", ["a", "b"], true)).toBeUndefined();
  });
  it("the folds reuse the cover-slip scale: warm and half, half, full", () => {
    expect(answerFold("matches")).toEqual({ type: "bonding", scale: COVER.foldScale * ASK.matchShare });
    expect(answerFold("dodged")).toEqual({ type: "conflict", scale: COVER.foldScale * ASK.dodgeShare });
    expect(answerFold("contradicted")).toEqual({ type: "conflict", scale: COVER.foldScale });
  });
  it("a decline is read from the player's own words, and a plain sentence is not one", () => {
    for (const t of ["I'm not going to say.", "Nobody told me, I worked it out myself.", "I'd rather not say who.", "I saw it with my own eyes."]) expect(parseSourceDodge(t), t).toBe(true);
    for (const t of ["Let's go to the kitchen.", "", "Pass the salt."]) expect(parseSourceDodge(t), t).toBe(false);
  });
  it("the ask record is append-only: nothing disappears and a read once made stays", () => {
    const a: SourceAsk = { claimId: "claim:3", asker: "l", week: 1, source: "b" };
    expect(sourceAsksSuperset([a, { ...a, claimId: "claim:9" }], [a])).toBe(true);
    expect(sourceAsksSuperset([{ ...a, read: "matches" }], [a])).toBe(true);
    expect(sourceAsksSuperset([], [a])).toBe(false);
    expect(sourceAsksSuperset([a], [{ ...a, read: "dodged" }])).toBe(false);
    expect(sourceAsksSuperset([{ ...a, read: "matches" }], [{ ...a, read: "dodged" }])).toBe(false);
  });
});

describe("through the session: a houseguest asks the player who told them", () => {
  type Priv = { presence: Map<string, string>; live: { playedGame?: boolean; sourceAsks?: SourceAsk[]; week: number }; disclosureEpoch: number };
  const SENTINEL_SOURCE = "Zzsentinelsrcname";
  function season(seed: number, flagOn: boolean, withTeller = true, trust = 0.15) {
    const s = new GameRegistryHack().make(`orw687-${seed}-${Math.random()}`);
    s.setNpcBeliefsEnabled(true);
    s.setCoverSlipsEnabled(flagOn);
    s.createCharacter({ playerName: "P", seed });
    const p = s as unknown as Priv;
    p.live.playedGame = true;
    const [teller, asker, subj] = s.livingIds().filter((i) => i !== PLAYER) as [string, string, string];
    const house = (s as unknown as { house: GameHouse }).house;
    house.npcs.find((n) => n.id === teller)!.name = SENTINEL_SOURCE;
    if (withTeller) s.tellClaim({ speaker: teller, listener: PLAYER, kind: "going-after", subject: subj, object: asker, isTrue: true, intent: "inform" });
    for (const id of [teller, asker, subj]) p.presence.set(id, p.presence.get(PLAYER)!);
    const rel = (s as unknown as { rel: RelationshipModel }).rel;
    rel.edge(asker, PLAYER).trust = trust;
    s.noteMessage({ messageId: `m-${seed}` });
    return { s, p, teller, asker, subj, rel };
  }
  class GameRegistryHack { make(user: string): GameSessionAdapter { return new GameSessionRegistry().sandboxFor(user).session as GameSessionAdapter; } }
  const pass = (c: ReturnType<typeof season>) => c.s.recordPlayerStatement({ to: c.asker, about: c.subj, kind: "going-after", object: c.teller === c.subj ? undefined : c.asker });

  // The first seed (from 1) on which the houseguest asks, with the flag on.
  function askingSeason(wanted: "any" = "any") {
    for (let seed = 1; seed <= 80; seed++) {
      const c = season(seed, true);
      pass(c);
      if ((c.p.live.sourceAsks ?? []).length > 0) return c;
    }
    throw new Error(`no seed asked (${wanted})`);
  }

  it("some seeds ask and some do not (positive control: the path is reachable and bounded); the record names the asker and the engine's own teller", () => {
    let asks = 0, quiet = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const c = season(seed, true);
      pass(c);
      const rec = c.p.live.sourceAsks ?? [];
      if (rec.length) { asks++; expect(rec).toHaveLength(1); expect(rec[0]!.asker).toBe(c.asker); expect(rec[0]!.source).toBe(c.teller); expect(rec[0]!.read).toBeUndefined(); } else quiet++;
    }
    expect(asks).toBeGreaterThan(0);
    expect(quiet).toBeGreaterThan(0);
  });
  it("a claim the engine has NO recorded teller for is never asked about, and flag off records nothing", () => {
    for (let seed = 1; seed <= 40; seed++) { const c = season(seed, true, false); pass(c); expect(c.p.live.sourceAsks).toBeUndefined(); }
    for (let seed = 1; seed <= 40; seed++) { const c = season(seed, false); pass(c); expect(c.p.live.sourceAsks).toBeUndefined(); }
  });
  it("the narrator is handed the question as a third-person fact with the claim in public names, never the teller (wall, with positive controls)", () => {
    const c = askingSeason();
    const voice = JSON.stringify(c.s.npcVoice(c.asker) ?? {});
    expect(JSON.parse(voice).asksSource).toEqual(expect.any(String));
    const { whereabouts: _w, ...rest } = JSON.parse(voice); // the teller is in the room, so their public name shows in whereabouts; nowhere else
    expect(JSON.stringify(rest)).not.toContain(SENTINEL_SOURCE); // the teller's (sentinel) name is nowhere else in what the narrator is handed
    expect(JSON.stringify(c.p.live.sourceAsks)).toContain(c.teller); // positive control: the engine does hold who told the player
  });
  it("naming the real teller is believed (a small warm step, once); the player's answer is never written for them", () => {
    const c = askingSeason();
    const before = c.rel.edge(c.asker, PLAYER).affinity;
    c.s.resolvePlayerMove({ text: `${SENTINEL_SOURCE} told me.` });
    const ask = c.p.live.sourceAsks![0]!;
    expect(ask.read).toBe("matches");
    const after = c.rel.edge(c.asker, PLAYER).affinity;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(JSON.stringify(c.s.npcVoice(c.asker))).readsAnswer).toBe("believed");
    c.s.resolvePlayerMove({ text: `${SENTINEL_SOURCE} told me, really.` }); // answered again: nothing folds twice
    expect(c.rel.edge(c.asker, PLAYER).affinity).toBe(after);
    expect(JSON.parse(JSON.stringify(c.p.live.sourceAsks))[0].read).toBe("matches"); // persistence round-trip
  });
  it("naming someone else is doubted and costs the asker's read of the player; a plain refusal is noticed (a smaller step); both fold once", () => {
    const c = askingSeason();
    const other = c.s.livingIds().find((i) => i !== PLAYER && i !== c.teller && i !== c.asker)!;
    const house = (c.s as unknown as { house: GameHouse }).house;
    const otherName = house.npcs.find((n) => n.id === other)!.name;
    const t0 = c.rel.edge(c.asker, PLAYER).threat;
    c.s.resolvePlayerMove({ text: `${otherName} did.` });
    expect(c.p.live.sourceAsks![0]!.read).toBe("contradicted");
    expect(c.rel.edge(c.asker, PLAYER).threat).toBeGreaterThanOrEqual(t0);
    expect(JSON.parse(JSON.stringify(c.s.npcVoice(c.asker))).readsAnswer).toBe("doubts-it");
    const d = askingSeason();
    d.s.resolvePlayerMove({ text: "I'm not going to say who." });
    expect(d.p.live.sourceAsks![0]!.read).toBe("dodged");
    expect(JSON.parse(JSON.stringify(d.s.npcVoice(d.asker))).readsAnswer).toBe("noticed-a-dodge");
  });
  it("ignoring it (or any message that is not an answer) changes nothing, and it lapses with the week", () => {
    const c = askingSeason();
    const e0 = JSON.stringify(c.rel.edge(c.asker, PLAYER));
    c.s.resolvePlayerMove({ text: "Anyone want some food?" });
    expect(c.p.live.sourceAsks![0]!.read).toBeUndefined();
    expect(JSON.stringify(c.rel.edge(c.asker, PLAYER))).toBe(e0);
    c.p.live.week += 1;
    c.s.resolvePlayerMove({ text: `${SENTINEL_SOURCE} told me.` });
    expect(c.p.live.sourceAsks![0]!.read).toBeUndefined();
  });
  it("the asker must be in the room to read an answer", () => {
    const c = askingSeason();
    c.p.presence.set(c.asker, "elsewhere-room");
    c.s.resolvePlayerMove({ text: `${SENTINEL_SOURCE} told me.` });
    expect(c.p.live.sourceAsks![0]!.read).toBeUndefined();
  });
});

describe("the disclosure spin on the 0092 drip", () => {
  function drip(seed: number, spinOn: boolean) {
    const s = new GameSessionAdapter();
    const calls: Array<{ subject: string; scale: number | undefined }> = [];
    s.setOnThreadSurfaceToPlayer((subject, _rumor, scale) => { calls.push({ subject, scale }); return true; });
    s.setDisclosureSpinEnabled(spinOn);
    s.createCharacter({ playerName: "P", seed });
    const p = s as unknown as { live: { playedGame?: boolean }; storyThreads: Array<{ sourceId: string; id: string }>; house: GameHouse; surfaceThread: (t: unknown, pos: unknown, rng: unknown, force?: string) => unknown; rel: RelationshipModel };
    p.live.playedGame = true;
    s.noteMessage({ messageId: "first" });
    const t = p.storyThreads[0]!;
    const src = p.house.npcs.find((n) => n.id === t.sourceId)!;
    src.character.strategyStyle = "strategic";
    for (const [a, b] of [[src.id, PLAYER], [PLAYER, src.id]] as const) { const e = p.rel.edge(a, b); e.trust = 0.95; e.affinity = 0.95; e.threat = 0.05; }
    const out = p.surfaceThread(t, { evicted: new Set<string>() }, { next: () => 0.5, int: () => 0 }, "player");
    return { s, calls, src: src.id, out };
  }
  it("a slanted drip is recorded at the spun confidence and carries the `slant` fact; only with the flag on; the decision itself is unchanged", () => {
    let slanted = 0, plain = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const on = drip(seed, true), off = drip(seed, false);
      expect(on.calls.length).toBe(off.calls.length); // share / slip / hold is the same one draw
      if (on.calls.length === 0) continue;
      expect(off.calls[0]!.scale).toBeUndefined();
      expect(off.s.disclosureThisBeat(off.src)?.slant).toBeUndefined();
      if (on.calls[0]!.scale !== undefined) {
        slanted++;
        expect(on.calls[0]!.scale).toBe(SPIN.spunConfidence);
        expect(on.s.disclosureThisBeat(on.src)?.slant).toBe(true);
        expect(on.s.disclosureThisBeat(on.src)?.via).toBe("drip");
      } else plain++;
    }
    expect(slanted).toBeGreaterThan(0);
    expect(plain + slanted).toBeGreaterThan(0);
  });
});

describe("the disclosure spin on the orientation disclosure keeps the 0141 wall", () => {
  type Priv = { privateOrientations: Record<string, string>; volunteerOrientation(id: string): string | undefined; live: { playedGame?: boolean } };
  function started(seed: number, spinOn: boolean) {
    const s = new GameSessionAdapter();
    const told: Array<{ content: string; confidence: number }> = [];
    s.setOnConfide((_n, content, confidence) => { told.push({ content, confidence }); return true; });
    s.setDisclosureSpinEnabled(spinOn);
    s.createCharacter({ playerName: "P", seed });
    const house = (s as unknown as { house: GameHouse }).house;
    const npc = house.npcs[0]!;
    npc.character.strategyStyle = "strategic";
    (s as unknown as Priv).privateOrientations = { [npc.id]: "zzprivorient" };
    (s as unknown as Priv).live.playedGame = true;
    const rel = (s as unknown as { rel: RelationshipModel }).rel;
    for (const [a, b] of [[npc.id, PLAYER], [PLAYER, npc.id]] as const) { const e = rel.edge(a, b); e.trust = 0.98; e.affinity = 0.98; e.threat = 0.02; }
    const presence = (s as unknown as { presence?: Map<string, string> }).presence;
    if (presence) { presence.set(PLAYER, "kitchen"); presence.set(npc.id, "kitchen"); }
    s.noteMessage({ messageId: "first" });
    return { s, npc: npc.id, told };
  }
  // The route cache is the seam between the one seeded draw and the telling, so it is set directly: the draw itself (trust bar, rarity 0.12) is proven by orientationDisclosure.test.ts.
  type Seam = Priv & { orientationRoutes: Map<string, string>; orientationSpins: Set<string>; live: { week: number; playedGame?: boolean }; phase: string };
  function volunteer(spinOn: boolean, slanted: boolean) {
    const g = started(7, spinOn);
    const p = g.s as unknown as Seam;
    const key = `volunteer:${g.npc}:${p.live.week}:${p.phase}`;
    p.orientationRoutes.set(key, "share");
    if (slanted) p.orientationSpins.add(key);
    const said = p.volunteerOrientation(g.npc);
    return { ...g, said };
  }
  it("a slanted unprompted telling is recorded at the spun confidence, the words are unchanged, and the narrator is never handed a `slants` fact for it", () => {
    const straight = volunteer(true, false), slanted = volunteer(true, true), off = volunteer(false, true);
    expect(straight.said).toBeTruthy();
    expect(straight.told[0]!.confidence).toBeCloseTo(0.9, 6);
    expect(slanted.told[0]!.confidence).toBeCloseTo(0.9 * SPIN.spunConfidence, 6);
    expect(off.told[0]!.confidence).toBeCloseTo(0.9, 6); // flag off => today
    expect(slanted.told[0]!.content).toBe(straight.told[0]!.content);
    const voice = JSON.stringify(slanted.s.npcVoice(slanted.npc) ?? {});
    expect(voice).not.toContain("slants");
    expect(voice).not.toContain("zzprivorient"); // the wall: the orientation never rides the narrator's voice view
    expect(slanted.s.disclosureThisBeat(slanted.npc)?.slant).toBeUndefined();
    expect(slanted.told[0]!.content).toContain("zzprivorient"); // positive control: the orientation DID reach the player's record, by the told-by path only
  });
});

describe("ORW-687: a name the player rules out is not a name they gave", () => {
  const roster = [{ id: "a", name: "Alpha Aster" }, { id: "b", name: "Bravo Birch" }];
  it("reads a negated name as nothing, and still reads the name they do give", async () => {
    const { namedSources, readAnswer } = await import("../../src/engine/sourceAsk");
    expect(namedSources("it wasn't Alpha", roster, "x")).toEqual([]);
    expect(namedSources("not Alpha, never Alpha Aster", roster, "x")).toEqual([]);
    expect(namedSources("it wasn't Alpha, it was Bravo", roster, "x")).toEqual(["b"]);
    expect(namedSources("Alpha told me", roster, "x")).toEqual(["a"]);
    expect(readAnswer("a", namedSources("it wasn't Alpha", roster, "x"), false)).toBeUndefined();
  });
});
