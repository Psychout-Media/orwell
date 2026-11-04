import { describe, it, expect } from "vitest";
import { buildBeatAnnouncements, announcementHeadline, type BeatAnnouncement } from "../../src/engine/beatAnnouncement";
import type { BeatEvent, EvictionProgress, LiveSeasonState } from "../../src/engine/liveSeason";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Feature T0-3 (issue #1778, D1 2026-07-21) — the pure, Vault-free derivation from a committed
 * weekly-loop `BeatEvent` to zero or more `BeatAnnouncement` facts. These are FIXTURE-level unit
 * tests (no live season, no rng) so every branch of `buildBeatAnnouncements` is pinned directly.
 * Roles only — NO names (testing rule); every id below is a role-based `npc(n)`/`PLAYER` id.
 */

const HOH = npc(1);
const NOM_A = npc(2);
const NOM_B = npc(3);
const VETO_HOLDER = npc(4);
const REPLACEMENT = npc(5);

/** A minimal, valid `LiveSeasonState` fixture — only the required fields + whatever the test needs. */
function stateFixture(partial: Partial<LiveSeasonState> = {}): LiveSeasonState {
  return {
    week: 3,
    beat: "hoh-competition",
    active: [PLAYER, HOH, NOM_A, NOM_B, VETO_HOLDER, REPLACEMENT],
    vetoUsed: false,
    evictionOrder: [],
    finished: false,
    ...partial,
  };
}

describe("T0-3 — buildBeatAnnouncements (weekly-loop scope)", () => {
  it("hoh-competition ⇒ exactly one hoh-winner announcement naming the winner", () => {
    const ev: BeatEvent = { beat: "hoh-competition", content: "x wins Head of Household", participants: [HOH] };
    const facts = buildBeatAnnouncements(ev, stateFixture());
    expect(facts).toEqual([{ kind: "hoh-winner", week: 3, subjects: [HOH] }]);
  });

  it("nominations ⇒ exactly one nominations announcement naming both nominees + the nominating HOH", () => {
    const ev: BeatEvent = { beat: "nominations", content: "x nominates y and z", participants: [HOH, NOM_A, NOM_B] };
    const facts = buildBeatAnnouncements(ev, stateFixture());
    expect(facts).toEqual([{ kind: "nominations", week: 3, subjects: [NOM_A, NOM_B], detail: { by: HOH } }]);
  });

  it("veto-competition ⇒ exactly one veto-winner announcement naming the CROWNED winner (not the whole field)", () => {
    // The crown event's participants are the FULL comp field — the real winner is `s.vetoHolder`,
    // already set by `crownCompetition` before `commit()` runs.
    const field = [HOH, NOM_A, NOM_B, VETO_HOLDER, REPLACEMENT, npc(6)];
    const ev: BeatEvent = { beat: "veto-competition", content: "x wins the Power of Veto", participants: field };
    const facts = buildBeatAnnouncements(ev, stateFixture({ vetoHolder: VETO_HOLDER }));
    expect(facts).toEqual([{ kind: "veto-winner", week: 3, subjects: [VETO_HOLDER] }]);
  });

  it("veto-ceremony (not used) ⇒ exactly one veto-decision announcement, used:false, no replacement", () => {
    const ev: BeatEvent = { beat: "veto-ceremony", content: "x does not use the veto", participants: [VETO_HOLDER] };
    const facts = buildBeatAnnouncements(ev, stateFixture({ vetoHolder: VETO_HOLDER, vetoUsed: false }));
    expect(facts).toEqual([{ kind: "veto-decision", week: 3, subjects: [VETO_HOLDER], detail: { used: false } }]);
  });

  it("veto-ceremony (used, replacement pending — player-HOH path) ⇒ ONLY the veto-decision announces (no premature replacement)", () => {
    // `s.replacement` is still undefined here — the HOH's replacement pick hasn't resolved yet.
    const ev: BeatEvent = {
      beat: "veto-ceremony", content: "x uses the veto on y", participants: [VETO_HOLDER, NOM_A],
    };
    const facts = buildBeatAnnouncements(ev, stateFixture({ vetoHolder: VETO_HOLDER, vetoUsed: true, saved: NOM_A }));
    expect(facts).toEqual([
      { kind: "veto-decision", week: 3, subjects: [VETO_HOLDER], detail: { used: true, saved: NOM_A } },
    ]);
  });

  it("veto-ceremony (used, replacement bundled — NPC-holder fast path) ⇒ BOTH veto-decision AND replacement-nominee, no duplicate", () => {
    const ev: BeatEvent = {
      beat: "veto-ceremony", content: "x uses the veto on y; z names w as the replacement",
      participants: [VETO_HOLDER, NOM_A, HOH, REPLACEMENT],
    };
    const facts = buildBeatAnnouncements(
      ev, stateFixture({ vetoHolder: VETO_HOLDER, vetoUsed: true, saved: NOM_A, hoh: HOH, replacement: REPLACEMENT }),
    );
    expect(facts).toEqual([
      { kind: "veto-decision", week: 3, subjects: [VETO_HOLDER], detail: { used: true, saved: NOM_A } },
      { kind: "replacement-nominee", week: 3, subjects: [REPLACEMENT], detail: { by: HOH } },
    ]);
  });

  it("veto-ceremony (a LATER, separate replacement decision) ⇒ ONLY replacement-nominee — the earlier veto-decision is NOT re-announced", () => {
    // The decision (`s.saved`) was committed in a PRIOR beat; THIS commit's participants are exactly
    // [hoh, replacement] and never include `saved` — the disambiguator this test pins.
    const ev: BeatEvent = {
      beat: "veto-ceremony", content: "x names y as the replacement", participants: [HOH, REPLACEMENT],
    };
    const facts = buildBeatAnnouncements(
      ev, stateFixture({ vetoHolder: VETO_HOLDER, vetoUsed: true, saved: NOM_A, hoh: HOH, replacement: REPLACEMENT }),
    );
    expect(facts).toEqual([{ kind: "replacement-nominee", week: 3, subjects: [REPLACEMENT], detail: { by: HOH } }]);
  });

  it("eviction-reveal ⇒ exactly one eviction-ballot announcement, subjects BYTE-EQUAL to the batch's participants (E12: never a voter)", () => {
    const ballots = [NOM_A, NOM_A, NOM_B]; // "a vote to evict A. a vote to evict A. a vote to evict B."
    const ev: BeatEvent = { beat: "eviction-reveal", content: "a vote to evict …", participants: ballots };
    const facts = buildBeatAnnouncements(ev, stateFixture());
    expect(facts).toEqual([{ kind: "eviction-ballot", week: 3, subjects: ballots }]);
    // Byte-equal: the SAME array values, not just a matching count.
    expect((facts[0] as BeatAnnouncement).subjects).toStrictEqual(ballots);
  });

  it("eviction-reveal with an EMPTY batch ⇒ no announcement (defensive; never happens in practice)", () => {
    const ev: BeatEvent = { beat: "eviction-reveal", content: "", participants: [] };
    expect(buildBeatAnnouncements(ev, stateFixture())).toEqual([]);
  });

  it("eviction ⇒ exactly one eviction-result announcement naming the evictee + the responsible HOH", () => {
    const eviction: EvictionProgress = {
      stage: "goodbye",
      nominees: [NOM_A, NOM_B],
      revealOrder: [npc(7), npc(8), npc(9)],
      voteOf: { [npc(7)]: NOM_A, [npc(8)]: NOM_A, [npc(9)]: NOM_B },
      revealIx: 3,
      evictee: NOM_A,
      goodbyeFrom: [],
      goodbyeIx: 0,
    };
    const ev: BeatEvent = { beat: "eviction", content: "x is evicted", participants: [NOM_A] };
    const facts = buildBeatAnnouncements(ev, stateFixture({ hoh: HOH, eviction }));
    expect(facts).toEqual([{ kind: "eviction-result", week: 3, subjects: [NOM_A], detail: { by: HOH } }]);
  });

  it("eviction with a TIED final tally ⇒ eviction-result carries tieBroken:true (the HOH broke the tie)", () => {
    const eviction: EvictionProgress = {
      stage: "goodbye",
      nominees: [NOM_A, NOM_B],
      revealOrder: [npc(7), npc(8)],
      voteOf: { [npc(7)]: NOM_A, [npc(8)]: NOM_B }, // 1-1 tie ⇒ the HOH broke it
      revealIx: 2,
      evictee: NOM_A,
      goodbyeFrom: [],
      goodbyeIx: 0,
    };
    const ev: BeatEvent = { beat: "eviction", content: "x is evicted", participants: [NOM_A] };
    const facts = buildBeatAnnouncements(ev, stateFixture({ hoh: HOH, eviction }));
    expect(facts).toEqual([{ kind: "eviction-result", week: 3, subjects: [NOM_A], detail: { by: HOH, tieBroken: true } }]);
  });

  it("final-eviction (Final 3) ⇒ exactly one eviction-result announcement naming the finalist evicted", () => {
    const ev: BeatEvent = { beat: "final-eviction", content: "x evicts y, setting the Final 2", participants: [HOH, NOM_A] };
    const facts = buildBeatAnnouncements(ev, stateFixture({ hoh: HOH }));
    expect(facts).toEqual([{ kind: "eviction-result", week: 3, subjects: [NOM_A], detail: { by: HOH } }]);
  });

  it("out-of-scope beats (veto-draw, day-break, finale, self-eviction) ⇒ no announcement", () => {
    const outOfScope: BeatEvent["beat"][] = [
      "veto-draw", "day-break", "battle-back", "finale", "self-eviction",
      "eviction-goodbye", "exit-interview", "complete",
    ];
    for (const beat of outOfScope) {
      const ev: BeatEvent = { beat, content: "x", participants: [HOH] };
      expect(buildBeatAnnouncements(ev, stateFixture())).toEqual([]);
    }
  });
});

describe("A-14 N-3 — comp-elimination announces the round's drops", () => {
  it("drops = participants no longer in the field; remaining = the field size; nothing dropped ⇒ nothing", () => {
    const f = stateFixture();
    const s = { ...f, competition: { stillIn: [NOM_B, VETO_HOLDER] } } as unknown as ReturnType<typeof stateFixture>;
    const ev: BeatEvent = { beat: "comp-elimination", content: "x", participants: [HOH, NOM_A, NOM_B, VETO_HOLDER] };
    const out = buildBeatAnnouncements(ev, s);
    expect(out).toEqual([{ kind: "comp-round-result", week: s.week, subjects: [HOH, NOM_A], detail: { remaining: 2 } }]);
    const none: BeatEvent = { beat: "comp-elimination", content: "x", participants: [NOM_B, VETO_HOLDER] };
    expect(buildBeatAnnouncements(none, s)).toEqual([]);
  });
});

describe("T0-3 — announcementHeadline (deterministic, Vault-free broadcast prose)", () => {
  const names: Record<string, string> = { [HOH]: "HOH", [NOM_A]: "NomA", [NOM_B]: "NomB", [VETO_HOLDER]: "VetoHolder", [REPLACEMENT]: "Replacement" };
  const nameOf = (id: string): string => names[id] ?? id;

  it("hoh-winner", () => {
    expect(announcementHeadline({ kind: "hoh-winner", week: 1, subjects: [HOH] }, nameOf))
      .toBe("HOH is the new Head of Household.");
  });

  it("veto-decision (used, saved someone else) never omits who was saved", () => {
    const a: BeatAnnouncement = { kind: "veto-decision", week: 1, subjects: [VETO_HOLDER], detail: { used: true, saved: NOM_A } };
    expect(announcementHeadline(a, nameOf)).toBe("VetoHolder uses the Power of Veto on NomA.");
  });

  it("veto-decision (used, saved SELF) reads 'on themselves'", () => {
    const a: BeatAnnouncement = { kind: "veto-decision", week: 1, subjects: [VETO_HOLDER], detail: { used: true, saved: VETO_HOLDER } };
    expect(announcementHeadline(a, nameOf)).toBe("VetoHolder uses the Power of Veto on themselves.");
  });

  it("eviction-ballot NEVER names a voter — only who each anonymized ballot named (E12)", () => {
    const a: BeatAnnouncement = { kind: "eviction-ballot", week: 1, subjects: [NOM_A, NOM_A, NOM_B] };
    const text = announcementHeadline(a, nameOf);
    expect(text).toBe("a vote to evict NomA. a vote to evict NomA. a vote to evict NomB.");
    // No voter identity of any kind appears — only nominee names, in the "a vote to evict …" form.
    expect(text).not.toMatch(/HOH|VetoHolder|Replacement/);
  });

  it("eviction-result with a tie-break names the mechanism, never an extra ballot", () => {
    const a: BeatAnnouncement = { kind: "eviction-result", week: 1, subjects: [NOM_A], detail: { by: HOH, tieBroken: true } };
    expect(announcementHeadline(a, nameOf)).toBe("NomA has been evicted from the house after the Head of Household broke a tied vote.");
  });
});


describe("P5d — a PLAYED secret veto and its replacement nominee are broadcast (the other twist-reveals stay silent)", () => {
  const SV_HOLDER = npc(6);
  const ev: BeatEvent = { beat: "twist-reveal", content: "SECRET VETO: x reveals a secret one-time safety", participants: [SV_HOLDER, HOH, REPLACEMENT, NOM_A] };
  const played = stateFixture({ hoh: HOH, firedTwists: [{ kind: "secret-veto", beat: 3 }] });

  it("announces the secret veto being played, then the HOH's replacement nominee", () => {
    const facts = buildBeatAnnouncements(ev, played);
    expect(facts).toEqual([
      { kind: "secret-veto", week: 3, subjects: [SV_HOLDER] },
      { kind: "replacement-nominee", week: 3, subjects: [REPLACEMENT], detail: { by: HOH } },
    ]);
    const names: Record<string, string> = { [SV_HOLDER]: "Role X", [HOH]: "Role H", [REPLACEMENT]: "Role R" };
    const nameOf = (id: string): string => names[id] ?? id;
    expect(announcementHeadline(facts[0]!, nameOf)).toBe("Role X plays a secret veto and comes off the block.");
    expect(announcementHeadline(facts[1]!, nameOf)).toBe("Role H names Role R as the replacement nominee.");
  });

  it("a twist-reveal that is NOT this week's secret veto (double eviction, an earlier week's veto) stays silent", () => {
    expect(buildBeatAnnouncements(ev, stateFixture({ hoh: HOH, firedTwists: [{ kind: "double-eviction", beat: 3 }] }))).toEqual([]);
    expect(buildBeatAnnouncements(ev, stateFixture({ hoh: HOH, firedTwists: [{ kind: "secret-veto", beat: 2 }] }))).toEqual([]);
    expect(buildBeatAnnouncements(ev, stateFixture({ hoh: HOH }))).toEqual([]);
  });

  it("is Vault-free: only the holder, HOH and replacement ids — never the staying nominee or any hidden field", () => {
    const blob = JSON.stringify(buildBeatAnnouncements(ev, played));
    expect(blob).not.toContain(NOM_A);
  });
});
