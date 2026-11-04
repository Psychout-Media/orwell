import { describe, it, expect } from "vitest";
import { targetsMeTilt, TARGETS_ME_TILT_MAX, recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { SessionCore } from "../../src/engine/sessionSnapshot";

/**
 * B3 / #2017 (coordinator-redefined): a FALSIFIABLE `targets-me` claim writer, then a nomination term that reads the HOH's claims — never the edge. From the NPC's own perspective:
 * "who do I believe is targeting me?", sometimes wrongly. Default OFF (`ORWELL_NPC_BELIEF_NOMS` + `ORWELL_NPC_BELIEFS`), byte-identical OFF. Roles only.
 */
const claim = (over: Record<string, unknown>) => ({ holder: "h", kind: "targets-me" as const, subject: "x", value: true, origin: "told" as const, confidence: 1, week: 5, ...over });

describe("targetsMeTilt — the pure belief term", () => {
  it("no claim ⇒ 0; a fresh confident claim ⇒ a positive bounded tilt; it never exceeds the max", () => {
    const s: BeliefStore = {};
    expect(targetsMeTilt(s, "h", "x", 5)).toBe(0);
    recordClaim(s, claim({}));
    expect(targetsMeTilt(s, "h", "x", 5)).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) recordClaim(s, claim({ id: `c${i}`, week: 5 }));
    expect(targetsMeTilt(s, "h", "x", 5)).toBeLessThanOrEqual(TARGETS_ME_TILT_MAX + 1e-9);
  });
  it("is graded by confidence, fades with age, and ignores refuted / false / other-subject / other-holder claims", () => {
    const hi: BeliefStore = {}, lo: BeliefStore = {};
    recordClaim(hi, claim({ confidence: 0.9 })); recordClaim(lo, claim({ confidence: 0.3 }));
    expect(targetsMeTilt(hi, "h", "x", 5)).toBeGreaterThan(targetsMeTilt(lo, "h", "x", 5));
    expect(targetsMeTilt(hi, "h", "x", 12)).toBeLessThan(targetsMeTilt(hi, "h", "x", 5));
    const other: BeliefStore = {};
    recordClaim(other, claim({ id: "a", refuted: true })); recordClaim(other, claim({ id: "b", value: false })); recordClaim(other, claim({ id: "c", subject: "y" })); recordClaim(other, claim({ id: "d", holder: "z" }));
    expect(targetsMeTilt(other, "h", "x", 5)).toBe(0);
  });
});

type S = ReturnType<GameSessionRegistry["sandboxFor"]>["session"];
const wire = (s: S, on: boolean) => {
  (s as unknown as { setNpcBeliefsEnabled(b: boolean): void }).setNpcBeliefsEnabled(on);
  (s as unknown as { setNpcBeliefNomsEnabled(b: boolean): void }).setNpcBeliefNomsEnabled(on);
};
function session(on: boolean, seed = 7): S {
  const s = new GameSessionRegistry().sandboxFor(`bn-${on}-${seed}-${Math.random()}`).session;
  wire(s, on); s.createCharacter({ playerName: "P", seed }); s.advanceGame(); s.advanceGame();
  return s;
}
/** Plant an active evict-campaign AIMED AT `hoh` that `hoh` is aware of, owned by `owner`. */
function plant(s: S, hoh: string, owner: string): void {
  const core = JSON.parse(JSON.stringify(s.snapshot())) as SessionCore & { campaigns?: unknown[] };
  core.campaigns = [{ id: "camp-1", owners: [owner], goal: "evict", target: hoh, plan: [], progress: 0.4, horizon: "week", status: "active", startedBeat: 0, deadlineBeat: 99, confidence: 0.6, knownTo: [owner, hoh] }];
  core.live!.hoh = hoh;
  s.restore(core as SessionCore);
  (s as unknown as { campaignsEnabled: boolean }).campaignsEnabled = true;
}
const tilt = (s: S, subject: string, holder: string) => (s as unknown as { beliefNomTiltFor(a: string, b: string): number }).beliefNomTiltFor(subject, holder);

describe("the writer: a campaign aimed at the HOH that the HOH is aware of ⇒ a (sometimes wrong) targets-me belief", () => {
  it("ON: the HOH holds a targets-me claim naming the owner (or, rarely, a misattribution) and tilts against that subject; OFF: nothing is written", () => {
    const s = session(true);
    const npcs = (s.snapshot().live!.active as string[]).filter((x) => x !== PLAYER);
    const [hoh, owner] = [npcs[0]!, npcs[1]!];
    plant(s, hoh, owner);
    tilt(s, owner, hoh);
    const claims = (s.snapshot().live!.beliefs?.[hoh] ?? []).filter((c) => c.kind === "targets-me");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0]!.origin).toBe("told");
    expect(claims[0]!.confidence).toBeGreaterThan(0);
    const claimed = claims[0]!.subject;
    expect(tilt(s, claimed, hoh)).toBeGreaterThan(0);
    const off = session(false);
    plant(off, hoh, owner);
    expect(tilt(off, owner, hoh)).toBe(0);
    expect(Object.keys(off.snapshot().live!.beliefs ?? {}).length).toBe(0);
  });
  it("a campaign the HOH is NOT aware of, or aimed at someone else, writes nothing (symmetric perspective)", () => {
    const s = session(true);
    const npcs = (s.snapshot().live!.active as string[]).filter((x) => x !== PLAYER);
    const [hoh, owner, other] = [npcs[0]!, npcs[1]!, npcs[2]!];
    plant(s, other, owner);                       // aimed at someone else
    expect(tilt(s, owner, hoh)).toBe(0);
    const core = JSON.parse(JSON.stringify(s.snapshot())) as SessionCore & { campaigns: { target: string; knownTo: string[] }[] };
    core.campaigns[0]!.target = hoh; core.campaigns[0]!.knownTo = [owner];  // aimed at the HOH but the HOH has not heard of it
    s.restore(core as SessionCore);
    expect(tilt(s, owner, hoh)).toBe(0);
  });
  it("misattribution happens by construction across seeds (some wrong beliefs), but most are right, and it never draws the shared rng (same board ⇒ same answer twice)", () => {
    let wrong = 0, right = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = session(true, seed);
      const npcs = (s.snapshot().live!.active as string[]).filter((x) => x !== PLAYER);
      const [hoh, owner] = [npcs[0]!, npcs[1]!];
      plant(s, hoh, owner);
      tilt(s, owner, hoh);
      const subj = (s.snapshot().live!.beliefs?.[hoh] ?? []).find((c) => c.kind === "targets-me")?.subject;
      if (subj === owner) right++; else if (subj) wrong++;
      expect(tilt(s, owner, hoh), "deterministic").toBe(tilt(s, owner, hoh));
    }
    expect(wrong, "some beliefs are wrong").toBeGreaterThan(0);
    expect(right, "most are right").toBeGreaterThan(wrong);
  });
});
