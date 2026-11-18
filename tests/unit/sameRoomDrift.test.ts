import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandbox } from "../support/sandbox";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { spreadBetween, type SpreadDeps } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { driftRetelling, rumorFrom, RUMOR_GLOSS } from "../../src/engine/gossip";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc, PLAYER } from "../../src/domain/ids";
import type { VoiceProfile } from "../../src/domain/voiceProfile";

/**
 * ORW-589 - the same-room retelling drift. With the same-room spread on (the default), the graph path's per-retelling drift (ORWELL_GOSSIP_DRIFT) was bypassed, and the spread's audience was a constant 0.
 * Now a played game's scene retelling drifts (from the 2nd retelling) on a forked stream and the room's other awake people count as the audience. Roles only; hidden layer only.
 */
const A = npc(1), B = npc(2), S1 = npc(3), S2 = npc(4);
const TRUE_TEXT = rumorFrom(S1, S2, "alliance");
const DRAMATIC: VoiceProfile = { register: "crude", rhythm: "rambling", energy: "manic", directness: "evasive", humor: "cutting" } as VoiceProfile;

function chain(o: { seed: number; hops: number; drift: boolean }) {
  const sb = buildSandbox(7);
  const k = sb.engine.knowledge;
  k.seedBelief(A, { content: TRUE_TEXT, originalContent: TRUE_TEXT, factId: "f1", confidence: 1, hops: o.hops, distortion: 0, source: A, subject: S1 }, "origin");
  const rngs: SeededRandom[] = [];
  const deps: SpreadDeps = {
    knowledge: k, told: new ToldLedger(),
    rngFor: () => { const r = new SeededRandom(o.seed); rngs.push(r); return r; },
    trust: () => 0.95, affinity: () => 0.95, threat: () => 0, style: () => "emotional", volatility: () => 0.9, audienceOf: () => 0,
    ...(o.drift ? { drift: { voiceOf: () => DRAMATIC } } : {}),
  };
  const r = spreadBetween(A, B, deps)[0]!;
  return { k, r, rngs };
}
const got = (k: ReturnType<typeof chain>["k"]) => k.knownTo(B).find((f) => f.factId === "f1");
function sharingSeed(): number {
  for (let seed = 1; seed < 200; seed++) if (chain({ seed, hops: 1, drift: false }).r.transmitted) return seed;
  throw new Error("no transmitting seed");
}

describe("ORW-589 driftRetelling (the graph path's rules for one same-room retelling)", () => {
  it("a direct (first) retelling stays faithful; content with no scene nature is untouched", () => {
    expect(driftRetelling(TRUE_TEXT, 1, new SeededRandom(1))).toEqual({ content: TRUE_TEXT, drifted: false });
  });
  it("free text with no scene nature is never reworded: only the hedge in the teller's voice and the recorded distortion change", () => {
    const d = driftRetelling("word in the house: two of them keep slipping off together", 3, new SeededRandom(1), DRAMATIC);
    expect(d.drifted).toBe(true);
    expect(d.content.startsWith("word in the house: two of them keep slipping off together · ")).toBe(true);
  });
  it("from the second retelling the text changes: always a hedge, and across seeds the claimed nature moves a rung", () => {
    let natureMoved = 0;
    for (let seed = 1; seed < 80; seed++) {
      const d = driftRetelling(TRUE_TEXT, 2, new SeededRandom(seed));
      expect(d.drifted).toBe(true);
      expect(d.content).not.toBe(TRUE_TEXT);
      if (!d.content.includes(RUMOR_GLOSS.alliance!)) natureMoved++;
    }
    expect(natureMoved, "the nature drifts sometimes, not never and not always").toBeGreaterThan(5);
    expect(natureMoved).toBeLessThan(60);
  });
  it("re-drifting a hedged text does not stack hedges, and is deterministic", () => {
    const once = driftRetelling(TRUE_TEXT, 2, new SeededRandom(3)).content;
    const twice = driftRetelling(once, 3, new SeededRandom(4)).content;
    expect(twice.split(" · ")).toHaveLength(2);
    expect(driftRetelling(TRUE_TEXT, 2, new SeededRandom(3)).content).toBe(once);
  });
});

describe("ORW-589 the spread applies it", () => {
  const seed = sharingSeed();
  it("a second retelling arrives drifted, the Vault truth (originalContent) untouched, distortion raised", () => {
    const off = chain({ seed, hops: 1, drift: false });
    const on = chain({ seed, hops: 1, drift: true });
    expect(got(off.k)!.content, "flag off = today: the text passes through unchanged").toBe(TRUE_TEXT);
    expect(got(on.k)!.content).not.toBe(TRUE_TEXT);
    expect(got(on.k)!.originalContent).toBe(TRUE_TEXT);
    expect(got(on.k)!.hops).toBe(2);
    expect(got(on.k)!.distortion!).toBeGreaterThan(got(off.k)!.distortion ?? 0);
    expect(got(on.k)!.distortion!).toBeLessThanOrEqual(1);
  });
  it("a first-hand telling (hops 0 -> 1) is faithful even with drift on", () => {
    const on = chain({ seed, hops: 0, drift: true });
    expect(got(on.k)!.content).toBe(TRUE_TEXT);
  });
  it("drift draws only from a fork: the pair's own stream is where it was without drift", () => {
    const off = chain({ seed, hops: 1, drift: false }).rngs[0]!;
    const on = chain({ seed, hops: 1, drift: true }).rngs[0]!;
    expect([on.next(), on.next(), on.next()]).toEqual([off.next(), off.next(), off.next()]);
  });
  it("wall: nothing reaches the player, and a hidden-only marker in the Vault text never rides the drifted content", () => {
    const on = chain({ seed, hops: 1, drift: true });
    expect(on.k.knownTo(PLAYER).length).toBe(0);
    expect(got(on.k)!.content).not.toContain("originalContent");
  });
});

describe("ORW-589 reachable in a played game", () => {
  function play(driftOn: boolean): number {
    const reg = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-srd-"))));
    const sb = reg.sandboxFor("u");
    sb.session.setGossipDriftEnabled(driftOn);
    sb.session.createCharacter({ playerName: "P", seed: 5 });
    sb.session.noteMessage({ messageId: "m1" });
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 5 });
    for (let i = 0; i < 40; i++) orch.advance("u", "offscreen-tick");
    let drifted = 0;
    for (const id of sb.session.livingIds()) {
      if (id === PLAYER) continue;
      for (const f of sb.engine.knowledge.knownTo(id)) if ((f.hops ?? 0) >= 2 && (f.distortion ?? 0) > 0 && (f.distortion ?? 0) < 1 && / · /.test(f.content)) drifted++; // the other diffusers clamp a hedged retelling's distortion to 1; only the spread leaves it fractional
    }
    return drifted;
  }
  it("with the flag on, a retold rumor in a played game carries a same-room drift hedge; with it off none does", () => {
    expect(play(false)).toBe(0);
    expect(play(true)).toBeGreaterThan(0);
  });
});
