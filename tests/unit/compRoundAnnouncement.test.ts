import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView } from "../../src/ports/GameSession";
import { PLAYER } from "../../src/domain/ids";

/**
 * A-14 N-3 — a staged competition round is a closed-set fact the player must be TOLD (the FE pre-resolve walked the
 * rounds silently; chat then said "the competition hasn't happened yet"). The engine now broadcasts each round's
 * drop as a Vault-free `comp-round-result` announcement: who is out (public names) and how many remain.
 */
function play(seed: number): AdvanceView[] {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", seed });
  const out: AdvanceView[] = [];
  for (let i = 0; i < 400; i++) {
    const v = s.advanceGame();
    out.push(v);
    if (v.pending) {
      const p = v.pending;
      s.submitDecision(p.kind === "comp-round" ? { kind: "comp-round", intent: "compete" } : p.kind === "comp-intent" ? { kind: "comp-intent", intent: "compete" } : { kind: p.kind, vote: p.options[0]?.id } as never);
    }
    if (v.finished || out.filter((x) => x.announcements?.some((a) => a.kind === "hoh-winner")).length >= 2) break;
  }
  return out;
}
const rounds = (views: AdvanceView[]) => views.flatMap((v) => v.announcements ?? []).filter((a) => a.kind === "comp-round-result");

describe("A-14 N-3 — comp-round-result announcements", () => {
  it("every staged elimination round is announced: the dropped houseguests (public names) and how many remain", () => {
    const rs = rounds(play(5));
    expect(rs.length).toBeGreaterThan(0);
    for (const a of rs) {
      expect(a.subjects.length).toBeGreaterThan(0);
      expect(typeof a.detail?.remaining).toBe("number");
      expect(a.headline).toContain(a.subjects[0]!.name);
      expect(a.headline).toMatch(/out/i);
      expect(a.headline).toContain(String(a.detail!.remaining));
    }
  });
  it("the remaining count falls monotonically within a competition and ends before the crown", () => {
    const views = play(5);
    const all = views.flatMap((v) => v.announcements ?? []);
    const firstCrown = all.findIndex((a) => a.kind === "hoh-winner");
    const before = all.slice(0, firstCrown).filter((a) => a.kind === "comp-round-result").map((a) => a.detail!.remaining!);
    expect(before.length).toBeGreaterThan(0);
    for (let i = 1; i < before.length; i++) expect(before[i]!).toBeLessThan(before[i - 1]!);
    expect(before[before.length - 1]!).toBeGreaterThanOrEqual(1);
  });
  it("Vault-free: public ids/names only, no number but the remaining count, no voter/lean fields", () => {
    const blob = JSON.stringify(rounds(play(5)));
    for (const banned of ["trust", "threat", "affinity", "lean", "soul", "hidden"]) expect(blob.includes(banned), banned).toBe(false);
  });
  it("the player appears among the dropped when they are eliminated (named like anyone else)", () => {
    let seen = false;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) { if (rounds(play(seed)).some((a) => a.subjects.some((x) => x.id === PLAYER))) { seen = true; break; } }
    expect(seen).toBe(true);
  });
});
