import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";

/**
 * ORW-187 - the FE persists the FULL result of getGameState / whereabouts / gameStatus / createCharacter in the admin transcript. Those results must stay Vault-free projections:
 * no soul, relationship, threat or other hidden-layer KEYS in the real outputs, and the four tools stay `readsVault: false`. Roles only; no fixture names.
 */
const LEDGER_TOOLS = ["getGameState", "whereabouts", "gameStatus", "createCharacter"] as const;
const FORBIDDEN_KEY = /soul|relationship|threat|vault|suspects/i;

function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.push(k); keysOf(x, out); }
  return out;
}

describe("ORW-187 admin transcript ledger tools stay Vault-free", () => {
  it("the four tools are advertised readsVault:false", () => {
    for (const name of LEDGER_TOOLS) {
      const t = PLAYER_TOOLS.find((x) => x.name === name);
      expect(t, `${name} is a player tool`).toBeTruthy();
      expect(t!.readsVault).toBe(false);
    }
  });

  it("their REAL outputs carry no soul / relationship / threat / hidden-layer keys", () => {
    const sb = new GameSessionRegistry().sandboxFor("orw187-ledger");
    const created = sb.session.createCharacter({ playerName: "The Player", seed: 11 });
    const outputs: Record<string, unknown> = {
      createCharacter: created,
      getGameState: sb.session.getGameState(),
      whereabouts: sb.session.whereabouts(),
      gameStatus: sb.session.gameStatus(),
    };
    for (const [tool, out] of Object.entries(outputs)) {
      expect(out, `${tool} produced an output`).toBeTruthy();
      const bad = keysOf(out).filter((k) => FORBIDDEN_KEY.test(k));
      expect(bad, `${tool} leaked hidden-layer keys: ${bad.join(",")}`).toEqual([]);
    }
  });
});
