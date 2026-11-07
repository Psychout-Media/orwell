import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VOICE_DIALS, voiceFingerprint, type VoiceProfile } from "../../src/engine/voice";

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
    const expected = FIX.fingerprintTemplate.replace(/\{(\w+)\}/g, (_m, key: string) => String(voice[key as keyof VoiceProfile]));
    expect(voiceFingerprint(voice)).toBe(expected);
  });
});
