import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * Watch list item 12 (ORW-106): with information-spreads-by-co-presence ON (ORWELL_GOSSIP_COPRESENCE, the flip),
 * the once-per-in-game-day confessional sweep at day close (0122) STILL fires: most living houseguests confess each
 * day, every confessional stays Vault-only, and the sweep does not collapse into nothing. 0122 originally failed with
 * this flag on; the flag is set EXPLICITLY here so the test keeps proving it whatever the code default becomes.
 * Roles only.
 */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

type Sandbox = ReturnType<GameSessionRegistry["sandboxFor"]>;

function harness(opts: { gossipOn: boolean; seed: number; user: string }) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(opts.user);
  sb.session.createCharacter({ playerName: "The Player", seed: opts.seed });
  (sb.session as GameSessionAdapter).setCopresenceEnabled(opts.gossipOn);
  sb.session.setPerConversationClockEnabled(true);
  sb.session.setConfessionalDepthEnabled(true);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: opts.seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  return { reg, sb };
}

const confessionals = (sb: Sandbox) => sb.engine.events.queryAll().filter((e) => e.type === "confessional");

/** Drive a live season a while so relationships develop and there is something to confess about. */
function developHouse(sb: Sandbox): void {
  for (let i = 0; i < 90; i++) {
    if (sb.session.snapshot().live?.hoh === undefined) {
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
      if (a.finished) return;
    } else {
      const npcId = sb.session.livingIds().find((id) => id !== PLAYER)!;
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npcId], content: `talk ${i}` });
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
      if (a.finished) return;
    }
    if (i > 40 && sb.session.snapshot().live?.hoh !== undefined) return;
  }
}

describe("co-presence gossip ON: the 0122 day-close confessional sweep still fires", () => {
  for (const seed of [7, 11]) {
    it(`seed ${seed}: a turnIn records a confessional for a majority of the living NPCs, all Vault-only`, () => {
      const { sb } = harness({ gossipOn: true, seed, user: `gossip-day-close-${seed}` });
      expect((sb.session as GameSessionAdapter).copresenceEnabledNow(), "the flag under test is really on").toBe(true);
      developHouse(sb);

      const livingNpcs = sb.session.livingIds().filter((id) => id !== PLAYER).length;
      const before = confessionals(sb).length;
      sb.session.turnIn();
      const swept = confessionals(sb).length - before;

      expect(swept, `day close confessed ${swept} of ${livingNpcs} living NPCs with gossip ON`).toBeGreaterThanOrEqual(
        Math.ceil(livingNpcs / 2),
      );
      for (const e of confessionals(sb).slice(before)) {
        expect(e.hidden).toBe(true);
        expect(e.witnessSet).toEqual([e.initiator]);
        expect(e.witnessSet.includes(PLAYER)).toBe(false);
      }
    });
  }

  it("the sweep is not the only thing that changed: ON and OFF both confess, so ON loses nothing", () => {
    const on = harness({ gossipOn: true, seed: 7, user: "gossip-day-close-on" });
    const off = harness({ gossipOn: false, seed: 7, user: "gossip-day-close-off" });
    developHouse(on.sb);
    developHouse(off.sb);
    const b1 = confessionals(on.sb).length;
    const b2 = confessionals(off.sb).length;
    on.sb.session.turnIn();
    off.sb.session.turnIn();
    const sweptOn = confessionals(on.sb).length - b1;
    const sweptOff = confessionals(off.sb).length - b2;
    expect(sweptOff, "control: the OFF game confesses at day close").toBeGreaterThan(0);
    // The two games can differ (gossip changes what happened), but gossip must not shrink the sweep to a fraction of the control.
    expect(sweptOn).toBeGreaterThanOrEqual(Math.floor(sweptOff / 2));
  });
});
