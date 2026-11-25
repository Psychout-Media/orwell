import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import { canBeDrawnTo, BREAKUP, ATTRACTION } from "../../src/engine/attraction";
import { ATTRACTION_LIFE, SHOWMANCE_PACE } from "../../src/engine/attractionLife";
import { paceTick, freshPace, type PaceRecord } from "../../src/engine/showmancePace";
import { HEART, heartAgainstGame, keepAfterHeart, sentimentOf } from "../../src/engine/heartAgainstGame";
import { GRUDGES } from "../../src/engine/grudges";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { playMixGame } from "../../tests/support/houseMixDriver";

/**
 * Feature 0207 (ORW-657..661, the slow build ORW-736, wired ORW-742). Every scenario plays REAL seasons (the house-mix driver: player messages, advanceGame, the house-life ticks) or drives the
 * real writers (`recordInteraction` through the player channel); nothing here sets chemistry, stages, bonds or days by hand. Read-only peeks at engine internals are test-only (as in the
 * other played-season steps). Roles only. The player's presentation is a seeded pick among the three the game allows (never assumed): the steps only read what that run holds.
 */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const PRESENTATIONS = ["woman", "man", "nonbinary"] as const;
type Pres = (typeof PRESENTATIONS)[number];

interface Row { day: number; week: number; pairs: Record<string, { level: number; progress: number; steps: number; shared: number; lastSeen: number }>; stages: Record<string, string>; push: number; pushUnseen: number }
interface Season {
  seed: number; playerGender: Pres | undefined; rows: Row[]; chem: Record<string, number>; npcs: Array<{ id: string; orientation: string; gender: string | undefined }>;
  romanceScenes: Array<{ initiator: string; witnessSet: string[]; seen: number }>; paceRecords: Record<string, { steps: Array<{ day: number; from: number; to: number; seenBy: string[] }> }>;
  surfaces: string; partner: string | undefined; firstDay: Record<string, number>;
  clashed: boolean; clashAt: number; romances: Record<string, number>; breakups: string[]; grudges: Array<{ key: string; kind: string; severity: number }>;
}
const cache = new Map<string, Promise<Season>>();
const MAIN = 800; // the one played season most scenarios read (about a fortnight of in-game days); the others are cut short on purpose

type Romance = "drawn" | "notDrawn" | "none" | "anyone";
function playSeason(seed: number, playerGender: Pres | undefined, messages = MAIN, romance: Romance = "drawn", clash = false): Promise<Season> {
  const key = `${seed}:${playerGender ?? "-"}:${messages}:${romance}:${clash}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const run = (async (): Promise<Season> => {
    const rows: Row[] = [];
    const firstDay: Record<string, number> = {};
    let sess: Any, partner: string | undefined, surfaces = "", clashed = false, clashAt = -1; let clashErr = ""; void clashErr;
    const onMessage = async (call: (n: string, a: Record<string, unknown>) => Promise<unknown>, i: number): Promise<void> => {
      msgNow = i;
      if (i === 120 && romance !== "anyone") surfaces = JSON.stringify(await Promise.all(["getGameState", "gameStatus", "getMomentPrompt", "seasonRecap", "whereabouts"].map((t) => call(t, {}).catch(() => null))));
      if (!playerGender || romance === "none" || i % 40 !== 39 || !sess) return;
      const wa = (await call("whereabouts", {}).catch(() => null)) as { present?: Array<{ id: string }> } | null;
      const present = (wa?.present ?? []).map((x) => x.id).filter((id) => id !== "player");
      const fits = (id: string): boolean => { const n = sess.house?.npcs?.find((x: Any) => x.id === id); return !!n && n.character.genderPresentation !== undefined && canBeDrawnTo((n.character.outOrientation ?? sess.privateOrientations?.[id] ?? "straight"), n.character.genderPresentation, playerGender); };
      const drawn = romance === "anyone" ? present : present.filter((id) => (romance === "drawn" ? fits(id) : !fits(id)));
      if (clash && !clashed && partner && sess.live?.romances?.[partner < "player" ? `${partner}|player` : `player|${partner}`] !== undefined && present.includes(partner)) {
        // the player's own act: a clash with the partner, once the showmance is on record; the engine keeps only the houseguests actually up and in the room, so it is tried again at a later slot until the partner was in it
        await call("recordInteraction", { initiator: "player", witnessSet: ["player", partner], content: "a sharp argument, harsh words", kind: "conflict" }).catch((e: Error) => { clashErr = String(e.message).slice(0, 200); return null; });
        const last = (sess.record?.events?.() ?? []).filter((e: Any) => e.interactionKind === "conflict" && e.initiator === "player").at(-1);
        if (last?.witnessSet?.includes(partner)) { clashed = true; clashAt = i; }
        return;
      }
      if (clashed) return;
      const npc = romance === "anyone" ? (partner && drawn.includes(partner) ? partner : drawn[(i / 40 | 0) % Math.max(1, drawn.length)]) : (partner && drawn.includes(partner) ? partner : drawn[0]);
      if (!npc) return;
      if (romance !== "anyone") partner ??= npc; else partner = npc;
      await call("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "a long warm evening, close and easy", kind: "showmance" }).catch(() => null);
    };
    const onStep = (s: Any): void => {
      sess = s;
      const live = s.live; if (!live) return;
      const day = live.dayNumber ?? 1;
      const pairs: Row["pairs"] = {};
      for (const [pk, rec] of Object.entries(live.showmancePace ?? {}) as Array<[string, Any]>) {
        const [a, b] = pk.split("|") as [string, string];
        const tg = live.together ?? {};
        const shared = Math.max(tg[`chem:${a}>${b}`] ?? 0, tg[`chem:${b}>${a}`] ?? 0) / ATTRACTION_LIFE.stretchesPerDay;
        pairs[pk] = { level: rec.level, progress: rec.progress, steps: rec.steps.length, shared, lastSeen: rec.lastDay };
        firstDay[pk] ??= day;
      }
      const stages: Record<string, string> = {};
      for (const sm of s.seededRels?.showmances ?? []) stages[`${sm.a}|${sm.b}`] = sm.stage;
      let push = 0, pushUnseen = 0;
      if (romance !== "anyone" && live.hoh && live.hoh !== "player") for (const t of live.active) { // (reading the couple weight builds the reader's own-view edges, so the long season does not take it)
        const p = s.couplePushFor(t, live.hoh);
        if (p > 0) { push = Math.max(push, p); if (!live.active.some((o: string) => o !== t && o !== live.hoh && s.romanceSeenBy(live.hoh, t, o))) pushUnseen++; }
      }
      rows.push({ day, week: live.week ?? 1, pairs, stages, push, pushUnseen });
    };
    let out!: Season;
    let msgNow = -1;
    await playMixGame(seed, messages, { advanceEvery: 6, stopWhen: () => clash && clashed && msgNow >= clashAt + 90, ...(playerGender ? { playerGender } : {}), onMessage, onStep, inspect: (s: Any) => {
      const events = s.record?.events?.() ?? [];
      out = {
        seed, playerGender, rows, chem: { ...(s.live?.chemistry ?? {}) },
        npcs: (s.house?.npcs ?? []).map((n: Any) => ({ id: n.id, orientation: n.character.outOrientation ?? s.privateOrientations?.[n.id] ?? "straight", gender: n.character.genderPresentation })),
        romanceScenes: events.filter((e: Any) => e.type === "showmance").map((e: Any) => ({ initiator: e.initiator, witnessSet: [...e.witnessSet], seen: (e.houseLife?.seenBy ?? []).length })),
        paceRecords: JSON.parse(JSON.stringify(s.live?.showmancePace ?? {})), surfaces, partner, firstDay,
        clashed, clashAt, romances: { ...(s.live?.romances ?? {}) }, breakups: [...(s.live?.breakups ?? [])], grudges: Object.entries(s.live?.grudges ?? {}).map(([key, g]: [string, Any]) => ({ key, kind: g.kind, severity: g.severity })),
      };
    } });
    return out;
  })();
  cache.set(key, run);
  return run;
}
const slow = { timeout: 900_000 };
/** The ruling, written out here on purpose (not read from the engine's constants, so a tuned-away rule goes red): the least days a pair spends in each level before the next, at the fastest per-pair pace (a quarter off), and the earliest day a public couple can form. */
const LEAST_DAYS_IN_LEVEL = [3 * 0.75, 4 * 0.75, 5 * 0.75, 6 * 0.75] as const;
const EARLIEST_PUBLIC_DAY = 22;
/**
 * ORW-893: the one played season most scenarios read was pinned at seed 3. The orientation draw is realistic now (about a tenth of a cast, not five in six), so a pinned cast can hold too few drawn pairs for the
 * positive controls these scenarios rely on (chemistry toward the player, seeded showmances, a pair that climbs). The seed is the first from 3 up whose cast, played a short while, holds chemistry toward a
 * player who presents as a woman, chemistry between houseguests, and a seeded showmance: the scan is bounded, deterministic and read off the real engine.
 */
let mainSeedRun: Promise<number> | undefined;
function mainSeed(): Promise<number> {
  return (mainSeedRun ??= (async () => {
    for (let seed = 3; seed <= 30; seed++) {
      const s = await playSeason(seed, "woman", MAIN); // cached: the scenarios then read the same season
      const recs = Object.entries(s.paceRecords);
      if (Object.keys(s.chem).some((k) => k.endsWith(">player")) && recs.some(([, r]) => r.steps.length > 0) && recs.some(([k, r]) => k.includes("player") && r.steps.length > 0)
        && s.rows.some((r) => Object.values(r.stages).length > 0) && s.rows.some((r) => r.push > 0)) return seed;
    }
    return assert.fail("no seed in [3,30] plays a season with chemistry toward the player, a climbing pair, a climbing player pair, a seeded showmance and an HOH weighing a couple");
  })());
}

const bag = (w: unknown): { seasons: Season[]; ctl?: Ctl } => ((w as { s0207?: { seasons: Season[]; ctl?: Ctl } }).s0207 ??= { seasons: [] });

// ------------------------------------------------------------------ the played seasons
Given("a played season in which the player has said how they present", slow, async function () { bag(this).seasons = [await playSeason(await mainSeed(), "woman", MAIN)]; });
Given("played seasons with showmances", slow, async function () { bag(this).seasons = [await playSeason(await mainSeed(), "woman", MAIN)]; });
Given("a played game where the player keeps a romance going over many days", slow, async function () { bag(this).seasons = [await playSeason(await mainSeed(), "woman", MAIN)]; });

const one = (w: unknown): Season => bag(w).seasons[0]!;
const pairKeyOf = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

// A1
Then("pairs with chemistry between them had romance scenes at a higher rate than pairs without", function () {
  const s = one(this);
  const npcIds = s.npcs.map((n) => n.id);
  const withChem = new Set(Object.keys(s.chem).map((k) => { const [f, t] = k.replace(/^chem:/, "").split(">") as [string, string]; return pairKeyOf(f, t); }));

  const counts = new Map<string, number>();
  for (const e of s.romanceScenes) { const w = e.witnessSet.filter((x) => npcIds.includes(x)); if (w.length === 2 && !e.witnessSet.includes("player")) counts.set(pairKeyOf(w[0]!, w[1]!), (counts.get(pairKeyOf(w[0]!, w[1]!)) ?? 0) + 1); }
  let nChem = 0, nNone = 0, sChem = 0, sNone = 0;
  for (let i = 0; i < npcIds.length; i++) for (let j = i + 1; j < npcIds.length; j++) {
    const k = pairKeyOf(npcIds[i]!, npcIds[j]!), c = counts.get(k) ?? 0;
    if (withChem.has(k)) { nChem++; sChem += c; } else { nNone++; sNone += c; }
  }
  assert.ok(nChem > 0 && sChem > 0, "positive control: there were romance scenes between pairs with chemistry");
  assert.ok(sChem / nChem > sNone / Math.max(1, nNone), `rate with chemistry ${(sChem / nChem).toFixed(3)} vs without ${(sNone / Math.max(1, nNone)).toFixed(3)}`);
});
Then("no number or label for attraction reaches the player", function () {
  const blob = one(this).surfaces;
  assert.ok(blob.length > 100, "the player surfaces were read");
  assert.equal(/"chemistry"|"together"\s*:|"attract"|"flirtable"|"drawn"\s*:|chem:|showmancePace|"progress"\s*:|"romances"|"breakups"/i.test(blob), false);
  for (const v of Object.values(one(this).chem)) if (String(v).length > 6) assert.equal(blob.includes(String(v)), false);
});

// A1 player as the object
Then("only houseguests whose own orientation includes the player hold chemistry toward the player", slow, async function () {
  const s = one(this);
  const keys = Object.keys(s.chem).filter((k) => k.endsWith(">player"));
  assert.ok(keys.length > 0, "positive control: some houseguest holds chemistry toward the player");
  for (const k of keys) {
    const id = k.replace(/^chem:/, "").replace(/>player$/, "");
    const n = s.npcs.find((x) => x.id === id)!;
    assert.ok(n.gender !== undefined && canBeDrawnTo(n.orientation as never, n.gender as never, s.playerGender), `${id} holds chemistry toward the player outside their own orientation`);
  }
  for (const n of s.npcs) if (n.gender !== undefined && !canBeDrawnTo(n.orientation as never, n.gender as never, s.playerGender)) assert.equal(s.chem[`chem:${n.id}>player`], undefined);
  // ORW-876: one season holds only a handful of houseguests not drawn to the player, and chemistry is a keyed roll most pairs miss, so one season can pass with the rule broken.
  // The same rule over many real casts (seeds 1-10, every presentation; the engine draws chemistry on the first house-life stretch, so each is played a few messages):
  let notDrawn = 0, drawnWithChem = 0;
  for (const pg of PRESENTATIONS) for (let seed = 1; seed <= 10; seed++) {
    let sess: Any;
    await playMixGame(seed, 30, { user: `s0207-cast-${pg}-${seed}`, playerGender: pg, onStep: (x: Any) => { sess = x; } });
    const chem = sess.live?.chemistry ?? {};
    for (const n of sess.house.npcs) {
      const o = n.character.outOrientation ?? sess.privateOrientations?.[n.id] ?? "straight";
      const has = chem[`chem:${n.id}>player`] !== undefined;
      if (n.character.genderPresentation !== undefined && canBeDrawnTo(o, n.character.genderPresentation, pg)) { if (has) drawnWithChem++; } else { notDrawn++; assert.equal(has, false, `seed ${seed} (${pg}): ${n.id} holds chemistry toward the player outside their own orientation`); }
    }
  }
  assert.ok(notDrawn > 20 && drawnWithChem > 0, `positive control: casts with houseguests not drawn to the player (${notDrawn}) and some drawn ones with chemistry (${drawnWithChem})`);
});
Then("no houseguest started a romance scene with the player on their own", function () {
  for (const e of one(this).romanceScenes) if (e.witnessSet.length === 2 && e.witnessSet.includes("player")) assert.equal(e.initiator, "player");
});
Then("in a season where the player has not said, nobody holds chemistry toward the player", slow, async function () {
  const s = await playSeason(3, undefined, 100);
  assert.equal(Object.keys(s.chem).filter((k) => k.endsWith(">player")).length, 0);
  assert.ok(Object.keys(s.chem).length > 0, "positive control: the houseguests hold chemistry toward each other");
});

// A2
Then("an HOH outside a pair they read as a couple weighs that pair onto the block in some week of the season", function () {
  assert.ok(bag(this).seasons.some((s) => s.rows.some((r) => r.push > 0)), "no HOH in the season read a pair as a couple");
});
Then("a houseguest reads a pair as a couple only from romance they saw or were told of", function () {
  for (const s of bag(this).seasons) for (const r of s.rows) assert.equal(r.pushUnseen, 0);
});

// A3 heart against game (the pure rule; the live fold is driven in the breakup scenario below)
type Ctl = { sentiment: { soft: number; hard: number } };
Given("a houseguest whose showmance tie and alliance tie pull opposite ways at a vote", function () {
  bag(this).ctl = { sentiment: { soft: sentimentOf({ style: "emotional", volatility: 0.5, keeper: false }), hard: sentimentOf({ style: "aggressive", volatility: 0.5, keeper: true }) } };
});
Then("their choice follows whichever tie is stronger for them, by their own nature, and they are shaken either way", function () {
  const { soft, hard } = bag(this).ctl!.sentiment;
  const base = { romanceTie: 0.9, allianceTie: 0.8, mutual: true };
  const a = heartAgainstGame({ ...base, sentiment: soft }), b = heartAgainstGame({ ...base, sentiment: hard });
  assert.ok(a.conflict && b.conflict);
  assert.equal(a.heartWon, true); assert.equal(b.heartWon, false);
  assert.equal(heartAgainstGame({ ...base, romanceTie: HEART.romanceBar - 0.01, sentiment: soft }).conflict, false);
  assert.ok(keepAfterHeart(0.5, a) > 0.5 && keepAfterHeart(0.5, b) < 0.5, "a winning heart adds to the hold, a winning game takes some of it");
  assert.ok(ATTRACTION.coupleNomPush > 0);
});

// A3 breakup, A4: real seasons where the player's own acts are the only writers
Given("a played game where the player and a houseguest have a showmance from the player's own scenes", slow, async function () { (bag(this) as Any).clash = await playSeason(await mainSeed(), "woman", 700, "drawn", true); });
When("the player starts a clash with that houseguest", function () {
  const s = (bag(this) as Any).clash as Season;
  assert.ok(Object.keys(s.romances).some((k) => k.includes("player")), "positive control: the showmance was on record");
  assert.ok(s.partner !== undefined);
});
Then("the grudge book holds a heartbreak deeper than a broken deal's grudge, once", function () {
  const s = (bag(this) as Any).clash as Season;
  // the player's own showmance's heartbreak (the house's own couples may break up in the same season, each with their own row: not this scenario's claim)
  const rows = s.grudges.filter((g) => g.kind === "heartbreak" && g.key.split("|").includes("player"));
  assert.equal(rows.length, 1, `one heartbreak, once: ${JSON.stringify({ r: s.romances, b: s.breakups, p: s.partner, clashed: s.clashAt, kinds: s.grudges.reduce((m: Record<string, number>, g) => ({ ...m, [g.kind]: (m[g.kind] ?? 0) + 1 }), {}) })}`);
  assert.ok(rows[0]!.severity > GRUDGES.DEAL_BREAK_SEVERITY);
  assert.equal(s.breakups.filter((k) => k.includes("player")).length, 1);
  assert.ok(Math.abs(BREAKUP.affinity) > Math.abs(RELATIONSHIP_CONSTANTS.BETRAYAL_SHOCK.affinity!) && Math.abs(BREAKUP.trust) > Math.abs(RELATIONSHIP_CONSTANTS.BETRAYAL_SHOCK.trust!));
});

// A4
Given("a played game where a houseguest started romance scenes toward the player and the player started none", slow, async function () { (bag(this) as Any).theirs = await playSeason(await mainSeed(), "woman", 100, "none"); });
Then("the engine does not hold the player to be in a showmance", function () {
  const s = (bag(this) as Any).theirs as Season;
  assert.ok(Object.keys(s.chem).some((k) => k.endsWith(">player")), "positive control: someone is drawn to the player");
  assert.equal(Object.keys(s.romances).filter((k) => k.includes("player")).length, 0);
});
Then("the player's own showmance scenes, answered by a houseguest drawn to them, make one", slow, async function () {
  const s = await playSeason(await mainSeed(), "woman", 700, "drawn", true);
  assert.ok(Object.keys(s.romances).some((k) => k.includes("player")));
  (bag(this) as Any).away = await playSeason(await mainSeed(), "woman", 700, "notDrawn"); // ORW-876: as long as the drawn season above, which answers in kind; at 160 messages no houseguest answers either way
});
Then("a houseguest whose orientation does not include the player does not answer in kind", function () {
  const s = (bag(this) as Any).away as Season;
  // a romance with the player is fine when the other party IS drawn to them (a drawn houseguest may start one herself); the claim is that none forms with a houseguest the player's gender is outside of
  const drawnTo = (id: string): boolean => { const n = s.npcs.find((x) => x.id === id); return !!n && n.gender !== undefined && canBeDrawnTo(n.orientation as never, n.gender as never, s.playerGender as never); };
  const withNotDrawn = Object.keys(s.romances).filter((k) => k.includes("player")).map((k) => k.split("|").find((x) => x !== "player")!).filter((id) => !drawnTo(id));
  assert.deepEqual(withNotDrawn, [], "a houseguest whose orientation does not include the player answered in kind");
  assert.ok(s.partner !== undefined && !drawnTo(s.partner), "positive control: the player did start scenes with a houseguest not drawn to them");
  assert.ok(!Object.keys(s.romances).some((k) => k.includes("player") && k.includes(s.partner!)), "no romance with the one the player courted");
});

// ORW-736: the slow build, read off real seasons
const seasonsWithRecords = (w: unknown): Season[] => bag(w).seasons;
Then("no pair climbs more than one step at a time", function () {
  let seen = 0;
  for (const s of seasonsWithRecords(this)) {
    const prev: Record<string, number> = {};
    for (const r of s.rows) for (const [k, p] of Object.entries(r.pairs)) { if (prev[k] !== undefined) { assert.ok(Math.abs(p.level - prev[k]!) <= 1, `${k} jumped`); seen++; } prev[k] = p.level; }
  }
  assert.ok(seen > 0, "positive control: pairs were on record");
});
Then("each step up came after the least days that step needs", function () {
  let ups = 0;
  for (const s of seasonsWithRecords(this)) for (const [k, rec] of Object.entries(s.paceRecords)) {
    let since = s.firstDay[k] ?? 1;
    for (const st of rec.steps) {
      const need = LEAST_DAYS_IN_LEVEL[st.from]!;
      if (st.to > st.from) { assert.ok(st.day - since >= need - 1e-9, `${k} climbed ${st.from}>${st.to} after ${st.day - since} days (needs ${need})`); ups++; }
      since = st.day;
    }
  }
  assert.ok(ups > 0, "positive control: some pair climbed");
});
Then("a pair's progress rose only on a day they spent time together", function () {
  let rises = 0;
  for (const s of seasonsWithRecords(this)) {
    const prev: Record<string, { progress: number; shared: number }> = {};
    for (const r of s.rows) for (const [k, p] of Object.entries(r.pairs)) {
      const q = prev[k];
      if (q && p.progress > q.progress + 1e-9) { assert.ok(p.shared > q.shared + 1e-9, `${k} grew with no shared time`); rises++; }
      prev[k] = { progress: p.progress, shared: p.shared };
    }
  }
  assert.ok(rises > 0, "positive control: some pair's progress rose");
});
Then("a pair is sensed before it is noticed and noticed before it is known, and none is known before the late day", function () {
  let multi = 0;
  for (const s of seasonsWithRecords(this)) {
    for (const rec of Object.values(s.paceRecords)) {
      const ups = rec.steps.filter((x) => x.to > x.from).map((x) => x.to);
      if (ups.length >= 1) multi++;
      for (const st of rec.steps) assert.ok(Math.abs(st.to - st.from) === 1, "one step at a time");
      for (let i = 0; i < ups.length; i++) assert.ok(ups[i]! <= i + 1, `a step to level ${ups[i]} came before the steps under it`); // never ahead of the ladder
      const known = rec.steps.find((x) => x.to === 4);
      if (known) assert.ok(known.day >= EARLIEST_PUBLIC_DAY);
    }
    for (const r of s.rows) if (Object.values(r.stages).includes("visible")) assert.ok(r.day >= EARLIEST_PUBLIC_DAY);
  }
  assert.ok(multi > 0, "positive control: some pair climbed in these seasons");
});
Then("no pair was known house-wide in the first week", function () {
  for (const s of seasonsWithRecords(this)) for (const r of s.rows) if (r.week <= 1) assert.equal(Object.values(r.stages).includes("visible"), false);
  assert.ok(seasonsWithRecords(this).some((s) => Object.values(s.rows.at(-1)?.stages ?? {}).length > 0), "positive control: the seasons held seeded showmances");
});
Then("every pair's recorded steps only grew, in order, each naming who had caught it", function () {
  let n = 0;
  for (const s of seasonsWithRecords(this)) {
    const prev: Record<string, number> = {};
    for (const r of s.rows) for (const [k, p] of Object.entries(r.pairs)) { assert.ok(p.steps >= (prev[k] ?? 0)); prev[k] = p.steps; }
    for (const rec of Object.values(s.paceRecords)) {
      for (let i = 1; i < rec.steps.length; i++) { assert.ok(rec.steps[i]!.day >= rec.steps[i - 1]!.day); assert.equal(rec.steps[i]!.from, rec.steps[i - 1]!.to); }
      for (const st of rec.steps) { assert.ok(Array.isArray(st.seenBy)); n++; }
    }
  }
  assert.ok(n > 0, "positive control: steps were recorded");
});
Then("the player's pair climbed under the same minimum days as any other pair", function () {
  const mine = seasonsWithRecords(this).flatMap((s) => Object.entries(s.paceRecords).filter(([k]) => k.includes("player")).map(([k, rec]) => ({ s, k, rec })));
  assert.ok(mine.length > 0, "positive control: the player's romance is on record");
  assert.ok(mine.some((m) => m.rec.steps.length > 0), "the player's pair climbed at least once in the seasons");
  for (const m of mine) { let since = m.s.firstDay[m.k] ?? 1; for (const st of m.rec.steps) { if (st.to > st.from) assert.ok(st.day - since >= LEAST_DAYS_IN_LEVEL[st.from]! - 1e-9); since = st.day; } }
});
Then("the player's pair did not move on a day the player spent no time with them", function () {
  for (const s of seasonsWithRecords(this)) {
    const prev: Record<string, { progress: number; shared: number }> = {};
    for (const r of s.rows) for (const [k, p] of Object.entries(r.pairs)) {
      if (!k.includes("player")) continue;
      const q = prev[k];
      if (q && p.progress > q.progress + 1e-9) assert.ok(p.shared > q.shared + 1e-9);
      prev[k] = { progress: p.progress, shared: p.shared };
    }
  }
});

// ORW-876: the played seasons above reach the first step or two at most (no played season reaches the public couple before the crown, ORW-736), so the later
// rules are read on the pace rule itself, run day by day for a pair together every day, fully noticed: the engine's own paceTick, nothing set on a game.
function paceRun(factor = 1, days = 60): { states: PaceRecord[] } {
  const states: PaceRecord[] = [];
  let rec = freshPace(1, 0);
  const house = Array.from({ length: 12 }, (_, i) => `npc:${i + 1}`);
  for (let day = 1; day <= days; day++) {
    rec = paceTick(rec, { day, shared: day, mutualChemistry: 1, inCrisis: false, observers: house, room: house.length, closeObservers: 2, factor });
    states.push(rec);
  }
  return { states };
}
const steps = (st: PaceRecord[]) => st.at(-1)!.steps;
Then("the pace rule itself, run day by day for a pair together every day, climbs one step at a time and never before the least days", function () {
  for (const factor of [1 - SHOWMANCE_PACE.jitter, 1, 1 + SHOWMANCE_PACE.jitter]) {
    const all = steps(paceRun(factor).states);
    assert.ok(all.filter((x) => x.to > x.from).length >= 4, "positive control: the pair climbed all the way");
    let since = 1;
    for (const st of all) { assert.equal(Math.abs(st.to - st.from), 1, "one step at a time"); if (st.to > st.from) assert.ok(st.day - since >= (SHOWMANCE_PACE.minDays as readonly number[])[st.from]! * factor - 1e-9, `${st.from}>${st.to} after ${st.day - since} days`); since = st.day; }
  }
});
Then("the pace rule itself, run day by day, makes no public couple before the late day", function () {
  const known = steps(paceRun().states).find((x) => x.to === 4);
  assert.ok(known, "positive control: the pair became a public couple");
  assert.ok(known.day >= SHOWMANCE_PACE.publicNotBeforeDay && known.day >= EARLIEST_PUBLIC_DAY, `public on day ${known.day}`);
});
Then("the pace rule itself, run day by day, steps sensed, then noticed, then known, in order", function () {
  const ups = steps(paceRun().states).filter((x) => x.to > x.from).map((x) => x.to);
  assert.deepEqual(ups.slice(0, 4), [1, 2, 3, 4]);
});
Then("the pace rule itself, run day by day, only ever adds to a pair's steps", function () {
  const { states } = paceRun();
  for (let i = 1; i < states.length; i++) {
    assert.ok(states[i]!.steps.length >= states[i - 1]!.steps.length, `day ${i + 1}: steps went from ${states[i - 1]!.steps.length} to ${states[i]!.steps.length}`);
    assert.deepEqual(states[i]!.steps.slice(0, states[i - 1]!.steps.length), states[i - 1]!.steps, "earlier steps unchanged");
  }
  assert.ok(steps(states).length >= 4, "positive control: steps were recorded");
});
void When; void ATTRACTION_LIFE;
