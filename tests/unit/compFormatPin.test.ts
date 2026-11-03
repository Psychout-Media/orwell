import { describe, it, expect } from "vitest";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import type { Stats } from "../../src/engine/season";
import {
  newLiveSeason, advance, applyDecision, validateCompetitionFiction, competitionPresentation,
  type LiveSeasonState, type SeasonCtx, type CompetitionPresentation,
} from "../../src/engine/liveSeason";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * L-F4 (#1743) — the comp presentation (format + premise) is PINNED across a competition's rounds.
 *
 * The engine decides the winner (`runCompetition`); the comp's PRESENTATION was model-authored and was
 * NOT held stable turn to turn — the Week-1 HOH comp narrated as "Piece by Piece" (a puzzle) on one beat
 * and "Center-Ring Trivia" (a quiz) the next, a full FORMAT flip-flop within one event. This proves the
 * fix: `competitionPresentation` — the single engine-side pin the ground truth surfaces on EVERY comp
 * beat — reports the SAME format + premise on the first reveal AND on every staged elimination round,
 * so the narrator can never re-author "what kind of comp this is". HARD rule: roles only — no names.
 */

/** A seeded house: balanced stats + a seeded relationship graph (mirrors stagedTrajectoryNeutral). */
function buildHouse(size: number, seed: number): { active: EntityId[]; ctx: SeasonCtx } {
  const rng = new SeededRandom(seed);
  const active: EntityId[] = [PLAYER, ...Array.from({ length: size - 1 }, (_, i) => npc(i + 1))];
  const stats = new Map<EntityId, Stats>();
  for (const id of active) stats.set(id, { physical: rng.next(), mental: rng.next(), social: rng.next() });
  const rel = new RelationshipModel(0.5);
  for (const a of active) for (const b of active) {
    if (a === b) continue;
    const e = rel.edge(a, b);
    e.trust = rng.next(); e.affinity = rng.next(); e.threat = rng.next(); e.confidence = 0.5;
  }
  return { active, ctx: { player: PLAYER, statsOf: (id) => stats.get(id)!, rel } };
}

/**
 * Drive the live season, capturing the pinned presentation of the FIRST staged competition — every beat
 * from the moment it stages (winner + drop order fixed) through its crown. Answers each `comp-round`
 * pending "compete" so the staged reveals play out. Stops once that first comp has crowned.
 */
function presentationsAcrossFirstComp(
  active: EntityId[], ctx: SeasonCtx, seed: number,
): { comp: "hoh-competition" | "veto-competition"; seen: CompetitionPresentation[] } {
  const s: LiveSeasonState = newLiveSeason(active);
  const rng = new SeededRandom(seed);
  const seen: CompetitionPresentation[] = [];
  let compKind: "hoh-competition" | "veto-competition" | undefined;
  let sawStaged = false;
  for (let guard = 0; guard < 5_000 && !s.finished; guard++) {
    if (s.pending) {
      const p = s.pending;
      if (p.kind === "comp-round" || p.kind === "comp-intent") applyDecision(s, { kind: p.kind, intent: "compete" }, ctx, rng);
      else if (p.kind === "nominations") applyDecision(s, { kind: "nominations", choice: [p.options[0]!, p.options[1]!] }, ctx);
      else if (p.kind === "veto-decision") applyDecision(s, { kind: "veto-decision", use: false }, ctx);
      else if (p.kind === "houseguests-choice") applyDecision(s, { kind: "houseguests-choice", pick: p.options[0]! }, ctx, rng);
      else break; // reached beyond the first comp's ceremonies — nothing more to capture
    } else {
      advance(s, ctx, rng);
    }
    // Capture the pin whenever a STAGED comp is live (winner + drop order fixed) — the beats the finding
    // spans. `competitionPresentation` is null before the comp stages (the HOH def isn't drawn yet).
    if (s.competition) {
      const pin = competitionPresentation(s);
      if (pin) {
        compKind ??= pin.comp;
        if (pin.comp === compKind) { seen.push(pin); sawStaged = true; }
      }
    } else if (sawStaged) {
      break; // the first staged comp has crowned — we have its whole run
    }
  }
  return { comp: compKind!, seen };
}

describe("L-F4 (#1743) — the comp format/premise is pinned across a competition's rounds", () => {
  for (const [size, seed] of [[12, 7], [12, 42], [8, 3], [16, 1]] as const) {
    it(`size ${size}, seed ${seed}: format + premise are stable and present on every comp beat`, () => {
      const h = buildHouse(size, seed);
      const { seen } = presentationsAcrossFirstComp(h.active, h.ctx, seed);

      // The comp genuinely staged into MULTIPLE beats (the finding is a turn-TO-turn flip, so we must
      // have seen it re-surface at least twice).
      expect(seen.length, "the staged comp must surface across multiple beats").toBeGreaterThanOrEqual(2);

      // Every beat carries a NON-EMPTY format + premise (the pin is present, not just consistent).
      for (const p of seen) {
        expect(p.format, "each comp beat must carry a format").toBeTruthy();
        expect(p.premise.trim().length, "each comp beat must carry a premise").toBeGreaterThan(0);
      }

      // THE LITMUS: the format + premise are BYTE-IDENTICAL across every beat of the one competition —
      // no re-authoring "what kind of comp this is" turn to turn.
      const formats = new Set(seen.map((p) => p.format));
      const premises = new Set(seen.map((p) => p.premise));
      expect(formats.size, "the format must not flip-flop across the comp's rounds").toBe(1);
      expect(premises.size, "the premise must not flip-flop across the comp's rounds").toBe(1);
    });
  }

  /** Drive to a RESOLVED staged HOH comp (winner + drop order fixed) so a fiction write-back is legal. */
  function resolvedStagedHoh(seed: number): { s: LiveSeasonState; ctx: SeasonCtx } {
    const h = buildHouse(12, seed);
    const s: LiveSeasonState = newLiveSeason(h.active);
    const rng = new SeededRandom(seed);
    for (let guard = 0; guard < 200 && !(s.competition && s.competition.winner !== undefined && s.competition.dropOrder); guard++) {
      if (s.pending?.kind === "comp-round" || s.pending?.kind === "comp-intent") {
        applyDecision(s, { kind: s.pending.kind, intent: "compete" }, h.ctx, rng);
      } else if (!s.pending) {
        advance(s, h.ctx, rng);
      } else break;
    }
    expect(s.competition?.winner, "the comp must have resolved for this test").toBeDefined();
    return { s, ctx: h.ctx };
  }

  it("LATE fiction (authored AFTER staging began) does NOT re-skin the active comp's name/premise; format stays the library format", () => {
    const { s } = resolvedStagedHoh(5);
    const c = s.competition!;
    // The comp staged with no fiction ⇒ the source is FROZEN to the seeded/library floor at draw.
    expect(c.themeAuthored, "the source is pinned to the theme at draw (no fiction present)").toBe(false);
    const floor = competitionPresentation(s)!;
    const floorPremise = floor.premise;
    const floorName = floor.name;
    const pinnedFormat = floor.format;

    // A LATE first-fiction write-back arrives (the #1400 flow — the model always dresses a decided result).
    const authored = {
      comp: c.comp, week: s.week, theme: "A Model-Invented Theme",
      premise: "a wholly different, model-authored premise",
      eliminations: c.dropOrder!.map((id) => ({ id, fiction: `${id} goes out` })),
    };
    const v = validateCompetitionFiction(s, authored);
    expect(v.ok, "the drop-order-matched fiction must validate + STORE (its per-drop lines ride comp-elimination)").toBe(true);
    if (v.ok) s.competitionFiction = v.fiction;
    expect(s.competitionFiction, "the fiction IS stored (not dropped) — only the name/premise pin ignores it").toBeDefined();

    // THE P1 GUARD: the active comp's pinned presentation is UNCHANGED — the late fiction never re-skins it.
    const after = competitionPresentation(s)!;
    expect(after.premise, "the pinned premise must not flip to the late authored premise").toBe(floorPremise);
    expect(after.name, "the pinned name must not flip mid-comp").toBe(floorName);
    expect(after.authored, "the frozen source stays 'theme' despite the late fiction").toBe(false);
    // The FORMAT is the HARD pin: always the drawn library format, never model-overridable.
    expect(after.format, "the format is never overridable by authored fiction").toBe(pinnedFormat);

    // The stored fiction is still IMMUTABLE — a second author attempt is REJECTED (already-authored).
    const second = validateCompetitionFiction(s, { ...authored, premise: "yet another premise" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already-authored");
  });

  it("fiction PRESENT at draw stays the source (frozen authored) — the authored premise IS the pin, format still the library format", () => {
    const { s } = resolvedStagedHoh(5);
    const c = s.competition!;
    const libraryFormat = competitionPresentation(s)!.format;

    // Author fiction, then model a comp whose fiction predated the save (a reload): the source freeze
    // captured it as authored. This exercises the reviewer's "if fiction was present at draw, it stays
    // the source" branch — the frozen decision is honored consistently for the comp's whole duration.
    const v = validateCompetitionFiction(s, {
      comp: c.comp, week: s.week, theme: "A Draw-Time Theme", premise: "the premise pinned at draw",
      eliminations: c.dropOrder!.map((id) => ({ id, fiction: `${id} goes out` })),
    });
    expect(v.ok).toBe(true);
    if (v.ok) s.competitionFiction = v.fiction;
    c.themeAuthored = true; // frozen 'authored' (fiction was present when the comp staged)

    const pin = competitionPresentation(s)!;
    expect(pin.authored, "a draw-time-authored comp reports the authored source").toBe(true);
    expect(pin.premise, "the authored premise IS the pinned presentation").toBe("the premise pinned at draw");
    expect(pin.name).toBe("A Draw-Time Theme");
    expect(pin.format, "the format is still the drawn library format").toBe(libraryFormat);
  });

  it("no pin before a def is drawn (the HOH comp before it stages), and off a comp beat", () => {
    const h = buildHouse(8, 2);
    const s: LiveSeasonState = newLiveSeason(h.active);
    const rng = new SeededRandom(2);
    // First advance surfaces the HOH comp-round pending — the def is NOT drawn until it resolves.
    advance(s, h.ctx, rng);
    expect(s.pending?.kind, "the HOH comp-round is pending").toBe("comp-round");
    expect(competitionPresentation(s), "no format/premise exists before the HOH comp stages").toBeNull();
  });
});

// --- Adapter-level pin (0125 theme ENABLED) — the real-play path + the P2 twist-mutation guard ---------

/** Resolve any pending legally (compete every comp round, first legal option everywhere) — roles only. */
function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

function newThemedGame(user: string, seed: number): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setCompThemesEnabled(true); // the real-play default — the seeded skin over the 0042 floor
  sb.session.setCompMechanicsPlusEnabled(false); // explicit OFF: its "social" comp format would trip the stat-key scan below (default flip 2026-11-03)
  return sb;
}

/** The whereabouts comp pin as a stable string, or null when there is no live comp house-event. */
function compPinString(sb: UserSandbox): string | null {
  const he = sb.session.whereabouts()?.houseEvent;
  if (!he || (he.kind !== "hoh-competition" && he.kind !== "veto-competition") || !he.comp) return null;
  return JSON.stringify(he.comp); // {name, format, premise}
}

describe("L-F4 (#1743) — adapter-level themed pin: whereabouts().houseEvent.comp is stable across a comp", () => {
  it("with the theme layer ENABLED, name+format+premise are byte-identical every comp beat — even as the twist flips mid-comp", () => {
    const sb = newThemedGame("lf4-adapter", 31);
    const s = sb.session;

    // Advance into the first STAGED competition (the comp pin appears once the roll stages).
    let staged: string | null = null;
    for (let i = 0; i < 400 && staged === null; i++) {
      staged = compPinString(sb);
      if (staged !== null) break;
      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
    }
    expect(staged, "the drive must reach a staged competition with a comp pin").not.toBeNull();

    // Collect the pin across EVERY beat of this one comp. Between beats, MUTATE the live twist phase
    // (0->"running", cycle 0->1) — a change that WOULD re-skin the comp if the theme read live state.
    // The pin is frozen at draw, so it must stay byte-identical. The bogus twist is restored before each
    // advance so the seeded drive is never perturbed (presentation-only).
    const seen: string[] = [staged!];
    for (let i = 0; i < 40; i++) {
      const live = (s as unknown as { live: { twist?: unknown } }).live;
      const savedTwist = live.twist;
      live.twist = { kind: "double-eviction", phase: "running" }; // flip cycle 0->1 at READ time only
      const underFlip = compPinString(sb);
      live.twist = savedTwist; // restore — the engine advance must never see the bogus twist
      if (underFlip !== null) seen.push(underFlip); // the read under the flipped twist must match

      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
      const next = compPinString(sb);
      if (next === null) break; // the comp has crowned — we captured its whole run
      seen.push(next);
    }

    // The comp genuinely spanned multiple beats (a turn-TO-turn flip needs at least two).
    expect(seen.length, "the staged comp must surface across multiple beats").toBeGreaterThanOrEqual(2);
    // THE LITMUS: one theme name + format + premise for the whole competition, never re-skinned.
    expect(new Set(seen).size, "the themed comp pin must be byte-identical across every round + twist flip").toBe(1);

    // Sanity: the pin is a real themed presentation (non-empty name/format/premise), Vault-free.
    const pin = JSON.parse(seen[0]!) as { name: string; format: string; premise: string };
    expect(pin.name.length).toBeGreaterThan(0);
    expect(pin.format.length).toBeGreaterThan(0);
    expect(pin.premise.length).toBeGreaterThan(0);
    expect(/"(physical|mental|social|trust|affinity|threat|scores|temperature)"/i.test(seen[0]!)).toBe(false);
  });

  it("a LATE #1400 fiction write-back (after rounds began) does NOT re-skin the active comp's whereabouts pin", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("lf4-late-fiction");
    sb.session.createCharacter({ playerName: "The Player", seed: 31 });
    sb.session.setCompThemesEnabled(true);     // the seeded theme is the frozen source at draw
    sb.session.setGenCompetitionsEnabled(true); // #1400 authoring is ON — the model dresses the decided roll
    const s = sb.session;

    // Advance into the first STAGED competition and capture the frozen (pre-fiction) pin.
    let pinned: string | null = null;
    for (let i = 0; i < 400 && pinned === null; i++) {
      pinned = compPinString(sb);
      if (pinned !== null) break;
      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
    }
    expect(pinned, "the drive must reach a staged competition").not.toBeNull();

    // The FE authors matching fiction AFTER staging began (the #1400 flow — the model always dresses a
    // decided result). Build it from the engine's own fixed drop order so it validates + is stored.
    const view = s.competitionStagingView();
    expect(view, "gen-competitions ON ⇒ the staging view is available once the roll resolves").not.toBeNull();
    const accepted = s.recordCompetitionFiction({
      comp: view!.comp, week: view!.week,
      theme: "A LATE Model Theme", premise: "a late model-authored premise that must NOT re-skin this comp",
      eliminations: view!.dropOrder.map((r) => ({ id: r.id, fiction: `${r.name} bows out` })),
    });
    expect(accepted.accepted, "the drop-order-matched fiction validates + stores (its per-drop lines ride comp-elimination)").toBe(true);

    // THE P1 GUARD: the active comp's whereabouts pin is UNCHANGED by the late fiction, and stays
    // byte-identical across every remaining round.
    const seen: string[] = [pinned!];
    const afterFiction = compPinString(sb);
    if (afterFiction !== null) seen.push(afterFiction);
    for (let i = 0; i < 40; i++) {
      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
      const next = compPinString(sb);
      if (next === null) break;
      seen.push(next);
    }
    expect(seen.length, "the comp spanned multiple beats around the late write-back").toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size, "the late fiction must not change the active comp's pinned presentation").toBe(1);
    // And the pin is the frozen SEEDED THEME, not the late authored theme.
    expect(seen[0]!).not.toContain("a late model-authored premise");
  });

  it("a LEGACY in-progress comp (no frozen fields) is LAZY-FROZEN on first read, then can't flip across remaining rounds", () => {
    const sb = newThemedGame("lf4-legacy", 31);
    const s = sb.session;

    // Advance into the first STAGED competition.
    let reached = false;
    for (let i = 0; i < 400 && !reached; i++) {
      if (compPinString(sb) !== null) { reached = true; break; }
      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
    }
    expect(reached, "the drive must reach a staged competition").toBe(true);

    // Simulate a PRE-#1743 save: STRIP the frozen theme fields so the comp is loaded "legacy" (every read
    // would otherwise fall back to mutable live state).
    const live = (s as unknown as { live: { competition?: { themeWeek?: number; themeCycle?: number; themeAuthored?: boolean }; twist?: unknown } }).live;
    const c = live.competition!;
    delete c.themeWeek; delete c.themeCycle; delete c.themeAuthored;
    expect(c.themeWeek, "the legacy comp starts with no frozen fields").toBeUndefined();

    // FIRST READ lazy-freezes the presentation from the current live state (persisted onto the comp).
    const first = compPinString(sb);
    expect(first, "the legacy staged comp still surfaces a pin").not.toBeNull();
    expect(c.themeWeek, "the first read froze the theme inputs onto the comp (persists in the snapshot)").not.toBeUndefined();
    expect(c.themeAuthored, "the source decision is frozen too").not.toBeUndefined();

    // From here the pin must stay byte-identical across remaining rounds even as the live twist flips —
    // the lazy-freeze on first read closed the legacy flip.
    const seen: string[] = [first!];
    for (let i = 0; i < 40; i++) {
      const savedTwist = live.twist;
      live.twist = { kind: "double-eviction", phase: "running" }; // would re-skin a legacy comp if unpinned
      const underFlip = compPinString(sb);
      live.twist = savedTwist;
      if (underFlip !== null) seen.push(underFlip);

      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
      const next = compPinString(sb);
      if (next === null) break;
      seen.push(next);
    }
    expect(seen.length, "the comp spanned multiple beats after the lazy-freeze").toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size, "the lazy-frozen legacy comp must be byte-identical across every remaining round + twist flip").toBe(1);
  });

  it("the lazy-freeze is idempotent — it never re-freezes an already-frozen comp to a new live value", () => {
    const sb = newThemedGame("lf4-legacy-idem", 7);
    const s = sb.session;
    let reached = false;
    for (let i = 0; i < 400 && !reached; i++) {
      if (compPinString(sb) !== null) { reached = true; break; }
      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
    }
    expect(reached).toBe(true);
    const live = (s as unknown as { live: { competition?: { themeWeek?: number; themeCycle?: number }; twist?: unknown } }).live;
    const c = live.competition!;
    delete c.themeWeek; delete c.themeCycle;
    (c as { themeAuthored?: boolean }).themeAuthored = undefined;

    compPinString(sb);                    // first read freezes (twist absent ⇒ cycle 0)
    const frozenWeek = c.themeWeek;
    const frozenCycle = c.themeCycle;
    expect(frozenWeek).not.toBeUndefined();

    live.twist = { kind: "double-eviction", phase: "running" }; // a later live change
    compPinString(sb);                    // a subsequent read must NOT re-freeze
    expect(c.themeWeek, "the frozen week is not re-frozen").toBe(frozenWeek);
    expect(c.themeCycle, "the frozen cycle is not re-frozen to the new live twist").toBe(frozenCycle);
  });
});
