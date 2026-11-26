import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { recordClaim } from "../../src/engine/beliefStore";
import { askableClaims, decideSourceAnswer, heldBeliefFor, parseWhoToldYou, protectChance, PROTECT_MAX, PROTECT_MIN } from "../../src/engine/claimSource";

/** 0152 (theme 2 slice 4b): the parser, the decision, and the Vault Wall around "who told you that?". Roles only. */
describe("parseWhoToldYou", () => {
  it.each([
    "Who told you that?", "who told you this", "Wait, who said that?", "Where did you hear that?", "how do you know that", "Who'd you hear that from?",
    "who told you?", "Who's your source?", "who did you hear this from", "I narrow my eyes. \"Who told you that?\"", "Where'd you get that from?",
    // ORW-720: the question runs on into the claim (Season 2 playtest, each a miss before)
    "Kristin, who told you Camila's coming after you? We'll sort it in the morning.", "Who told you there was one going round?", "Thank you, Chad. Who told you different?", "And who told you otherwise?", "Who told you about Lisa and Nikhil? Give me one actual name.",
  ])("reads %s as the question", (t) => expect(parseWhoToldYou(t)).toBe(true));
  it.each([
    "", "I go to the kitchen", "Who won the veto?", "I told you that already", "who told you to come here", "Tell me what you heard", "how do you do",
    "I won't ask who told you that.", "Did you tell anyone?", "who told you to leave the kitchen", "Who told you to do that",
  ])("does not read %s", (t) => expect(parseWhoToldYou(t)).toBe(false));
});

describe("decideSourceAnswer", () => {
  const base = { seed: 3, holder: "h", claimId: "claim:1", origin: "told" as const, source: "s", sourceAffinity: 0.5, sourceTrust: 0.5, playerTrust: 0.5 };
  it("is deterministic, bounded, and gives a witnessed belief no source", () => {
    expect(decideSourceAnswer(base)).toBe(decideSourceAnswer({ ...base }));
    expect(decideSourceAnswer({ ...base, origin: "witnessed", source: undefined })).toBe("witnessed");
    expect(decideSourceAnswer({ ...base, source: undefined })).toBeUndefined();
    for (const f of [0, 1]) for (const p of [0, 1]) {
      const c = protectChance({ sourceAffinity: f, sourceTrust: f, playerTrust: p });
      expect(c).toBeGreaterThanOrEqual(PROTECT_MIN); expect(c).toBeLessThanOrEqual(PROTECT_MAX);
    }
  });
  it("protects more when fond of the source and unsure of the player", () => {
    const rate = (f: number, p: number) => { let k = 0; for (let i = 0; i < 500; i++) if (decideSourceAnswer({ ...base, claimId: `claim:${i}`, sourceAffinity: f, sourceTrust: f, playerTrust: p }) === "protect") k++; return k; };
    expect(rate(0.9, 0.2)).toBeGreaterThan(rate(0.1, 0.8) + 100);
  });
});

function season(): { s: GameSessionAdapter; ids: string[] } {
  const s = new GameSessionRegistry().sandboxFor(`claim-source-${Math.random()}`).session as GameSessionAdapter;
  s.setNpcBeliefsEnabled(true);
  s.createCharacter({ playerName: "P", seed: 7 });
  return { s, ids: s.livingIds().filter((i) => i !== PLAYER) };
}
const priv = (s: GameSessionAdapter) => s as unknown as { presence: Map<string, string>; claimSourceNote: string | null; live: { beliefs?: Record<string, never[]> } };
const here = (s: GameSessionAdapter, id: string) => { const p = priv(s); p.presence.set(id, p.presence.get(PLAYER)!); };

describe("the Vault Wall around the answer", () => {
  it("only a claim told TO the player, by someone in the room, can be asked about", () => {
    const { s, ids } = season();
    const [a, b, c] = ids as [string, string, string];
    s.tellClaim({ speaker: a, listener: b, kind: "targets-you", subject: c, isTrue: true, intent: "warn" }); // told to another NPC, not the player
    here(s, a);
    s.resolvePlayerMove({ text: "Who told you that?" });
    expect(priv(s).claimSourceNote).toBeNull();
    s.tellClaim({ speaker: b, listener: PLAYER, kind: "targets-you", subject: c, isTrue: true, intent: "warn" }); // told to the player, but the speaker is elsewhere
    priv(s).presence.set(b, "somewhere-else");
    s.resolvePlayerMove({ text: "Who told you that?" });
    expect(priv(s).claimSourceNote).toBeNull();
  });
  it("the note and every outward read carry no truth, intent or claim id", async () => {
    const reg = new GameSessionRegistry().sandboxFor(`claim-source-leak-${Math.random()}`);
    const s = reg.session as GameSessionAdapter;
    s.setNpcBeliefsEnabled(true);
    s.createCharacter({ playerName: "P", seed: 7 });
    const [a, b, c] = s.livingIds().filter((i) => i !== PLAYER) as [string, string, string];
    recordClaim(((s as unknown as { live: { beliefs: Record<string, unknown[]> } }).live.beliefs ??= {}) as never, { holder: a, kind: "targets-me", subject: c, object: a, value: true, origin: "told", source: b, confidence: 0.7, week: 1 });
    s.tellClaim({ speaker: a, listener: PLAYER, kind: "targets-you", subject: c, isTrue: false, intent: "mislead" });
    here(s, a);
    s.resolvePlayerMove({ text: "who told you that?" });
    const note = priv(s).claimSourceNote;
    expect(note).toBeTruthy();
    expect(note).not.toMatch(/isTrue|mislead|intent|claim:|false|lie|mistak|wrong/i);
    const out = JSON.stringify(await reg.mcp.player.callTool("getMomentPrompt", {}));
    expect(out).not.toMatch(/claim:\d|isTrue|mislead/);
    expect(out).toContain("WHO TOLD THEM");
  });
  it("heldBeliefFor ignores a refuted belief and picks the newest", () => {
    const store = {};
    recordClaim(store, { holder: "a", kind: "targets-me", subject: "c", object: "a", value: true, origin: "told", source: "old", confidence: 0.9, week: 1 });
    recordClaim(store, { holder: "a", kind: "targets-me", subject: "c", object: "a", value: true, origin: "told", source: "new", confidence: 0.5, week: 2 });
    expect(heldBeliefFor(store, { speaker: "a", kind: "targets-you", subject: "c" })?.source).toBe("new");
    expect(heldBeliefFor(store, { speaker: "a", kind: "targets-you", subject: "zz" })).toBeUndefined();
    expect(askableClaims(undefined, new Set(["a"]))).toEqual([]);
  });
});

describe("slice 4a and 4b agree: a held targets-me told as going-after is askable", () => {
  it("heldBeliefFor finds a targets-me belief behind a going-after claim whose object is the speaker", () => {
    const store = {} as Parameters<typeof heldBeliefFor>[0] & object;
    recordClaim(store as never, { holder: "a", kind: "targets-me", subject: "b", object: "a", value: true, origin: "told", source: "c", confidence: 0.7, week: 2 });
    const got = heldBeliefFor(store as never, { speaker: "a", kind: "going-after", subject: "b", object: "a" });
    expect(got?.source).toBe("c");
  });
});

describe("ORW-560: the houseguest asked is the one answering", () => {
  const nameOf = (s: GameSessionAdapter, id: string) => s.getGameState().house.find((h) => h.id === id)!.name;
  function setup() {
    const { s, ids } = season();
    const [a, b, c, d] = ids as [string, string, string, string];
    // a told the player something, with a belief behind it sourced to b; d is in the room too and never told the player anything
    recordClaim(((s as unknown as { live: { beliefs: Record<string, unknown[]> } }).live.beliefs ??= {}) as never, { holder: a, kind: "targets-me", subject: c, object: a, value: true, origin: "told", source: b, confidence: 0.7, week: 1 });
    s.tellClaim({ speaker: a, listener: PLAYER, kind: "targets-you", subject: c, isTrue: true, intent: "warn" });
    here(s, a); here(s, d);
    return { s, a, b, d };
  }
  it("a named houseguest who never told the player anything names no one, never someone else's source", () => {
    const { s, a, d } = setup();
    s.resolvePlayerMove({ text: `${nameOf(s, d).split(" ")[0]}, who told you that?` });
    const note = priv(s).claimSourceNote!;
    expect(note).toContain(nameOf(s, d));
    expect(note).toMatch(/names no one/);
    expect(note).not.toContain(nameOf(s, a));
  });
  it("the named houseguest who did tell the player is the one who answers", () => {
    const { s, a } = setup();
    s.resolvePlayerMove({ text: `${nameOf(s, a).split(" ")[0]}, who told you that?` });
    expect(priv(s).claimSourceNote).toContain(`the player asked ${nameOf(s, a)}`);
  });
  it("with no name, whoever last told the player something answers", () => {
    const { s, a } = setup();
    s.resolvePlayerMove({ text: "who told you that?" });
    expect(priv(s).claimSourceNote).toContain(`the player asked ${nameOf(s, a)}`);
  });
  it("names are whole words: Cara is not found in Carla", async () => {
    const { namedInText } = await import("../../src/engine/claimSource");
    expect(namedInText("Carla, who told you that?", "Cara Doe")).toBe(false);
    expect(namedInText("Carla, who told you that?", "Carla Roe")).toBe(true);
    expect(namedInText("hey carla roe", "Carla Roe")).toBe(true);
  });
});
