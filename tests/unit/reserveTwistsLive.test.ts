import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The LEGACY pre-scheduled twist path (reserve schedule + the `reserveTwists` count knob): reactive twists are ON by default now (PO ruling 2026-11-03),
// so these legacy-path gates pin the legacy path explicitly. The reactive path has its own gates (reactiveTwistsLive / reactiveTwistsGuard).
beforeEach(() => { vi.stubEnv("ORWELL_REACTIVE_TWISTS", "0"); });
afterEach(() => { vi.unstubAllEnvs(); });
import { GameSessionRegistry } from "../../src/composition/registry";
import { loadReserveTwists } from "../../src/engine/reserveTwists";
import { hashSeed } from "../../src/engine/characterFactory";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * B53 — reserve twists in the LIVE game (0025): the schedule is sealed at createCharacter,
 * the Vault audit copy persists across a restart (audit I7), and nothing pre-reveal leaks.
 * Roles only — no fixture names.
 */
describe("legacy (flag off) — live reserve twists (B53)", () => {
  /** A seed whose loaded reserve includes a double eviction (deterministic — found once, pinned). */
  const seedWithTwist = (): number => {
    for (let s = 1; s < 200; s++) {
      const loaded = loadReserveTwists(2, new SeededRandom(hashSeed(`${s}:twists`)));
      if (loaded.some((t) => t.kind === "double-eviction")) return s;
    }
    throw new Error("no twist-bearing seed in range");
  };

  it("createCharacter seals the loaded schedule into the Vault (audit copy)", () => {
    const seed = seedWithTwist();
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("twist-seal");
    sb.session.createCharacter({ playerName: "The Player", seed });
    const sealed = sb.engine.vault.readHidden({ kind: "reserved-twist" });
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.some((r) => r.content.includes("double-eviction"))).toBe(true);
    // The loop state carries the same schedule (engine-only, persisted with the season).
    expect(sb.session.snapshot().live!.reserve!.some((t) => t.kind === "double-eviction")).toBe(true);
  });

  it("the Vault survives a snapshot/restore round-trip (audit I7)", () => {
    const seed = seedWithTwist();
    const reg = new GameSessionRegistry();
    const user = "twist-restart";
    reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed });
    const before = reg.sandboxFor(user).engine.vault.readHidden();
    expect(before.length).toBeGreaterThan(0);

    const snap = reg.snapshot(user);
    const reg2 = new GameSessionRegistry();
    reg2.restore(user, snap);
    expect(reg2.sandboxFor(user).engine.vault.readHidden()).toEqual(before);
  });

  it("a sealed, unfired twist never reaches a player or admin projection", () => {
    const seed = seedWithTwist();
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("twist-sealed-sweep");
    sb.session.createCharacter({ playerName: "The Player", seed });
    const sweep = JSON.stringify(sb.session.getGameState())
      + JSON.stringify(sb.session.gameStatus())
      + JSON.stringify(sb.session.advanceGame())
      + JSON.stringify(sb.player.getVisibleState())
      + JSON.stringify(sb.admin.inspect());
    expect(sweep).not.toContain("double-eviction");
    expect(sweep).not.toContain("reserved-twist");
    expect(/twist/i.test(sweep)).toBe(false); // no "a twist is pending" tell of any kind
  });

  it("a game with no loaded twists plays exactly as before (often none — rare by construction)", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("twist-none");
    sb.session.setTwistCount(0);
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    expect(sb.session.snapshot().live!.reserve).toBeUndefined();
    expect(sb.engine.vault.readHidden({ kind: "reserved-twist" })).toEqual([]);
  });
});
