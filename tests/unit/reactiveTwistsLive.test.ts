import { describe, it, expect } from "vitest";
import {
  newLiveSeason, advance, applyDecision,
  type SeasonCtx, type LiveSeasonState,
} from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { TwistKind } from "../../src/engine/reserveTwists";

// Feature 0025 (reactive redesign) — the LIVE twist mechanics: secret veto off the block, the
// battle-back juror return, and full-season format preservation. HARD rule: roles only, no names.

const ctxOf = (rel: RelationshipModel): SeasonCtx => ({
  player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel,
});

// ── Secret veto (played off the block) ───────────────────────────────────────
describe("0025 secret veto — a nominee pulls themselves off the block", () => {
  function onBlockHolding(holder: EntityId): { s: LiveSeasonState; ctx: SeasonCtx } {
    const active = [PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)];
    const s = newLiveSeason(active);
    s.beat = "eviction"; s.hoh = npc(6); s.finalNominees = [holder === npc(1) ? npc(1) : PLAYER, npc(2)];
    s.secretVeto = { holder, used: false };
    return { s, ctx: ctxOf(new RelationshipModel(0.5)) };
  }

  it("an NPC holder plays it: off the block, a replacement is named, exactly one eviction still lands", () => {
    const { s, ctx } = onBlockHolding(npc(1));
    const ev = advance(s, ctx, new SeededRandom(3))!;
    expect(ev.beat).toBe("twist-reveal");
    expect(ev.content).toMatch(/SECRET VETO/);
    expect(s.finalNominees).not.toContain(npc(1)); // holder came off the block
    expect(s.finalNominees).toContain(npc(2));      // the other nominee stays
    expect(s.finalNominees).toHaveLength(2);        // still a two-nominee block ⇒ one eviction
    expect(s.secretVeto!.used).toBe(true);
    expect((s.firedTwists ?? []).map((t) => t.kind)).toContain("secret-veto");
  });

  it("a player holder is asked — their choice to play it", () => {
    const { s, ctx } = onBlockHolding(PLAYER);
    const paused = advance(s, ctx, new SeededRandom(3));
    expect(paused).toBeNull();
    expect(s.pending?.kind).toBe("secret-veto");
    const played = applyDecision(s, { kind: "secret-veto", use: true }, ctx, new SeededRandom(3));
    expect(played.content).toMatch(/SECRET VETO/);
    expect(s.finalNominees).not.toContain(PLAYER);
    expect(s.secretVeto!.used).toBe(true);
  });

  it("a player holder may HOLD it — not consumed, the eviction proceeds, not re-offered this week", () => {
    const { s, ctx } = onBlockHolding(PLAYER);
    advance(s, ctx, new SeededRandom(3)); // raises the pending
    applyDecision(s, { kind: "secret-veto", use: false }, ctx, new SeededRandom(3));
    expect(s.secretVeto!.used).toBe(false);          // still holds it
    expect(s.secretVeto!.declinedWeek).toBe(s.week);  // but not re-offered this week
    expect(s.beat).toBe("eviction");
    const next = advance(s, ctx, new SeededRandom(3)); // proceeds to the vote, no re-prompt
    expect(s.pending?.kind).not.toBe("secret-veto");
    expect(next).not.toBeNull();
  });
});

// ── Battle-back (a juror re-enters) ───────────────────────────────────────────
describe("0025 battle-back — an evicted juror re-enters the game", () => {
  it("the winner moves from the eviction record back into the active house", () => {
    const s = newLiveSeason([PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5)]);
    s.beat = "battle-back";
    s.evictionOrder = [npc(20), npc(21), npc(22)]; // recent jurors
    const before = s.active.length;
    const ev = advance(s, ctxOf(new RelationshipModel(0.5)), new SeededRandom(9))!;
    expect(ev.beat).toBe("twist-reveal");
    expect(ev.content).toMatch(/BATTLE-BACK/);
    expect(s.active.length).toBe(before + 1);             // one re-entered
    expect(s.evictionOrder).toHaveLength(2);              // and left the eviction record
    const returned = s.active.find((a) => [npc(20), npc(21), npc(22)].includes(a))!;
    expect(returned).toBeDefined();
    expect(s.evictionOrder).not.toContain(returned);      // the voided eviction is gone
    expect(s.beat).toBe("hoh-competition");               // the returning week's comp opens
    expect((s.firedTwists ?? []).map((t) => t.kind)).toContain("battle-back");
  });
});

// ── All three can coexist in one season (each at most once) ───────────────────
describe("0025 battle-back — a returning PLAYER stops being a spectator", () => {
  it("a pre-jury evictee who chose to watch is an active player again after winning the battle-back (not fast-forwarded)", () => {
    let proved = false;
    for (let seed = 1; seed <= 200 && !proved; seed++) {
      const s = newLiveSeason([npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)]);
      s.beat = "battle-back";
      s.evictionOrder = [npc(20), PLAYER, npc(21), npc(22)];
      s.spectator = { mode: "watch", sinceWeek: 2 };
      advance(s, ctxOf(new RelationshipModel(0.5)), new SeededRandom(seed));
      if (!s.active.includes(PLAYER)) {
        expect(s.spectator, "a losing player is still a spectator").toBeDefined();
        continue;
      }
      proved = true;
      expect(s.spectator, "the returning player is not a spectator any more").toBeUndefined();
      expect(s.evictionOrder).not.toContain(PLAYER);
    }
    expect(proved, "some seed has the player win the battle-back").toBe(true);
  });
});

describe("0025 — all three twists can fire in one season, each once", () => {
  it("firedTwists accumulates the three distinct kinds without duplication", () => {
    // Fire each mechanic in turn on one live state and confirm the ledger holds all three, once each.
    const s = newLiveSeason([PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)]);
    const ctx = ctxOf(new RelationshipModel(0.5));
    // battle-back
    s.beat = "battle-back"; s.evictionOrder = [npc(20), npc(21)];
    advance(s, ctx, new SeededRandom(1));
    // secret veto
    s.beat = "eviction"; s.hoh = npc(6); s.finalNominees = [npc(1), npc(2)];
    s.secretVeto = { holder: npc(1), used: false };
    advance(s, ctx, new SeededRandom(1));
    // double eviction (its fire is bookkept when the running night completes)
    (s.firedTwists ??= []).push({ kind: "double-eviction", beat: s.week });
    const kinds = (s.firedTwists ?? []).map((t) => t.kind);
    expect(new Set(kinds)).toEqual(new Set<TwistKind>(["battle-back", "secret-veto", "double-eviction"]));
    expect(kinds).toHaveLength(3); // each exactly once
  });
});

// ── Full-season format preservation, live through the adapter ─────────────────
function resolveLive(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): AdvanceView {
  const submit = (req: SubmitDecisionReq): AdvanceView => s.submitDecision(req);
  switch (p.kind) {
    case "nominations": return submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
    case "veto-decision": return submit({ kind: "veto-decision", use: false });
    case "comp-intent": return submit({ kind: "comp-intent", intent: "compete" });
    case "comp-round": return submit({ kind: "comp-round", intent: "compete" });
    case "houseguests-choice": return submit({ kind: "houseguests-choice", vote: p.options[0]!.id });
    case "replacement": return submit({ kind: "replacement", replacement: p.options[0]!.id });
    case "secret-veto": return submit({ kind: "secret-veto", use: true });
    case "goodbye-message": return submit({ kind: "goodbye-message", vote: (p as { options: { id: string }[] }).options[0]!.id });
    case "finale-statement": return submit({ kind: "finale-statement", statement: "x" });
    case "finale-answer": return submit({ kind: "finale-answer", appeal: (p as { appeals: string[] }).appeals![0]! });
    case "juror-question": return submit({ kind: "juror-question", statement: "x" });
    case "final-eviction": return submit({ kind: "final-eviction", vote: p.options[0]!.id });
    default: return submit({ kind: p.kind, vote: p.options[0]!.id });
  }
}

function playFullSeason(seed: number, forcedPlan?: object): { firedKinds: TwistKind[]; jury: number; finalTwo: number; finished: boolean } {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`rt-${seed}-${forcedPlan ? "f" : "n"}`);
  sb.session.setReactiveTwistsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  if (forcedPlan) {
    const core = sb.session.snapshot();
    (core.live as unknown as { twistPlan: object }).twistPlan = forcedPlan;
    sb.session.restore(core);
  }
  for (let i = 0; i < 6000; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) resolveLive(sb.session, v.pending);
    if (v.finished) break;
  }
  const core = sb.session.snapshot();
  return {
    firedKinds: (core.live?.firedTwists ?? []).map((t) => t.kind),
    jury: core.live?.jury?.length ?? -1,
    finalTwo: core.live?.finalTwo?.length ?? -1,
    finished: !!core.live?.finished,
  };
}

describe("0025 reactive twists — full-season format preservation (live)", () => {
  it("a forced battle-back season still closes at a jury of nine and a Final 2", () => {
    const r = playFullSeason(4, {
      doubleEvictionAtActive: 8, doubleEvictionArmed: false,
      secretVetoStreak: 2, secretVetoArmed: false,
      battleBackAtJury: 1, battleBackArmed: true,
    });
    expect(r.finished).toBe(true);
    expect(r.firedKinds).toContain("battle-back"); // it fired
    expect(r.jury).toBe(9);                         // yet the jury still closes at nine
    expect(r.finalTwo).toBe(2);
  });

  it("across seeds the game always completes at jury-9 / final-2, no twist fires twice", () => {
    const unionKinds = new Set<TwistKind>();
    for (const seed of [1, 2, 3, 5, 6, 7, 8, 11]) {
      const r = playFullSeason(seed);
      expect(r.finished).toBe(true);
      expect(r.jury).toBe(9);
      expect(r.finalTwo).toBe(2);
      // each kind at most once per season
      const counts = r.firedKinds.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
      for (const n of Object.values(counts)) expect(n).toBeLessThanOrEqual(1);
      r.firedKinds.forEach((k) => unionKinds.add(k));
    }
    // The pool genuinely produces variety across seasons (more than one twist kind fires somewhere).
    expect(unionKinds.size).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic — the same seed fires the same twists", () => {
    expect(playFullSeason(6).firedKinds).toEqual(playFullSeason(6).firedKinds);
  });
});
