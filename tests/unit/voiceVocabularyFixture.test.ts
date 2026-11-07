import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { HUMOR_WORDS, VOICE_DIALS, voiceFingerprint, type VoiceProfile } from "../../src/engine/voice";

/**
 * ORW-184, ENGINE half of the voice-vocabulary drift gate. `frontend/tests/fixtures/engine_voice_vocabulary.json`
 * is the one shared copy of (a) the seeded voice dial vocabulary and (b) the roster-clause format `voiceFingerprint`
 * renders. The FE half (`frontend/tests/test_orw184_voice_repair.py`) proves the cast-authoring voice check accepts
 * every engine dial value (the 11-06 bug: it rejected the engine's own `humor: "none"` and dropped whole voices)
 * and that its clause parser inverts the format (the per-dial repair reads the seeded dials back from the card).
 * This half keeps the fixture honest against the engine, so an engine-only PR that changes either one fails here
 * instead of leaving a latent break for the next FE PR. Roles only.
 */
const FIX = JSON.parse(readFileSync("frontend/tests/fixtures/engine_voice_vocabulary.json", "utf8")) as {
  dials: Record<string, string[]>;
  fingerprintTemplate: string;
  humorWords: Record<string, string>;
};

describe("the shared voice-vocabulary fixture matches the engine", () => {
  it("lists exactly the engine's seeded dial vocabulary", () => {
    const engine = Object.fromEntries(Object.entries(VOICE_DIALS).map(([k, v]) => [k, [...v]]));
    expect(FIX.dials).toEqual(engine);
  });

  it("renders the roster clause in exactly the fixture's format", () => {
    const voice: VoiceProfile = {
      register: "formal", rhythm: "clipped", energy: "flat", directness: "evasive", humor: "none",
      stressTell: "deflects with a joke", signature: "a signature sentence", lexicon: ["filler"],
    };
    const slot = (key: string): string => (key === "humor" ? (FIX.humorWords[voice.humor] ?? voice.humor) : String(voice[key as keyof VoiceProfile]));
    const expected = FIX.fingerprintTemplate.replace(/\{(\w+)\}/g, (_m, key: string) => slot(key));
    expect(voiceFingerprint(voice)).toBe(expected);
  });

  it("reads 'no humor' for the humor dial 'none' (never the broken 'none humor'), every other value as itself", () => {
    const base: VoiceProfile = {
      register: "formal", rhythm: "clipped", energy: "flat", directness: "evasive", humor: "none",
      stressTell: "goes quiet", signature: "s", lexicon: ["x"],
    };
    for (const humor of VOICE_DIALS.humor) {
      const line = voiceFingerprint({ ...base, humor });
      expect(line).not.toContain("none humor");
      expect(line).toContain(humor === "none" ? ", no humor;" : `, ${humor} humor;`);
    }
  });

  it("keeps HUMOR_WORDS equal to the fixture's humorWords, and reads only its own keys", () => {
    expect({ ...HUMOR_WORDS }).toEqual(FIX.humorWords);
    const base: VoiceProfile = {
      register: "formal", rhythm: "clipped", energy: "flat", directness: "evasive", humor: "constructor",
      stressTell: "goes quiet", signature: "s", lexicon: ["x"],
    };
    // An authored humor word that happens to name an Object.prototype member still reads as itself.
    expect(voiceFingerprint(base)).toContain(", constructor humor;");
  });
});
