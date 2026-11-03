import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSystemPrompt, BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";

/**
 * `playerDossier` / `playerReceipts` are flag-gated engine reads (ORWELL_PLAYER_DOSSIER / ORWELL_BOOTH_RECEIPTS): with
 * the flag OFF the tool returns an empty result — a DEAD tool. The narrator prompt used to advertise both
 * unconditionally, so a flag-off game had the model reaching for a lever that can only return nothing. The glossary
 * bullets now follow the flags (default ON ⇒ byte-identical prompt). Roles only.
 */
const RECEIPTS = "playerReceipts — the Diary-Room screening room";
const DOSSIER = "playerDossier — the player's own Diary-Room reads";

function game() {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", seed: 3 });
  s.setBoothReceiptsEnabled(true);   // deterministic: never inherit ORWELL_FLAGS_OFF / an explicit =0 from the environment
  s.setPlayerDossierEnabled(true);
  return s;
}
const prompt = (s: GameSessionAdapter) => s.getMomentPrompt({}).systemPrompt;

describe("diary tools follow their feature flags", () => {
  it("default (both flags ON): both are advertised and the base prompt is unchanged", () => {
    const p = prompt(game());
    expect(p).toContain(RECEIPTS);
    expect(p).toContain(DOSSIER);
    expect(BASE_GAME_MASTER_PROMPT).toContain(RECEIPTS);
    expect(BASE_GAME_MASTER_PROMPT).toContain(DOSSIER);
  });

  it("receipts OFF: the receipts bullet is gone, the dossier stays", () => {
    const s = game(); s.setBoothReceiptsEnabled(false);
    const p = prompt(s);
    expect(p).not.toContain(RECEIPTS);
    expect(p).not.toContain("playerReceipts");
    expect(p).toContain(DOSSIER);
  });

  it("dossier OFF: the dossier bullet is gone, the receipts stay; the tool returns nothing too", () => {
    const s = game();
    s.setPlayerKnowledgeReader(() => [{ id: "k1", content: "my read on them", subject: "npc:1", pathway: "diary-room" }] as never);
    expect(Object.keys(s.playerDossier()).length, "precondition: the dossier has content while the flag is ON").toBeGreaterThan(0);
    s.setPlayerDossierEnabled(false);
    const p = prompt(s);
    expect(p).not.toContain(DOSSIER);
    expect(p).not.toContain("playerDossier");
    expect(p).toContain(RECEIPTS);
    expect(s.playerDossier()).toEqual({});
    expect(s.getGameState().playerDossier).toBeUndefined();
  });

  it("both OFF: neither is mentioned, and the surrounding glossary is intact (renderScene still follows)", () => {
    const s = game(); s.setBoothReceiptsEnabled(false); s.setPlayerDossierEnabled(false);
    const p = prompt(s);
    expect(p).not.toMatch(/playerReceipts|playerDossier/);
    expect(p).toContain("renderScene — narrate the current moment");
    expect(p).toContain("askProducers — answer a direct producer question");
  });

  it("buildSystemPrompt takes the flags directly (the pure seam), and omitting them is the default-on prompt", () => {
    const view = game().getGameState();
    const on = buildSystemPrompt("default", view);
    expect(on).toBe(buildSystemPrompt("default", view, undefined, undefined, undefined, undefined, { playerDossier: true, boothReceipts: true }));
    expect(on).toContain(RECEIPTS);
    const off = buildSystemPrompt("default", view, undefined, undefined, undefined, undefined, { playerDossier: false, boothReceipts: false });
    expect(off).not.toMatch(/playerReceipts|playerDossier/);
    expect(off.length).toBeLessThan(on.length);
  });
});
