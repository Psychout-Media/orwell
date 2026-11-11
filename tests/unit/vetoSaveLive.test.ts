import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, DealView, GameSession } from "../../src/ports/GameSession";

/**
 * ORW-83 / 0121 - veto-save resolves LIVE at the real veto ceremony (the ledger-level cases live in dealDepth.test.ts).
 * Drives seeded seasons through the engine (no model) and strikes a veto-save deal once the veto holder is known and the
 * ceremony has not yet run, in BOTH directions now that B55 (#2187) made the proposer's direction decide who promises:
 *   offer - the PLAYER holds the veto and promised to save a nominated houseguest: kept iff they use it, broken iff they leave them on the block;
 *   ask   - an NPC veto holder promised to save the (nominated) player: kept iff the veto actually pulled the player down, else broken;
 *   no duty - the promisee is not on the block at the ceremony: the deal is never judged at that ceremony.
 * Roles only. The scenario seeds are found by scanning, so the assertions never depend on which seed gives which holder.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

type Live = { vetoHolder?: string; nominees?: string[]; saved?: string; beat?: string; replacement?: string };
const liveOf = (s: GameSession): Live => ((s as unknown as GameSessionAdapter).snapshot() as unknown as { live: Live }).live ?? {};

function resolve(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>, useVeto: boolean, prefer: string): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: useVeto, ...(useVeto ? { save: p.options.some((o) => o.id === prefer) ? prefer : p.options[0]!.id } : {}) } as never);
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

type Scenario = "offer" | "ask" | "no-duty";
interface Outcome { status: string; saved: string | undefined; protect: string; onBlock: string[]; }

/** Play one seed; strike the veto-save deal when the scenario fits the board; return the verdict at the ceremony, or null if this seed does not fit. */
function play(seed: number, scenario: Scenario, useVeto: boolean): Outcome | null {
  const sb = new GameSessionRegistry().sandboxFor(`vs-${scenario}-${seed}-${useVeto}`);
  const s = sb.session;
  s.createCharacter({ playerName: "The Player", seed });
  s.setNpcDealConsentEnabled(false); // mechanics, not consent
  s.setDealDepthEnabled(true);
  let deal: DealView | null = null, protect = "";
  for (let i = 0; i < 400; i++) {
    const live = liveOf(s);
    if (!deal && live.vetoHolder && live.beat === "veto-ceremony" && live.nominees && live.saved === undefined) {
      const holder = live.vetoHolder, block = [...live.nominees];
      const npcsOnBlock = block.filter((n) => n !== PLAYER);
      if (scenario === "offer" && holder === PLAYER && npcsOnBlock.length > 0) {
        protect = npcsOnBlock[0]!;
        deal = s.makeDeal({ with: protect, kind: "veto-save", terms: "I will use the veto on you", direction: "offer" }) as DealView | null;
      } else if (scenario === "ask" && holder !== PLAYER && block.includes(PLAYER) && !block.includes(holder)) {
        protect = PLAYER;
        deal = s.makeDeal({ with: holder, kind: "veto-save", terms: "use the veto on me", direction: "ask" }) as DealView | null;
      } else if (scenario === "no-duty" && holder === PLAYER) {
        const off = s.livingIds().find((id) => id !== PLAYER && !block.includes(id));
        if (off) { protect = off; deal = s.makeDeal({ with: off, kind: "veto-save", terms: "I will use the veto on you", direction: "offer" }) as DealView | null; }
      }
      if (!deal) return null;
    }
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending, useVeto, protect);
    if (deal) {
      const d = s.getGameState().deals?.find((x) => x.id === deal!.id);
      const l = liveOf(s);
      // judged at the ceremony: the deal left "open", or the ceremony has passed
      if (d && (d.status !== "open" || l.beat !== "veto-ceremony")) return { status: d.status, saved: l.saved, protect, onBlock: l.nominees ?? [] };
    }
    if (v.finished) break;
  }
  return null;
}

function find(scenario: Scenario, useVeto: boolean): Outcome {
  for (let seed = 1; seed <= 300; seed++) {
    const o = play(seed, scenario, useVeto);
    if (o) return o;
  }
  throw new Error(`no seed in 1..300 produced a ${scenario} board`);
}

describe("0121 / B55 - veto-save is judged live at the veto ceremony", () => {
  it("offer: the player holds the veto and USES it on the promisee - kept", () => {
    const o = find("offer", true);
    expect(o.status).toBe("kept");
    expect(o.saved).toBe(o.protect);
  });
  it("offer: the player holds the veto and leaves the promisee on the block - broken", () => {
    const o = find("offer", false);
    expect(o.status).toBe("broken");
    expect(o.saved).toBeUndefined();
  });
  it("ask: an NPC holder who promised to save the player is judged by whether the veto actually pulled the player down", () => {
    const o = find("ask", true);
    if (o.saved === PLAYER) expect(o.status).toBe("kept");
    else expect(o.status).toBe("broken");
    expect(["kept", "broken"]).toContain(o.status); // never left open at the ceremony
  });
  it("no duty: the promisee was never nominated - the ceremony does not judge the deal either way", () => {
    for (const useVeto of [true, false]) {
      const o = find("no-duty", useVeto);
      expect(o.onBlock).not.toContain(o.protect);
      expect(o.status, `use=${useVeto}`).toBe("open");
    }
  });
});
