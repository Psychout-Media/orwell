import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import type { DailyRecapView } from "../../src/ports/GameSession";

/**
 * ORW-254 (Ryne, BDD card 29: "I am only concerned about things leaking from your limited perspective") - the daily recap and its "next time on" hint may carry only what the PLAYER knows, and
 * no spoilers. These tests run over the REAL generated recap + hint with PLANTED sentinels (the next HOH, a nominee, the evictee, a hidden secret, a hidden event, a Diary Room entry, an
 * unsurfaced rumor) and fail if any appears. The scan itself is proven able to fail (a leaking recap object turns it red). Roles only.
 */
afterEach(() => { delete process.env.ORWELL_TIME_OF_DAY; });

function rig(seed: number) {
  process.env.ORWELL_TIME_OF_DAY = "1";
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setPlayerKnowledgeReader(() => sb.engine.knowledge.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId, pathway: f.pathway })));
  session.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
  session.setOnEvent((ev) => sb.engine.events.record({
    id: `season:${sb.engine.events.count()}`, ts: sb.engine.events.count(), type: "house-event", initiator: ev.participants[0] ?? PLAYER,
    witnessSet: [PLAYER, ...ev.participants.filter((p) => p !== PLAYER)], hidden: false, content: ev.content,
  }));
  session.createCharacter({ playerName: "The Player", seed });
  return { session, sb };
}

/** Every player-facing string of a recap, lower-cased. */
const textOf = (r: DailyRecapView): string => JSON.stringify({ h: r.highlights, s: r.surfaced, hook: r.hook?.framing }).toLowerCase();
/** The scan under test: which sentinels appear in the recap. */
const leaks = (r: DailyRecapView, sentinels: string[]): string[] => sentinels.filter((s) => textOf(r).includes(s.toLowerCase()));

const SECRET = "SENTINEL-HIDDEN-SECRET-7731";
const HIDDEN_EVENT = "SENTINEL-HIDDEN-SCENE-4410";
const DIARY = "SENTINEL-DIARY-ENTRY-9082";
const RUMOR = "SENTINEL-UNSURFACED-RUMOR-5523";

/** Plant everything the recap must never carry, then close day 1. */
function plantAndClose(seed: number, opts: { strainedDeal?: boolean; surfaced?: string } = {}) {
  const { session, sb } = rig(seed);
  const npcs = session.livingIds().filter((id) => id !== PLAYER);
  const [teller, nominee, hoh, evictee, partner] = npcs;
  const live = (session as unknown as { live: { nominees?: string[]; hoh?: string } }).live;
  live.nominees = [nominee!, evictee!]; live.hoh = hoh!;
  sb.engine.vault.writeHidden({ id: "h-secret", kind: "hidden-attribute", content: SECRET });
  sb.engine.events.record({ id: "hid:1", ts: 9001, type: "scheme", initiator: teller!, witnessSet: [teller!, nominee!], hidden: true, content: HIDDEN_EVENT });
  sb.engine.knowledge.seedBelief(teller!, { content: RUMOR, factId: "gossip:rumor" }, "witnessed"); // diffusing in the hidden layer, never surfaced to the player
  sb.engine.knowledge.recordDiaryRoom(DIARY); // the player's own OOC Diary Room (no in-game pathway to anyone)
  if (opts.surfaced) {
    sb.engine.knowledge.seedBelief(teller!, { content: opts.surfaced, factId: `gossip:${opts.surfaced}` }, "witnessed");
    sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: opts.surfaced }, `told-by:${teller}`);
  }
  if (opts.strainedDeal) (session as unknown as { deals: { make: (...a: unknown[]) => unknown } }).deals.make([PLAYER, partner!], "safety", "we keep each other safe", undefined, 1, { vague: true });
  const recap = session.turnIn().dailyRecap!;
  const nameOf = (id: string) => (session as unknown as { nameOf(id: string): string }).nameOf(id);
  return { session, recap, names: { nominee: nameOf(nominee!), evictee: nameOf(evictee!), hoh: nameOf(hoh!), partner: nameOf(partner!) } };
}

describe("ORW-254 - the scan can fail (so a pass means something)", () => {
  it("a recap that leaks a sentinel is caught", () => {
    const bad: DailyRecapView = { day: 1, highlights: [`${HIDDEN_EVENT} happened`], surfaced: [], hook: { thread: "t", framing: `watch ${SECRET}` } };
    expect(leaks(bad, [SECRET, HIDDEN_EVENT])).toEqual([SECRET, HIDDEN_EVENT]);
  });
});

describe("ORW-254 - the real recap and hint carry only the player's perspective", () => {
  for (const seed of [3, 5, 8]) {
    it(`seed ${seed}: no hidden secret, hidden event, Diary Room entry or unsurfaced rumor; no nominee / HOH / evictee name`, () => {
      const { recap, names } = plantAndClose(seed, { surfaced: "a thing the player was actually told" });
      expect(leaks(recap, [SECRET, HIDDEN_EVENT, DIARY, RUMOR])).toEqual([]);
      expect(leaks(recap, [names.nominee, names.evictee, names.hoh])).toEqual([]);
      expect(recap.surfaced.join(" ")).toContain("actually told"); // positive control: what the player WAS told does appear
      expect(recap.hook).toBeDefined();
    });
  }
  it("a deal under strain gives a hook naming only the player's OWN deal partner, still no spoilers", () => {
    const { recap, names } = plantAndClose(6, { strainedDeal: true });
    expect(recap.hook).toBeDefined();
    expect(recap.hook!.thread.startsWith("deal:")).toBe(true);
    expect(recap.hook!.framing.toLowerCase()).toContain(names.partner.toLowerCase()); // their own deal: their own knowledge
    expect(leaks(recap, [SECRET, HIDDEN_EVENT, DIARY, RUMOR, names.nominee, names.evictee, names.hoh])).toEqual([]);
    for (const banned of ["will win", "wins hoh", "evicted", "goes home", "nominated", "will be"]) expect(recap.hook!.framing.toLowerCase()).not.toContain(banned);
  });
  it("the recap is reproducible and the hint rides its own per-day rng (same seed, same day, same hook)", () => {
    const a = plantAndClose(8, { surfaced: "something heard" }), b = plantAndClose(8, { surfaced: "something heard" });
    expect(a.recap.hook).toEqual(b.recap.hook);
    expect(a.session.dailyRecap()).toEqual(a.recap);
  });
});
