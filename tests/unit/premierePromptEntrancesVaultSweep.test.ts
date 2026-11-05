import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { npc } from "../../src/domain/ids";

/**
 * Premiere ENTRANCES + TOAST - the NARRATOR PROMPT is Vault-free at every step (live sentinel sweep).
 *
 * `premiereDay1.test.ts` sweeps the premiere prompt with entrances OFF, so the entrance and toast prompt fragments
 * (`premiereEntrancesFragment` / `premiereEntranceLines`) were never swept; `premiereEntrancesVaultFree.test.ts` sweeps the
 * engine outputs but not `getMomentPrompt`. Here, with `ORWELL_PREMIERE_ENTRANCES=1`, we plant unique sentinels in hidden
 * engine state (Vault records, hidden secret-motive / pre-game-tie elements, soul memory / leaning beliefs, hidden relationship numbers), drive a LIVE
 * session through the entrances stage then the toast stage, and at EVERY step assert the narrator moment prompt (and the
 * admin / God-Mode surface and the other player-facing premiere surfaces) contain none of them. Roles only.
 */
beforeEach(() => { vi.stubEnv("ORWELL_PREMIERE_ENTRANCES", "1"); });
afterEach(() => { vi.unstubAllEnvs(); });

const TEXT = {
  vault: "SENTINEL-PE-vault-confessional-4471",
  secret: "SENTINEL-PE-hidden-secret-5582",
  backstory: "SENTINEL-PE-hidden-backstory-6693",
  memory: "SENTINEL-PE-house-soul-memory-7704",
  soulMemory: "SENTINEL-PE-soul-store-memory-7705",
  belief: "SENTINEL-PE-belief-8815",
} as const;
// Hidden relationship numbers: digit tails unlikely to occur anywhere by chance and stable under the small public first-read fold
// (trust/affinity move by +0.01/+0.02 at the head of the number, the tail digits survive). threat/alignment/confidence/reliability are untouched.
const NUM = { trust: 0.70419283, affinity: 0.30576182, threat: 0.91827364, alignment: 0.62738491, confidence: 0.53819274, reliability: 0.41928375 };
const NUM_TAILS = ["419283", "576182", "91827364", "62738491", "53819274", "41928375"];

function live(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`pe-prompt-sweep-${seed}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  // Vault: a hidden confessional record.
  sb.engine.vault.writeHidden({ id: "pe:v", kind: "confessional", content: TEXT.vault });
  // Hidden character elements + the house-side soul memory (the persisted SessionCore shape), via snapshot -> restore.
  const core = sb.session.snapshot();
  const house = core.house!;
  expect(house.npcs.length + 1, "precondition: a full house").toBeGreaterThanOrEqual(16);
  for (const n of house.npcs) {
    n.soul.memory.push(`${TEXT.memory}-${n.id}`);
    n.character.hiddenElements.push({ kind: "secret-motive", detail: `${TEXT.secret}-${n.id}` });
    n.character.hiddenElements.push({ kind: "pre-game-tie", detail: `${TEXT.backstory}-${n.id}` });
  }
  sb.session.restore(core);
  // The engine Soul store (narrative + memories): a leaning-section memory carries the "belief" sentinel.
  for (const n of house.npcs) {
    sb.engine.soul.recordToSoul(n.id, `${TEXT.soulMemory}-${n.id}`);
    sb.engine.soul.recordToSoul(n.id, `${TEXT.belief}-${n.id}`, "leaning");
  }
  // Hidden relationship numbers on every ordered pair (the live RelationshipModel the engine reads from).
  const ids = [house.player.id, ...house.npcs.map((n) => n.id)];
  for (const a of ids) for (const b of ids) if (a !== b) Object.assign(sb.engine.relationships.edge(a, b), NUM);
  return sb;
}

/** Every sentinel found in a blob (text sentinels and numeric tails). */
function leaks(blob: string): string[] {
  return [...Object.values(TEXT), ...NUM_TAILS].filter((s) => blob.includes(s));
}

type Sb = ReturnType<typeof live>;
/** Sweep every narrator / player / admin surface at this point. Returns the narrator prompt it checked (for fragment assertions). */
function sweep(sb: Sb, label: string): string {
  const prompts = [sb.session.getMomentPrompt({ moment: "premiere" }), sb.session.getMomentPrompt({})];
  const narrator = prompts.map((p) => JSON.stringify(p)).join("\n");
  expect(leaks(narrator), `narrator moment prompt leaks at ${label}`).toEqual([]);
  // no bare aptitude / relationship float rides along in the system prompt either
  for (const p of prompts) expect(p.systemPrompt, `bare float in prompt at ${label}`).not.toMatch(/\d\.\d{2,}/);
  const admin = JSON.stringify([sb.admin.inspect(), sb.admin.health()]);
  expect(leaks(admin), `admin / God-Mode surface leaks at ${label}`).toEqual([]);
  const player = JSON.stringify([sb.session.getGameState(), sb.session.premiereIntros(), sb.session.whereabouts()]);
  expect(leaks(player), `player-facing premiere surfaces leak at ${label}`).toEqual([]);
  return prompts[0]!.systemPrompt;
}

describe("premiere entrances + toast - the narrator prompt holds the Vault Wall at every step", () => {
  it("sweeps the moment prompt, the admin surface and the premiere views through every entrance, then every toast batch", () => {
    const sb = live(17);
    const stageOf = () => sb.session.premiereIntros()?.entrance?.stage;
    expect(stageOf(), "precondition: the entrances stage is live").toBe("entrances");

    let entranceSweeps = 0, toastSweeps = 0, sawJustArrived = false, sawToastLine = false;
    sweep(sb, "before the first arrival");
    for (let i = 0; i < 60 && stageOf() !== "done"; i++) {
      const stage = stageOf();
      const view = sb.session.getGameState();
      const p = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
      if (stage === "entrances") {
        expect(p, "the live entrances fragment is the one being swept").toContain("(1) ENTRANCES");
        if (p.includes("JUST ARRIVED")) sawJustArrived = true;
        entranceSweeps++;
      } else if (stage === "toast") {
        expect(p, "the live toast fragment is the one being swept").toContain("THE TOAST (engine truth)");
        sawToastLine = true;
        toastSweeps++;
      }
      expect(view.premiere?.entrance, "the board carries the entrance block").toBeTruthy();
      sweep(sb, `${stage} step ${i}`);
      sb.session.advanceGame();
      sweep(sb, `${stage} step ${i} (after advance)`);
    }
    sweep(sb, "done");

    expect(entranceSweeps, "swept through the whole entrances stage").toBeGreaterThanOrEqual(10);
    expect(toastSweeps, "swept through the toast stage").toBeGreaterThanOrEqual(2);
    expect(sawJustArrived, "a JUST ARRIVED line was actually swept").toBe(true);
    expect(sawToastLine).toBe(true);

    // Non-vacuity: the poison was still sitting in the hidden state at the end of the run (the sweep wasn't passing on an empty board).
    const end = JSON.stringify(sb.session.snapshot());
    expect(end).toContain(TEXT.secret);
    expect(end).toContain(TEXT.backstory);
    expect(end).toContain(TEXT.memory);
    expect(JSON.stringify(sb.engine.vault.readHidden())).toContain(TEXT.vault);
    expect(JSON.stringify(sb.engine.soul.soulOf(npc(1)))).toContain(TEXT.belief);
    expect(JSON.stringify(sb.engine.relationships.serialize().edges)).toContain("91827364");
  });
});
