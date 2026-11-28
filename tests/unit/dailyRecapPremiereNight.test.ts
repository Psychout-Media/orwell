import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-382 (live playtest 11-15: the player who went to bed on Day 1 got no "day in review"): the premiere night has no ceremony or deal, so the recap carried NOTHING and the narrator rightly skipped it.
 * The review is now also built from the scenes the player WITNESSED (never a hidden event). Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("ORW-382 - every bedtime has a day in review, the premiere night included", () => {
  it("day 1 bed after the premiere: the recap names what the player saw", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("recap-premiere").session as any;
    s.setPremiereEntrancesEnabled(true); // the deployed premiere (the unit lane defaults it off)
    s.createCharacter({ playerName: "P", seed: 5 });
    s.setPerConversationClockEnabled(true);
    for (let i = 0; i < 40 && s.getGameState().phase === "premiere"; i++) { if (s.advanceGame().pending) break; }
    for (let i = 0; i < 400 && !["night", "late-night"].includes(s.gameStatus().timeOfDay); i++) s.noteMessage({ messageId: `m${i}` });
    const v = s.turnIn();
    expect(v.held).toBeUndefined();
    expect(v.dailyRecap?.day).toBe(1);
    // ORW-1165: the premiere's arrivals, toast and talks are in the digest (before, a premiere night had no highlights at all)
    expect(v.dailyRecap!.highlights.length, "the review has the player's own witnessed moments").toBeGreaterThan(0);
    const evs = s.record.events() as { id: string; hidden: boolean; witnessSet: string[] }[];
    const pid = s.getGameState().player.id;
    for (const d of v.dailyRecap!.digest!) for (const id of d.from) expect(evs.some((e) => e.id === id && !e.hidden && e.witnessSet.includes(pid)), `"${d.text}" is built from a witnessed, non-hidden event`).toBe(true);
    for (const line of [...v.dailyRecap!.highlights, ...(v.dailyRecap!.yourDay ?? [])]) expect(line, "no provenance bookkeeping reaches the review").not.toMatch(/^surfaced to player via|overheard:|told-by:/);
    expect((v.dailyRecap!.yourDay ?? []).length).toBeLessThanOrEqual(5);
  });

  it("review of #2664/#2672: a witnessed scene with the same words as a highlight stays; gossip and surfacing bookkeeping never ride", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("recap-kinds").session as any;
    s.createCharacter({ playerName: "P", seed: 6 });
    const pid = s.getGameState().player.id;
    const mk = (id: string, type: string, content: string) => ({ id, ts: 9000 + Number(id.replace(/\D/g, "")), type, initiator: pid, witnessSet: [pid], hidden: false, content });
    const orig = s.record;
    const extra = [mk("season:77", "season", "The same words"), mk("x1", "interaction", "The same words"), mk("x2", "gossip", "gossip rumor reaches you"), mk("x3", "surfacing", "surfaced elsewhere")];
    s.setRecordProviders({ events: () => [...orig.events(), ...extra], hidden: orig.hidden });
    const v = s.turnIn();
    const day = v.dailyRecap?.yourDay ?? s.dailyRecap()?.yourDay ?? [];
    expect(day).toContain("The same words");
    expect(day.join("|")).not.toMatch(/gossip rumor|surfaced elsewhere/);
  });
});
