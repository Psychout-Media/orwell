import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { NPC_COUNT } from "../../src/engine/characterFactory";
import { momentForPhase } from "../../src/engine/momentPrompts";

// Roles only — the player's authored display name is a role label, never a persona name.
const PLAYER_NAME = "The Player";

describe("onboarding — createCharacter starts a game (the missing step past account creation)", () => {
  it("before a game starts, state is not started and the moment is character-creation", () => {
    const s = new GameSessionAdapter();
    const view = s.getGameState();
    expect(view.started).toBe(false);
    expect(view.player).toBeNull();
    expect(view.moment).toBe("character-creation");
  });

  it("createCharacter authors the player and fills the house", () => {
    const s = new GameSessionAdapter();
    const view = s.createCharacter({ playerName: PLAYER_NAME, seed: 7 });
    expect(view.started).toBe(true);
    expect(view.player?.name).toBe(PLAYER_NAME);
    expect(view.house).toHaveLength(NPC_COUNT);
    expect(view.house.every((h) => h.name.length > 0)).toBe(true);
  });

  it("is reproducible by seed and varies across seeds", () => {
    const a = new GameSessionAdapter().createCharacter({ playerName: PLAYER_NAME, seed: 7 });
    const b = new GameSessionAdapter().createCharacter({ playerName: PLAYER_NAME, seed: 7 });
    const c = new GameSessionAdapter().createCharacter({ playerName: PLAYER_NAME, seed: 8 });
    expect(a.house.map((h) => h.name)).toEqual(b.house.map((h) => h.name));
    expect(a.house.map((h) => h.name)).not.toEqual(c.house.map((h) => h.name));
  });
});

describe("onboarding — the Vault-free projection (no hidden houseguest detail crosses the wall)", () => {
  it("house cards carry the curated PUBLIC facets (B61) — and nothing hidden", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: PLAYER_NAME, seed: 3 });
    const blob = JSON.stringify(s.getGameState().house);
    // The genuinely hidden layer never crosses: aptitudes, the soul, hidden elements.
    // NB: bare "physical"/"mental"/"social" are NOT banned — they are legitimate PUBLIC words
    // (a "physical therapist" vocation, a "social" strategy style, L28). What must never cross is
    // the serialized STAT BLOCK — the aptitude KEYS (`"physical":<n>`) and any numeric value.
    for (const leak of ['"physical":', '"mental":', '"social":', '"stats"', '"soul"', "volatility", "emotionalState", "hiddenElement", "secret-motive", "concealed-aptitude"]) {
      expect(blob.includes(leak), `house projection leaked "${leak}"`).toBe(false);
    }
    // No numeric aptitude rides along anywhere (engine stats are floats).
    expect(blob).not.toMatch(/\d\.\d/);
    const card = s.getGameState().house[0]!;
    // 0058 adds the PUBLIC deep facets to the card: a multi-sentence `biography` + the structured
    // `physicalCharacteristics` facet (both Vault-free, byte-stable). The hidden half never appears.
    // 0063 adds the PUBLIC identity facets: `ethnicity` + `genderPresentation` (always present) and
    // `outOrientation` (present ONLY when the houseguest is publicly out — this seeded NPC is). The
    // CLOSETED orientation is engine-only (`privateOrientations`, Vault-sealed) and is NEVER on the card.
    expect(Object.keys(card).sort()).toEqual(
      // L28 + 0058 + 0063: vocation/hometown/demeanor + biography/physicalCharacteristics + the public
      // identity facets are ALL Vault-free, byte-stable; the hidden half (secrets/goals/perception/
      // closeted orientation) never appears. L29: the prose `appearance` is NOT on a 0058 card — the
      // structured `physicalCharacteristics` is the single physical descriptor (the prose is the pre-0058
      // fallback only), so the picture and the narrated body can never contradict.
      // I6 distinct-voices fix (2026-07-05): `voice` (the 0084 fingerprint) now rides the roster card too
      // — PUBLIC, byte-stable, Vault-free, the same facet npcVoice exposes.
      ["age", "archetype", "background", "biography", "demeanor", "ethnicity", "genderPresentation", "hometown", "id", "name", "outOrientation", "physicalCharacteristics", "presentation", "status", "strategyStyle", "vocation", "voice"].sort());
  });
});

describe("moment prompts — the managed per-moment injection (so the LLM is the game, not a generic assistant)", () => {
  it("builds a system prompt that establishes the game-master persona and the moment", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: PLAYER_NAME, seed: 5 });
    const { systemPrompt, moment } = s.getMomentPrompt({ moment: "nominations" });
    expect(moment).toBe("nominations");
    expect(systemPrompt).toContain("Big Brother");
    expect(systemPrompt.toLowerCase()).toContain("never say you are"); // anti generic-assistant framing
    expect(systemPrompt).toMatch(/nomination ceremony/i); // ORW-249: before the engine runs it, the moment names the ceremony and says it has NOT happened (commit before voice)
    expect(systemPrompt).toContain(PLAYER_NAME); // Vault-free context woven in
  });

  it("defaults the moment to the current phase when none is requested", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: PLAYER_NAME, seed: 5 });
    expect(s.getMomentPrompt({}).moment).toBe(momentForPhase("premiere"));
  });

  it("the injected prompt carries no engine-internal stat fields", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: PLAYER_NAME, seed: 5 });
    const { systemPrompt } = s.getMomentPrompt({});
    for (const leak of ["physical:", "mental:", "social:", "volatility"]) {
      expect(systemPrompt.includes(leak), `prompt leaked "${leak}"`).toBe(false);
    }
  });
});
