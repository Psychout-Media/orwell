import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { RelationshipModel } from "../../src/engine/relationships";
import { JURY_HOUSE } from "../../src/engine/juryHouseConstants";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EdgeRecord } from "../../src/domain/saveState";
import { assertNoSentinels } from "../../tests/support/assertions";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0100 — the adapter `juryHouseTick` + the orchestrator wiring + the CALIBRATION-NEUTRALITY
 * gate (the `campaignExecution0085` / `trajectoryOutcomeNeutral` sibling). Roles only: a-finalist /
 * a-betrayed-juror / jurors / the-player. SELF-GATED: OFF ⇒ zero draws, no grudge, byte-identical.
 */

// The cast is the player + 15 NPCs (npc:1..npc:15). The two finalists are still-living NPCs that are
// NOT in the jury; the last-nine NPC evictees are the jury (npc:1..npc:9). The player is NOT among the
// jurors (a player-juror is excluded from the grudge computation — they form their own read, ADR 0003).
const FINALIST = npc(14);
const OTHER_FINALIST = npc(15);
const JURORS: EntityId[] = Array.from({ length: 9 }, (_, i) => npc(i + 1));
// PO ruling 2026-11-03: only jurors belong in the jury house. Of the 14 evictions in a 16-person cast, the first
// `cast − 2 − 9 = 5` are pre-jury (they go home) and the last nine are the jury. The cast is the player + npc:1..15, so the
// real pre-jury slots are npc:10..13 and the player (jurors npc:1..9, finalists npc:14/15). The crafted eviction orders put
// them first so the jurors sit at the jury-start index.
const PRE_JURY: EntityId[] = [npc(10), npc(11), npc(12), npc(13), PLAYER];
// A real jury never exceeds nine, so the "arrivals past the ninth" tests use ids outside the cast on purpose.
const EXTRA_JURORS: EntityId[] = [npc(101), npc(102), npc(103)];

/** Craft a jury-PHASE live state (sequester, not yet the finale) with a jury + recorded grievance. */
function juryPhaseLive(grievanceJuror: EntityId): LiveSeasonState {
  return {
    week: 9,
    beat: "hoh-competition", // mid-sequester: the main game is still running with the two finalists +…
    active: [FINALIST, OTHER_FINALIST],
    vetoUsed: false,
    evictionOrder: [...PRE_JURY, ...JURORS], // five pre-jury evictees, then the last-nine — the jury house operates on the latter
    finished: false,
    // The grievance recorded at the betrayed juror's eviction (the manner baseline the room spreads).
    mannerByEvictee: { [grievanceJuror]: { [FINALIST]: { betrayed: true } } },
  };
}

/** Juror↔juror edges: the betrayed juror (npc 1) bonded to a close juror (npc 2); npc 9 isolated. */
function juryEdges(): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  const e = (from: EntityId, to: EntityId, affinity: number): EdgeRecord => ({
    from, to, trust: affinity * 0.7, affinity, threat: 0.1, alignment: 0.3, confidence: 0.5, reliability: 0.3,
  });
  for (const a of JURORS) for (const b of JURORS) {
    if (a === b) continue;
    edges.push(e(a, b, 0.1)); // a low ambient acquaintance everywhere (below the gossip edge)
  }
  // Make npc1↔npc2 a strong bond (the grievance travels along it).
  for (const rec of edges) {
    if ((rec.from === npc(1) && rec.to === npc(2)) || (rec.from === npc(2) && rec.to === npc(1))) {
      rec.affinity = 0.9; rec.trust = 0.6;
    }
  }
  return edges;
}

/** Stand up a started game and RESTORE a crafted jury-phase snapshot (jury + manner + edges). */
function juryPhaseGame(user: string, seed: number): { reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]> } {
  const reg = new GameSessionRegistry();
  const session = reg.sandboxFor(user).session;
  session.createCharacter({ playerName: "The Player", seed });
  const snap = reg.snapshot(user) as SessionSnapshot;
  snap.live = juryPhaseLive(npc(1));
  snap.relationships = juryEdges();
  reg.restore(user, snap);
  return { reg, sb: reg.sandboxFor(user) };
}

describe("0100 — juryHouseTick is OFF by default (byte-identical: zero draws, no grudge)", () => {
  it("a disabled jury house is a no-op — no jury-house scene, no grudge, the dedicated stream never advances", () => {
    const { sb } = juryPhaseGame("off", 11);
    sb.session.setJuryHouseEnabled(false); // explicit OFF (default flip 2026-11-03)
    const before = sb.engine.events.count();
    // Default OFF (the calibration harness never enables it).
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.engine.events.count(), "no jury-house events recorded when off").toBe(before);
    const live = sb.session.snapshot().live as LiveSeasonState;
    expect(live.juryGrudge, "no grudge accumulated when off").toBeUndefined();
    // The dedicated tick counter never advanced (it is not even persisted ⇒ absent).
    expect(sb.session.snapshot().juryHouseTickCount).toBeUndefined();
  });
});

describe("0100 — when enabled, the jury house lives and the grudge accumulates (engine-owned)", () => {
  it("produces hidden juror scenes (player never witnessed) and accumulates a bounded grudge", () => {
    const { sb } = juryPhaseGame("on", 12);
    sb.session.setJuryHouseEnabled(true);
    const before = sb.engine.events.count();
    for (let t = 0; t < 12; t++) sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    const produced = sb.engine.events.queryAll().slice(before);
    expect(produced.length, "the jury house produced hidden scenes").toBeGreaterThan(0);
    for (const ev of produced) {
      expect(ev.hidden, "every jury-house scene is hidden").toBe(true);
      expect(ev.witnessSet, "the player NEVER witnesses a jury-house scene").not.toContain(PLAYER);
    }
    const live = sb.session.snapshot().live as LiveSeasonState;
    // The close juror (npc 2) was soured by the betrayed juror (npc 1) — a bounded, capped grudge.
    const closeGrudge = live.juryGrudge?.[npc(2)]?.[FINALIST] ?? 0;
    expect(closeGrudge, "the close juror's grudge toward the responsible finalist grew").toBeGreaterThan(0);
    expect(closeGrudge, "and stays within the saturation bound").toBeLessThanOrEqual(JURY_HOUSE.adjustmentCap);
    // The isolated juror (npc 9) never picked up a grudge (no pathway — the omniscience ban).
    expect(live.juryGrudge?.[npc(9)]?.[FINALIST] ?? 0).toBe(0);
    // The dedicated stream advanced; the counter persists.
    expect(sb.session.snapshot().juryHouseTickCount).toBeGreaterThan(0);
  });

  it("the accumulated grudge is MONOTONIC + SATURATED across many ticks (never runs away)", () => {
    const { sb } = juryPhaseGame("sat", 5);
    sb.session.setJuryHouseEnabled(true);
    let prev = 0;
    for (let t = 0; t < 60; t++) {
      sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
      const g = (sb.session.snapshot().live as LiveSeasonState).juryGrudge?.[npc(2)]?.[FINALIST] ?? 0;
      expect(g, "grudge only deepens (monotonic)").toBeGreaterThanOrEqual(prev);
      expect(g, "grudge never exceeds the saturation cap").toBeLessThanOrEqual(JURY_HOUSE.adjustmentCap + 1e-9);
      prev = g;
    }
    // Over many ticks it genuinely SATURATES (reaches the cap), proving the bound bites.
    expect(prev, "a well-connected, long sequester saturates the grudge at the cap").toBeCloseTo(JURY_HOUSE.adjustmentCap, 6);
  });
});

describe("0100 — persistence: the accumulated grudge survives a restart intact (non-degradation)", () => {
  it("a restored mid-jury game resumes with the bitterness + the dedicated stream intact", () => {
    const { reg, sb } = juryPhaseGame("persist", 7);
    sb.session.setJuryHouseEnabled(true);
    for (let t = 0; t < 10; t++) sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    const beforeGrudge = (sb.session.snapshot().live as LiveSeasonState).juryGrudge;
    const beforeTick = sb.session.snapshot().juryHouseTickCount;
    expect(beforeGrudge, "a grudge accumulated").toBeTruthy();

    // Round-trip through a fresh adapter (the restart path).
    const revived = new GameSessionAdapter();
    revived.restore(sb.session.snapshot());
    expect((revived.snapshot().live as LiveSeasonState).juryGrudge, "grudge restored intact").toEqual(beforeGrudge);
    expect(revived.snapshot().juryHouseTickCount, "dedicated stream counter restored").toBe(beforeTick);
    void reg;
  });
});

describe("0100 — the Vault Wall holds for the player AND admin (no grudge/scene/lean crosses)", () => {
  it("no jury-house secret reaches any player-facing or admin/God-Mode surface", () => {
    const { reg, sb } = juryPhaseGame("vault", 9);
    sb.session.setJuryHouseEnabled(true);
    // FULLY populate the Vault with sentinels of every hidden kind (mirrors the 0001 canary; extends it
    // over the live jury-house path) AND a genuinely off-screen jury-house-flavored hidden scene.
    const sentinels: string[] = [];
    const addHidden = (kind: import("../../src/ports/VaultStore").HiddenKind, n: number): void => {
      const s = `SENTINEL-0100-${kind}-${n}`;
      sentinels.push(s);
      sb.engine.vault.writeHidden({ id: `vault:0100:${kind}:${n}`, kind, content: `[${kind}] secret ${s}` });
    };
    for (let i = 1; i <= 3; i++) addHidden("hidden-attribute", i);
    for (let i = 1; i <= 3; i++) addHidden("confessional", i);
    addHidden("reserved-twist", 1);

    // Run the jury house so real grudges + hidden scenes accumulate.
    for (let t = 0; t < 10; t++) sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    reg.sandboxFor("vault").syncAdmin();

    // Sweep every player-facing surface…
    const p = sb.player;
    const playerBlob = [
      p.produce("player-visible log"),
      p.produce("scene narration"),
      JSON.stringify(p.assembleNarrationContext("scene")),
      JSON.stringify(p.getVisibleState()),
      p.socialRead(),
      JSON.stringify(sb.session.gameStatus()),
      JSON.stringify(sb.session.whereabouts()),
    ].join("\n---\n");
    // …and every admin / God-Mode surface.
    const adminBlob = JSON.stringify(sb.admin.inspect());

    // No Vault sentinel anywhere.
    assertNoSentinels(playerBlob, sentinels);
    assertNoSentinels(adminBlob, sentinels);
    // No grudge number / jury-house lean field on any surface (structural, by shape).
    for (const blob of [playerBlob, adminBlob]) {
      expect(blob, "no grudge/lean field on a player- or admin-facing surface")
        .not.toMatch(/juryGrudge|grudge|"lean"|"manner"/i);
    }
  });
});

describe("0100 — calibration neutrality: the orchestrator's shared rng stream is untouched", () => {
  // The dedicated jury-house rng never draws from the orchestrator's per-user stream, so a full
  // off-screen tick sequence over a jury-phase game produces a BYTE-IDENTICAL main-house outcome whether
  // the layer is OFF or ON — only ADDITIVE hidden jury-house events + the separate grudge differ. We SHA256
  // the MAIN-HOUSE state (the events the shared stream produced + the relationship beliefs the seeded
  // competition/vote spine reads) and assert OFF == ON. This is the per-unit counterpart of the heavy
  // juryReach byte-identity gate (the calibration harness never sets the flag).

  /** A jury-house event id is `offscreen:<type>:…`; the betrayed-juror grievance gloss is a `gossip` belief
   *  the diffusion records. We isolate the MAIN-house additions by EXCLUDING the jury-house tick's output.
   *  Cleaner: compare runs where the ONLY difference is the flag, hashing the shared-stream-driven state. */
  function shaMainHouse(seed: number, enableJuryHouse: boolean): string {
    const reg = new GameSessionRegistry();
    const user = "jh-rel-neutral"; // same user name across OFF/ON so only the flag differs
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed });
    // Move into sequester WITH a genuine grievance so a grudge actually accumulates when ON — proving the
    // grudge lands in the SEPARATE map, NOT in the live relationship edges the vote spine reads.
    const snap = reg.snapshot(user) as SessionSnapshot;
    snap.live = juryPhaseLive(npc(1));
    snap.relationships = juryEdges();
    reg.restore(user, snap);
    const sb2 = reg.sandboxFor(user);
    sb2.session.setJuryHouseEnabled(enableJuryHouse);
    // Drive the jury-house tick repeatedly. When ON it draws from its OWN forked stream and folds NO live
    // edge — so the relationship beliefs the seeded competition/vote spine reads stay byte-identical.
    for (let t = 0; t < 15; t++) sb2.session.juryHouseTick(sb2.engine.events, sb2.engine.knowledge);
    // The relationship beliefs round-trip on the registry's SessionSnapshot (the vote spine reads them).
    const rels = ((reg.snapshot(user) as SessionSnapshot).relationships ?? [])
      .map((e: EdgeRecord) => `${e.from}|${e.to}|${e.trust}|${e.affinity}|${e.threat}|${e.alignment}|${e.reliability ?? ""}`)
      .sort();
    return createHash("sha256").update(JSON.stringify(rels)).digest("hex");
  }

  it("the relationship state the vote spine reads is BYTE-IDENTICAL with the jury house OFF vs ON (no live-edge fold)", () => {
    // Sanity: the ON run DID accumulate a grudge (the test isn't vacuous) — proven separately above; here
    // we assert the live RELATIONSHIP edges are untouched (the grudge lives in the separate juryGrudge map).
    for (const seed of [1, 7, 42]) {
      const off = shaMainHouse(seed, false);
      const on = shaMainHouse(seed, true);
      expect(on, `seed ${seed}: jury house ON must not move any relationship edge the vote spine reads`).toBe(off);
    }
  });

  it("with the flag OFF, no dedicated draw is taken (the stream counter stays 0)", () => {
    const { sb } = juryPhaseGame("nodraw", 3);
    sb.session.setJuryHouseEnabled(false); // explicit OFF (default flip 2026-11-03)
    for (let t = 0; t < 20; t++) sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().juryHouseTickCount, "the dedicated stream never advanced when off").toBeUndefined();
  });

  /**
   * The WHOLE-PIPELINE byte-identity proof (the recording-rng / SHA256 gate the spec requires): drive the
   * REAL orchestrator off-screen tick (`defaultApply`, which now calls `juryHouseTick`) over a full game
   * from the start. With the jury house ON but NO jury yet (the self-gate ⇒ a no-op), the entire seeded
   * pipeline — every shared-rng draw, every recorded event, every relationship belief, the whole snapshot —
   * is BYTE-IDENTICAL to the flag-OFF run. This is exactly the property the heavy `juryReach` gate rests on:
   * the calibration harness never sets the flag, and even a process that DID set it is byte-identical until
   * a jury forms (and after that, only the hidden jury lean changes — proven by the relationship test above).
   */
  function shaWholeSnapshot(seed: number, enableJuryHouse: boolean): string {
    const reg = new GameSessionRegistry();
    const orch = new Orchestrator(reg, { now: () => seed }, { seed });
    // The per-user rng is keyed by seed+USER, so OFF and ON MUST share the SAME user name (in their own
    // fresh registries) — the ONLY difference between the two runs is the jury-house flag.
    const user = "jh-neutral";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed });
    sb.session.setJuryHouseEnabled(enableJuryHouse);
    // Drive the real off-screen tick path (defaultApply → juryHouseTick) many times on a PRE-jury house,
    // where the jury-house self-gate makes it a no-op ⇒ the shared draw stream is provably untouched.
    for (let t = 0; t < 30; t++) orch.advance(user, "offscreen-tick");
    // SHA256 the ENTIRE engine-only snapshot (events + relationships + souls + everything) — a single bit
    // of shared-stream divergence would change the hash.
    return createHash("sha256").update(JSON.stringify(sb.session.snapshot())).digest("hex");
  }

  it("the WHOLE seeded pipeline is byte-identical (SHA256) with the jury house OFF vs ON before a jury forms", () => {
    for (const seed of [1, 7, 42]) {
      const off = shaWholeSnapshot(seed, false);
      const on = shaWholeSnapshot(seed, true);
      expect(on, `seed ${seed}: enabling the jury house must not perturb the seeded pipeline before a jury exists`).toBe(off);
    }
  });
});

describe("0100 — FAST-FORWARD LIMBO (owner ruling 2026-11-02, #1922): one short stretch per new juror", () => {
  /** A jury-phase game whose jury holds only the first `n` jurors (more arrive by `arrive`). */
  function growingJury(user: string, seed: number, n: number) {
    const { reg, sb } = juryPhaseGame(user, seed);
    const snap = reg.snapshot(user) as SessionSnapshot;
    (snap.live as LiveSeasonState).evictionOrder = [...PRE_JURY, ...JURORS.slice(0, n)];
    reg.restore(user, snap);
    const s = reg.sandboxFor(user);
    s.session.setJuryHouseEnabled(true);
    const arrive = (k: number): void => {
      const next = reg.snapshot(user) as SessionSnapshot;
      const live = next.live as LiveSeasonState;
      live.evictionOrder = [...PRE_JURY, ...JURORS.slice(0, (live.evictionOrder ?? []).length - PRE_JURY.length + k)];
      reg.restore(user, next);
      reg.sandboxFor(user).session.setJuryHouseEnabled(true);
    };
    return { reg, sbOf: () => reg.sandboxFor(user), arrive, first: s };
  }
  const juryScenes = (sb: ReturnType<GameSessionRegistry["sandboxFor"]>) =>
    sb.engine.events.queryAll().filter((e) => e.hidden && e.witnessSet.every((w) => JURORS.includes(w as EntityId)));

  it("runs once per arrival: repeated ticks with no new juror are no-ops (no scenes, no draws)", () => {
    const { sbOf } = growingJury("limbo-noop", 21, 3);
    const sb = sbOf();
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    const tick = sb.session.snapshot().juryHouseTickCount;
    const events = sb.engine.events.count();
    expect(tick, "one stretch per juror past the first").toBe(2);
    for (let t = 0; t < 20; t++) sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.engine.events.count(), "no new jury-house life without a new juror").toBe(events);
    expect(sb.session.snapshot().juryHouseTickCount).toBe(tick);
  });

  it("a legacy save whose arrival counter ran AHEAD (it counted pre-jury evictions) replays the newest juror's stretch once, then settles", () => {
    const { reg, sbOf } = growingJury("limbo-legacy", 22, 3);
    // A pre-membership-fix save counted every eviction as an arrival: 5 pre-jury + 3 jurors = 8, ahead of the 3 jurors.
    const snap = reg.snapshot("limbo-legacy") as SessionSnapshot;
    snap.juryHouseArrivals = 8;
    snap.juryHouseTickCount = 5;
    reg.restore("limbo-legacy", snap);
    reg.sandboxFor("limbo-legacy").session.setJuryHouseEnabled(true);
    const sb = sbOf();
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    const after = sb.session.snapshot();
    expect(after.juryHouseArrivals, "settled to the juror count").toBe(3);
    expect(after.juryHouseTickCount, "exactly one replayed stretch").toBe(6);
    for (let t = 0; t < 10; t++) sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().juryHouseTickCount, "and never again").toBe(6);
  });

  it("each arrival plays 1–3 hidden juror scenes, and a double eviction plays both owed stretches", () => {
    const { sbOf, arrive } = growingJury("limbo-arrive", 22, 2);
    let sb = sbOf();
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    let seen = juryScenes(sb).length;
    expect(seen, "the first stretch played").toBeGreaterThanOrEqual(1);
    expect(seen).toBeLessThanOrEqual(3);
    arrive(2); // a double eviction: two jurors at once
    sb = sbOf();
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().juryHouseTickCount, "both owed stretches ran").toBe(3);
    const added = juryScenes(sb).length - seen;
    expect(added).toBeGreaterThanOrEqual(2);
    expect(added).toBeLessThanOrEqual(6);
    seen += added;
  });

  it("arrivals past the ninth juror still play their stretch (the roster is capped, arrivals are not)", () => {
    const { reg, sbOf } = growingJury("limbo-late", 24, 9);
    let sb = sbOf();
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().juryHouseTickCount, "eight stretches for jurors two through nine").toBe(8);
    // Three more evictions (a rolling last-nine roster): each still owes a stretch.
    const snap = reg.snapshot("limbo-late") as SessionSnapshot;
    (snap.live as LiveSeasonState).evictionOrder = [...PRE_JURY, ...JURORS, ...EXTRA_JURORS];
    reg.restore("limbo-late", snap);
    sb = sbOf();
    sb.session.setJuryHouseEnabled(true);
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().juryHouseTickCount, "the late arrivals each played a stretch").toBe(11);
    expect(sb.session.snapshot().juryHouseArrivals).toBe(12);
  });

  it("a pre-limbo save (rng counter only, no arrival marker) resumes on the next eviction", () => {
    const { reg } = growingJury("limbo-legacy", 25, 9);
    const snap = reg.snapshot("limbo-legacy") as SessionSnapshot;
    snap.juryHouseTickCount = 40; // the old per-tick counter
    delete snap.juryHouseArrivals;
    reg.restore("limbo-legacy", snap);
    let sb = reg.sandboxFor("limbo-legacy");
    sb.session.setJuryHouseEnabled(true);
    const before = sb.engine.events.count();
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.engine.events.count(), "caught up: no replay of past arrivals").toBe(before);
    const next = reg.snapshot("limbo-legacy") as SessionSnapshot;
    (next.live as LiveSeasonState).evictionOrder = [...PRE_JURY, ...JURORS, EXTRA_JURORS[0]!];
    reg.restore("limbo-legacy", next);
    sb = reg.sandboxFor("limbo-legacy");
    sb.session.setJuryHouseEnabled(true);
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().juryHouseTickCount, "the next eviction ran one stretch").toBe(41);
  });

  it("an in-place season restart clears the arrival watermark (the new season's jurors get their stretches)", () => {
    const { reg, sbOf } = growingJury("limbo-restart", 26, 9);
    const sb = sbOf();
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    const played = reg.snapshot("limbo-restart") as SessionSnapshot;
    expect(played.juryHouseArrivals).toBe(9);
    // The STANDALONE in-place restart (no registry restart hinge): the same adapter starts a new season.
    const standalone = new GameSessionAdapter();
    standalone.restore(played);
    standalone.createCharacter({ playerName: "The Player", seed: 27, confirmRestart: true });
    const fresh = standalone.snapshot();
    expect(fresh.juryHouseArrivals, "a fresh season has processed no arrivals").toBeUndefined();
    expect(fresh.juryHouseTickCount, "and its dedicated stream restarts").toBeUndefined();
    // The registry path swaps in a brand-new sandbox, which starts clean too.
    sb.session.createCharacter({ playerName: "The Player", seed: 27, confirmRestart: true });
    expect(sbOf().session.snapshot().juryHouseArrivals).toBeUndefined();
  });

  it("an arrival's stretch waits until the eviction stage (goodbyes, exit interview) has closed", () => {
    const { reg } = growingJury("limbo-goodbye", 28, 2);
    const snap = reg.snapshot("limbo-goodbye") as SessionSnapshot;
    const live = snap.live as LiveSeasonState;
    live.evictionOrder = [...PRE_JURY, ...JURORS.slice(0, 3)];
    // The third juror's eviction is still mid-stage (goodbyes not yet given).
    live.eviction = {
      stage: "goodbye", nominees: [npc(3), FINALIST], revealOrder: [], voteOf: {}, revealIx: 0,
      evictee: npc(3), goodbyeFrom: [], goodbyeIx: 0,
    } as unknown as LiveSeasonState["eviction"];
    reg.restore("limbo-goodbye", snap);
    let sb = reg.sandboxFor("limbo-goodbye");
    sb.session.setJuryHouseEnabled(true);
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().juryHouseArrivals ?? 0, "no stretch while the goodbyes are pending").toBeLessThan(3);
    // The stage closes (goodbyes done): the next tick runs the owed stretch, reading the final manner.
    const done = reg.snapshot("limbo-goodbye") as SessionSnapshot;
    delete (done.live as LiveSeasonState).eviction;
    reg.restore("limbo-goodbye", done);
    sb = reg.sandboxFor("limbo-goodbye");
    sb.session.setJuryHouseEnabled(true);
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().juryHouseArrivals).toBe(3);
  });

  it("a re-told grievance reunites with the room's belief instead of piling up copies", () => {
    const { sbOf } = growingJury("limbo-dedup", 23, 9);
    const sb = sbOf();
    sb.session.juryHouseTick(sb.engine.events, sb.engine.knowledge); // 8 owed stretches, one grievance
    for (const juror of JURORS) {
      const copies = sb.engine.knowledge.knownTo(juror).filter((k) => k.factId === `jury-grievance:${npc(1)}:${FINALIST}`);
      expect(copies.length, `juror holds the grievance at most once`).toBeLessThanOrEqual(1);
    }
  });
});
