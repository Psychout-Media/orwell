import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import { PLAYER } from "../../src/domain/ids";

/**
 * AMEND 0023 #2 - the consequence loop, END TO END on the live session: the player betrays an NPC in a recorded scene; later that NPC is the HOH and the REAL nominations (the live
 * advance, not the baseline function on a reloaded model) differ from a same-seed, same-board control where no betrayal happened. Roles only.
 * Method: play a seeded game to the moment an NPC HOH is about to name nominees, snapshot the whole sandbox, then replay that SAME moment twice from the snapshot: control vs betrayed.
 */
type Reg = GameSessionRegistry;
function toNpcHohNominations(seed: number): { reg: Reg; user: string; hoh: string; snap: ReturnType<Reg["snapshot"]> } | null {
  const reg = new GameSessionRegistry(); const user = `bn${seed}`;
  const s = reg.sandboxFor(user).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  for (let i = 0; i < 800; i++) {
    const st = s.getGameState() as { phase: string; pending?: unknown; started?: boolean };
    const hoh = s.gameStatus().hoh?.id;
    if (st.phase === "nominations" && hoh && hoh !== PLAYER && !st.pending) return { reg, user, hoh, snap: reg.snapshot(user) };
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    if (v.finished) break;
  }
  return null;
}
function nomineesFrom(snap: ReturnType<Reg["snapshot"]>, user: string, betrayHoh?: string): string[] {
  const reg = new GameSessionRegistry();
  reg.restore(user, JSON.parse(JSON.stringify(snap)));
  const sb = reg.sandboxFor(user);
  if (betrayHoh) {
    for (let i = 0; i < 3; i++) sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, betrayHoh], content: "I went back on my word to them and sold them out", kind: "betrayal", toward: [betrayHoh] });
  }
  const s = sb.session as GameSessionAdapter;
  for (let i = 0; i < 6; i++) {
    const v = s.advanceGame();
    if (v.pending) {
      // the NPC HOH names nominees on its own; any player pending (comp intent etc.) resolves by default
      resolvePending(v.pending, (req) => void s.submitDecision(req));
    }
    const nominees = s.gameStatus().nominees ?? [];
    if (nominees.length === 2) return nominees.map((n) => n.id).sort();
  }
  return [];
}

describe("0023 live: a betrayal changes who the NPC HOH nominates", () => {
  it("betrayed vs same-seed control: the betrayed HOH's real nominees differ, and put the player up where the control did not", () => {
    let compared = 0, shifted = 0, playerUpBetrayed = 0, playerUpControl = 0;
    for (const seed of [3, 5, 7, 9, 11, 13, 17, 19, 23, 29]) {
      const at = toNpcHohNominations(seed); if (!at) continue;
      const control = nomineesFrom(at.snap, at.user);
      const betrayed = nomineesFrom(at.snap, at.user, at.hoh);
      if (control.length !== 2 || betrayed.length !== 2) continue;
      compared++;
      if (JSON.stringify(control) !== JSON.stringify(betrayed)) shifted++;
      if (betrayed.includes(PLAYER)) playerUpBetrayed++;
      if (control.includes(PLAYER)) playerUpControl++;
    }
    // eslint-disable-next-line no-console
    console.log(`[0023 betrayal->nominees] compared ${compared} seeds: shifted ${shifted}, player up betrayed ${playerUpBetrayed} vs control ${playerUpControl}`);
    expect(compared).toBeGreaterThanOrEqual(5);
    expect(shifted, "the betrayal changes the real nominees on at least some boards").toBeGreaterThan(0);
    expect(playerUpBetrayed, "betrayed HOHs put the player up more often than the same-seed control").toBeGreaterThan(playerUpControl);
  });
});
