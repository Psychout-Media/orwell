import { describe, it, expect } from "vitest";
import { driveSuspicion } from "../../src/engine/suspicion";
import type { Drive } from "../../src/engine/campaigns";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";

/**
 * Feature 0105 — the Vault-safe suspicion a houseguest's DRIVE (0086) gives them. Roles only (a schemer,
 * a rival, a safe floater). The PURE `driveSuspicion` maps a threat-reading drive to a behavioral hunch;
 * the live `npcVoice` surfaces it on `suspects` ONLY when the drive layer is on (⇒ byte-identical
 * projection when off) and NEVER leaks the plan, the intensity, or a stated motive.
 */

describe("0105 driveSuspicion — a behavioral hunch, never the plan", () => {
  const drive = (motivation: Drive["motivation"], intensity: number): Drive =>
    ({ owner: "npc:1", motivation, target: "npc:2", intensity });

  it("a TARGET drive reads as watching the subject (watchful vs fixated by intensity)", () => {
    expect(driveSuspicion(drive("target", 0.3), "the rival")).toMatch(/keeping a close eye on the rival/);
    expect(driveSuspicion(drive("target", 0.8), "the rival")).toMatch(/sizing up the rival/);
  });

  it("a SELF-PRESERVE drive reads as a defensive, wary read of the danger", () => {
    expect(driveSuspicion(drive("self-preserve", 0.3), "the threat")).toMatch(/wary feeling about the threat/);
    expect(driveSuspicion(drive("self-preserve", 0.9), "the threat")).toMatch(/watching their back around the threat/);
  });

  it("behavioral-only motivations carry NO suspicion (build/lay-low/win-power)", () => {
    for (const m of ["build", "lay-low", "win-power"] as const) {
      expect(driveSuspicion(drive(m, 0.9), "anyone")).toBeNull();
    }
  });

  it("no subject ⇒ no suspicion", () => {
    expect(driveSuspicion(drive("target", 0.8), undefined)).toBeNull();
  });

  it("never emits a number; is deterministic", () => {
    const s = driveSuspicion(drive("target", 0.8), "the rival")!;
    expect(s).not.toMatch(/[0-9]/);
    expect(driveSuspicion(drive("target", 0.8), "the rival")).toBe(s);
  });
});

describe("0105 npcVoice — drive-derived suspicion is live, gated, and Vault-sealed", () => {
  function house(seed: number, campaignsOn: boolean): { s: GameSessionAdapter; rel: RelationshipModel; ids: string[] } {
    const rel = new RelationshipModel(0.5);
    const s = new GameSessionAdapter(rel);
    s.createCharacter({ playerName: "The Player", seed });
    s.setCampaignsEnabled(campaignsOn);
    const ids = (s.snapshot().house?.npcs ?? []).map((n) => n.id);
    return { s, rel, ids };
  }
  const suspectsOf = (s: GameSessionAdapter, id: string): string[] => (s.npcVoice(id) as { suspects: string[] }).suspects;
  const nameOf = (s: GameSessionAdapter, id: string): string =>
    (s.snapshot().house!.npcs.find((n) => n.id === id)?.name) ?? "";
  const DRIVE_MARKERS = /keeping a close eye on|sizing up|watching their back|wary feeling about/;

  it("a houseguest who reads a rival as a threat is voiced as watching them, by name", () => {
    const { s, rel, ids } = house(2026, true);
    rel.edge(ids[0]!, ids[1]!).threat = 0.85;
    s.campaignTick();
    const suspects = suspectsOf(s, ids[0]!);
    const hunch = suspects.find((x) => DRIVE_MARKERS.test(x));
    expect(hunch, "a drive-derived suspicion appears").toBeTruthy();
    expect(hunch).toContain(nameOf(s, ids[1]!)); // it names the rival
  });

  it("a safe, under-the-radar houseguest gets NO manufactured suspicion", () => {
    const { s, rel, ids } = house(2026, true);
    for (const o of ids.filter((x) => x !== ids[0])) { rel.edge(ids[0]!, o).threat = 0.1; rel.edge(ids[0]!, o).affinity = 0.2; }
    s.campaignTick();
    expect(suspectsOf(s, ids[0]!).some((x) => DRIVE_MARKERS.test(x))).toBe(false);
  });

  it("with the drive layer OFF, no drive-derived suspicion is surfaced (byte-identical projection)", () => {
    const { s, rel, ids } = house(2026, false);
    rel.edge(ids[0]!, ids[1]!).threat = 0.85;
    s.campaignTick(); // a no-op when off
    expect(suspectsOf(s, ids[0]!).some((x) => DRIVE_MARKERS.test(x))).toBe(false);
  });

  it("A93: surfacing a hunch changes nothing in the mood (the claim the spec makes: the hunch is information, not a mood input)", () => {
    const moodOf = (s: GameSessionAdapter, id: string): string | undefined => (s.npcVoice(id) as { mood?: string }).mood;
    const on = house(2026, true), off = house(2026, false);
    for (const h of [on, off]) h.rel.edge(h.ids[0]!, h.ids[1]!).threat = 0.85;
    on.s.campaignTick(); off.s.campaignTick();
    expect(suspectsOf(on.s, on.ids[0]!).some((x) => DRIVE_MARKERS.test(x)), "the hunch is present with the drive layer on").toBe(true);
    expect(suspectsOf(off.s, off.ids[0]!).some((x) => DRIVE_MARKERS.test(x)), "and absent with it off").toBe(false);
    expect(moodOf(on.s, on.ids[0]!)).toBe(moodOf(off.s, off.ids[0]!));
    expect(moodOf(on.s, on.ids[0]!), "a live mood exists to compare").toBeTruthy();
  });

  it("the suspicion never leaks the plan — no number, campaign, intensity, or stated motive", () => {
    const { s, rel, ids } = house(7, true);
    rel.edge(ids[0]!, ids[1]!).threat = 0.85;
    s.campaignTick();
    const blob = JSON.stringify(suspectsOf(s, ids[0]!));
    expect(blob).not.toMatch(/[0-9]/);
    expect(blob).not.toMatch(/campaign|intensity|motivation|self-preserve|lay-low|win-power|target/);
  });
});
