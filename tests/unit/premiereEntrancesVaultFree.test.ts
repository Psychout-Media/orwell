import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";

/** A9 - the entrance/toast surfaces are Vault-free (live sentinel). Roles only. */
describe("A9 entrances are Vault-free", () => {
  it("a hidden string planted in a houseguest's Vault facets never reaches any entrance/toast output", () => {
    const sb = new GameSessionRegistry().sandboxFor("pe-vault");
    sb.session.setPremiereEntrancesEnabled(true);
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    const SENTINEL = "ZZ-VAULT-SENTINEL-9317";
    const house = (sb.session as unknown as { house: { npcs: Array<{ character: Record<string, unknown> }> } }).house;
    for (const n of house.npcs) {
      const c = n.character;
      const he = (c.hiddenElements as unknown[] | undefined) ?? [];
      he.push({ kind: "secret", detail: SENTINEL, hidden: SENTINEL });
      c.hiddenElements = he;
      c.secrets = [SENTINEL];
    }
    const outputs: string[] = [JSON.stringify(sb.session.premiereIntros()), JSON.stringify(sb.session.whereabouts())];
    for (let i = 0; i < 40 && sb.session.premiereIntros()?.entrance?.stage !== "done"; i++) {
      const v = sb.session.advanceGame();
      outputs.push(JSON.stringify(v), JSON.stringify(sb.session.premiereIntros()), JSON.stringify(sb.session.whereabouts()));
    }
    for (const t of ["premiere-entrance", "toast-speech"]) {
      for (const e of sb.engine.events.query({ type: t })) outputs.push(e.content);
    }
    expect(outputs.join("\n")).not.toContain(SENTINEL);
  });
});
