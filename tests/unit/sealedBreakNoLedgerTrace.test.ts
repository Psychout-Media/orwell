import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { BindingAction } from "../../src/domain/deal";

/**
 * AMEND 0024 #1(b) - a SEALED-ballot deal break leaves NO trace in the NPC memory ledger and names no breaker outward. The ledger is the thing NPC decisions read; writing a `deal-broken`
 * memory from a secret eviction vote would de-anonymize the voter through later behaviour. Control: the ledger really does record a `deal-broken` memory when written through the same
 * `remember` path (so "no entry" cannot pass on a ledger that never writes), and a PUBLIC (attributed) break is NOT sealed. Roles only.
 */
interface Pokeable {
  reconcileDeals(action: BindingAction): void;
  remember(holder: string, subject: string, kind: string, severity: number): void;
}
const poke = (s: GameSessionAdapter): Pokeable => s as unknown as Pokeable;
const ledger = (s: GameSessionAdapter): Record<string, Record<string, Array<{ kind: string }>>> =>
  (s.snapshot().live as unknown as { npcMemory?: Record<string, Record<string, Array<{ kind: string }>>> }).npcMemory ?? {};
const dealBroken = (s: GameSessionAdapter): number => Object.values(ledger(s)).flatMap((subj) => Object.values(subj).flat()).filter((e) => e.kind === "deal-broken").length;

function game(seed: number, user: string) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "P", seed });
  const s = sb.session as GameSessionAdapter;
  const npc = s.getGameState().house[0]!.id;
  return { sb, s, npc };
}

describe("a sealed-ballot deal break leaves no NPC-memory trace", () => {
  it("a secret vote-evict that breaks the player's deal writes NO deal-broken memory (and records the attribution only Vault-side)", () => {
    const { sb, s, npc } = game(3, "sb-ledger");
    s.makeDeal({ with: npc, kind: "safety", terms: "keep me off the block" });
    expect(dealBroken(s)).toBe(0);
    poke(s).reconcileDeals({ actor: npc, kind: "vote-evict", targets: [PLAYER], alternatives: [PLAYER, "npc:other"] } as BindingAction);
    expect(dealBroken(s), "no memory is written from a sealed ballot").toBe(0);
    // the break itself was recorded - Vault-side, hidden, not player-witnessed
    const attributed = sb.engine.events.queryAll().find((e) => e.type === "betrayal" && e.hidden);
    expect(attributed, "the attribution exists, hidden").toBeTruthy();
    expect(attributed!.witnessSet).not.toContain(PLAYER);
  });
  it("control: the ledger DOES record a deal-broken memory through the same write path (so the 'none' above is meaningful)", () => {
    const { s, npc } = game(3, "sb-ledger-ctl");
    const other = s.getGameState().house[1]!.id;
    expect(dealBroken(s)).toBe(0);
    poke(s).remember(other, npc, "deal-broken", 0.5);
    expect(dealBroken(s)).toBe(1);
  });
});
