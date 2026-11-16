import { describe, it, expect } from "vitest";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import type { Stats } from "../../src/engine/season";
import {
  newLiveSeason, advance, applyDecision, type LiveSeasonState, type SeasonCtx, type BeatEvent,
} from "../../src/engine/liveSeason";
import { MOMENT_PROMPTS } from "../../src/engine/momentPrompts";

/**
 * BB-14 (2026-07-03 final-pre-ship audit, bb-nerd lane) — "No HOH-room reveal — 'Who wants to see
 * my HOH room?!', the letter from home, the basket" was missing entirely.
 *
 * The fix stages it as PURE NARRATION off the already-decided HOH crown — appended to the
 * `hoh-competition` moment-prompt fragment — with NO new structural beat. The first attempt added an
 * inert `hoh-reveal` beat, but a structural beat cannot be neutral here: in pure turn-driven mode the
 * orchestrator fires one bounded off-screen tick per loop-PROGRESSING advance (gated on the live-loop
 * state changing), so an extra beat draws an extra off-screen-society rng tick and shifts the seeded
 * calibration gradient. A prompt-only fragment cannot touch the loop, so it is neutral BY CONSTRUCTION
 * — the guard below proves the crown still hands straight off to `nominations`, adding no beat.
 * HARD rule: roles only — no names.
 */
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

describe("BB-14 — the HOH-room reveal is staged as narration, never a structural beat", () => {
  it("the hoh-competition moment fragment carries the room-reveal framing (letter/photos, who-wants-to-see)", () => {
    const frag = MOMENT_PROMPTS["hoh-competition"]!;
    expect(frag).toMatch(/HOH-ROOM REVEAL/i);
    // ORW-510: the crowd-upstairs beat stays; the stock line it used to quote is a copied example, so it is no longer scripted.
    expect(frag).toMatch(/crowding upstairs to see the room/i);
    expect(frag).not.toMatch(/who wants to see my HOH room/i);
    expect(frag).toMatch(/letter and photos from home/i);
    // Distinct player-vs-NPC framing, and the anti-perturbation guardrails (pure color, no mechanic).
    expect(frag).toMatch(/if the PLAYER is the new HOH/i);
    expect(frag).toMatch(/if an NPC won/i);
    expect(frag).toMatch(/invent no mechanic, change no outcome/i);
  });

  it("NO `hoh-reveal` moment key exists — the reveal is not a separate beat/moment", () => {
    expect(MOMENT_PROMPTS["hoh-reveal"]).toBeUndefined();
  });

  it("STRUCTURAL GUARD: an HOH crown hands off DIRECTLY to nominations — the seeded beat sequence adds no beat", () => {
    for (const seed of [1, 5, 7, 21]) {
      const { active, ctx } = buildHouse(10, seed);
      const s: LiveSeasonState = newLiveSeason(active);
      const rng = new SeededRandom(seed);
      // Drive to the first HOH crown.
      let crown: BeatEvent | null = null;
      for (let g = 0; g < 300 && !crown; g++) {
        const p = s.pending;
        if (p?.kind === "comp-round" || p?.kind === "comp-intent") {
          const ev = applyDecision(s, { kind: p.kind, intent: "compete" }, ctx, rng);
          if (ev.beat === "hoh-competition") crown = ev;
        } else {
          const ev = advance(s, ctx, rng);
          if (ev?.beat === "hoh-competition") crown = ev;
        }
      }
      expect(crown, `seed ${seed} reached an HOH crown`).not.toBeNull();
      // The crown transitions the loop straight to nominations — NO intermediate presentation beat that
      // would earn an extra orchestrator off-screen tick and shift the calibration gradient.
      expect(s.beat).toBe("nominations");
    }
  });
});
