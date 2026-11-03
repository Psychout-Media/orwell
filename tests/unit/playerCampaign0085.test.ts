import { flagDefaultOn } from "../../src/domain/flagDefaults";
import { describe, it, expect } from "vitest";
import { advancePlayerCampaign, CAMPAIGN, type Campaign } from "../../src/engine/campaigns";
import { RelationshipModel } from "../../src/engine/relationships";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { buildSandbox } from "../support/sandbox";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Phase 2 of "the player can play offense" (0085 follow-on) — wiring the PLAYER into the campaign
 * machinery: a LANDED evict-shaped pitch (`recordInteraction`'s `aboutEdges`, Phase 1) grows a real,
 * bounded, persistent campaign the player owns, mirroring `formCampaigns`/`advanceCampaign`/
 * `campaignTilt` so the player's offense reads on equal footing with an NPC's. Roles only (no names).
 *
 * Invariants under test:
 *  • `campaignActors()`/`formCampaigns()` still never form one FOR the player — only the player's own
 *    LANDED recorded move does (the spec's "never mind control" rule).
 *  • A backfired pitch grows nothing (I2 — a social move that fails moves nothing, campaign included).
 *  • Self-gated by the SAME `campaignsEnabled` flag as the rest of 0085 — off by default, byte-identical.
 *  • Bounded: progress accrues at most once per beat regardless of how many holders are pitched in one
 *    scene (the NPC-cadence parity bound flagged as a balance risk).
 *  • The resulting tilt feeds the SAME `campaignTiltFor`/`voteChoice` mechanism an NPC's campaign uses,
 *    and stays bounded to the SAME ceiling (`CAMPAIGN.base`) — never a stronger channel than an NPC's.
 */

class ScriptedRandom implements RandomnessSource {
  private i = 0;
  constructor(private readonly seq: readonly number[]) {}
  next(): number {
    const v = this.seq[this.i % this.seq.length]!;
    this.i++;
    return v;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  fork(): RandomnessSource {
    return this;
  }
}

const owner = npc(9); // the campaign owner in the pure-function tests below (role-neutral id)
const target = npc(2);
const holder = npc(1);
const otherHolder = npc(3);

describe("Phase 2 — advancePlayerCampaign (pure function)", () => {
  it("creates a fresh campaign on the first landed pitch — owner+holder both known, progress accrued", () => {
    const rng = new SeededRandom(5);
    const c = advancePlayerCampaign(undefined, owner, target, holder, 10, rng, true);
    expect(c).toMatchObject({ owners: [owner], goal: "evict", target, status: "active", startedBeat: 10 });
    expect(c.knownTo).toEqual(expect.arrayContaining([owner, holder]));
    expect(c.progress).toBeGreaterThan(0);
  });

  it("continuing the same target accrues MORE progress and adds a new holder to knownTo", () => {
    const rng = new SeededRandom(5);
    const c1 = advancePlayerCampaign(undefined, owner, target, holder, 10, rng, true);
    const c2 = advancePlayerCampaign(c1, owner, target, otherHolder, 11, rng, true);
    expect(c2.progress).toBeGreaterThan(c1.progress);
    expect(c2.knownTo).toEqual(expect.arrayContaining([owner, holder, otherHolder]));
  });

  it("awardProgress=false grows knownTo but NOT progress (the per-beat throttle's shape)", () => {
    const rng = new SeededRandom(5);
    const c1 = advancePlayerCampaign(undefined, owner, target, holder, 10, rng, true);
    const c2 = advancePlayerCampaign(c1, owner, target, otherHolder, 10, rng, false);
    expect(c2.progress).toBe(c1.progress); // no extra progress this beat
    expect(c2.knownTo).toContain(otherHolder); // but awareness still spread
  });

  it("re-aiming at a NEW target starts a fresh campaign at zero progress", () => {
    const rng = new SeededRandom(5);
    const c1 = advancePlayerCampaign(undefined, owner, target, holder, 10, rng, true);
    const newTarget = npc(4);
    const c2 = advancePlayerCampaign(c1, owner, newTarget, holder, 12, rng, true);
    expect(c2.target).toBe(newTarget);
    expect(c2.progress).toBeGreaterThan(0);
    expect(c2.progress).toBeLessThan(1); // fresh single-move progress, not carried over
    expect(c2.knownTo).toEqual([owner, holder]); // fresh knownTo, not the old campaign's accumulated set
  });

  it("a lapsed deadline (beat >= deadlineBeat) starts fresh even at the SAME target", () => {
    const rng = new SeededRandom(5);
    const c1 = advancePlayerCampaign(undefined, owner, target, holder, 0, rng, true);
    const lapsed = advancePlayerCampaign(c1, owner, target, otherHolder, c1.deadlineBeat, rng, true);
    expect(lapsed.startedBeat).toBe(c1.deadlineBeat);
    expect(lapsed.knownTo).toEqual([owner, otherHolder]); // fresh, not accumulated from the lapsed run
  });

  it("progress is bounded to [0,1] even across many landed pitches", () => {
    const rng = new SeededRandom(9);
    let c: Campaign | undefined;
    for (let i = 0; i < 40; i++) c = advancePlayerCampaign(c, owner, target, holder, i, rng, true);
    expect(c!.progress).toBeLessThanOrEqual(1);
    expect(c!.progress).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic — the same seed + inputs fold the identical progress", () => {
    const a = advancePlayerCampaign(undefined, owner, target, holder, 3, new SeededRandom(42), true);
    const b = advancePlayerCampaign(undefined, owner, target, holder, 3, new SeededRandom(42), true);
    expect(a).toEqual(b);
  });

  it("never mutates the campaign passed in", () => {
    const rng = new SeededRandom(5);
    const c1 = advancePlayerCampaign(undefined, owner, target, holder, 10, rng, true);
    const before = { ...c1, knownTo: [...c1.knownTo] };
    advancePlayerCampaign(c1, owner, target, otherHolder, 11, rng, true);
    expect(c1).toEqual(before);
  });
});

describe("Phase 2 — GameSessionAdapter.foldPlayerCampaignMove (the live adapter)", () => {
  it("is a no-op (zero campaigns) when the campaign layer is EXPLICITLY OFF", () => {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(false); // explicit OFF (default flip 2026-11-03)
    session.foldPlayerCampaignMove(target, holder);
    expect((session as unknown as { campaigns: Campaign[] }).campaigns).toHaveLength(0);
  });

  it("creates a real PLAYER-owned campaign when enabled", () => {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(true);
    session.foldPlayerCampaignMove(target, holder);
    const camps = (session as unknown as { campaigns: Campaign[] }).campaigns;
    expect(camps).toHaveLength(1);
    expect(camps[0]).toMatchObject({ owners: [PLAYER], goal: "evict", target, status: "active" });
    expect(camps[0]!.progress).toBeGreaterThan(0);
  });

  it("`campaignActors()` still excludes the player — nothing autonomously forms one FOR them", () => {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.createCharacter({ playerName: "The Player", seed: 77 });
    session.setCampaignsEnabled(true);
    // A strong player->NPC threat read exists, but the player is never a campaign OWNER by the
    // autonomous tick — only their own recorded pitch (below) creates one.
    const npcId = (session.snapshot().house?.npcs ?? [])[0]!.id;
    rel.edge(PLAYER, npcId).threat = 0.95;
    session.campaignTick();
    const camps = (session as unknown as { campaigns: Campaign[] }).campaigns;
    expect(camps.some((c) => c.owners[0] === PLAYER)).toBe(false);
  });

  it("`campaignTick()` (the autonomous off-screen tick) never advances an EXISTING player campaign either — only a real pitch does", () => {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.createCharacter({ playerName: "The Player", seed: 77 });
    session.setCampaignsEnabled(true);
    session.foldPlayerCampaignMove(target, holder); // one real, earned pitch
    const camps = () => (session as unknown as { campaigns: Campaign[] }).campaigns;
    const before = camps().find((c) => c.owners[0] === PLAYER)!;
    expect(before.progress).toBeGreaterThan(0);

    // The off-screen tick runs repeatedly (as it does every player turn in live play) — the PLAYER
    // pitches no one again. Their campaign must sit exactly as earned, never drift on its own.
    for (let i = 0; i < 5; i++) session.campaignTick();

    const after = camps().find((c) => c.owners[0] === PLAYER)!;
    expect(after.progress).toBe(before.progress);
    expect(after.knownTo).toEqual(before.knownTo);
  });

  it("throttles progress to at most ONE earning move per beat — extra holders in the same beat still join knownTo", () => {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(true);
    session.foldPlayerCampaignMove(target, holder);
    const camps = () => (session as unknown as { campaigns: Campaign[] }).campaigns;
    const p1 = camps()[0]!.progress;

    session.foldPlayerCampaignMove(target, otherHolder); // same beat — no bumpBeatSeq between calls
    expect(camps()[0]!.progress).toBe(p1); // no extra progress this beat
    expect(camps()[0]!.knownTo).toContain(otherHolder); // but awareness still spread

    session.bumpBeatSeq(); // a new beat (a new committed turn)
    session.foldPlayerCampaignMove(target, holder);
    expect(camps()[0]!.progress).toBeGreaterThan(p1); // progress resumes on the next beat
  });

  it("feeds the SAME campaignTiltFor mechanism an NPC's campaign uses — aware voters only", () => {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(true);
    session.foldPlayerCampaignMove(target, holder);
    const tiltFor = (t: EntityId, v: EntityId): number =>
      (session as unknown as { campaignTiltFor(a: EntityId, b: EntityId): number }).campaignTiltFor(t, v);

    expect(tiltFor(target, holder)).toBeGreaterThan(0); // the pitched holder is aware and swayed
    expect(tiltFor(target, otherHolder)).toBe(0); // an un-pitched houseguest is not (symmetric perspective)
    expect(tiltFor(npc(99), holder)).toBe(0); // and only against the campaign's actual target
  });

  it("the tilt never exceeds CAMPAIGN.base — the SAME ceiling an NPC's campaign is bounded to", () => {
    const rel = new RelationshipModel(0.5);
    rel.edge(PLAYER, holder).trust = 1; // maximal trust-gate multiplier (owner->voter, per campaignTiltFor) — no dampening
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(true);
    for (let i = 0; i < 30; i++) {
      session.foldPlayerCampaignMove(target, holder);
      session.bumpBeatSeq(); // one earning move per beat
    }
    const tiltFor = (t: EntityId, v: EntityId): number =>
      (session as unknown as { campaignTiltFor(a: EntityId, b: EntityId): number }).campaignTiltFor(t, v);
    expect(tiltFor(target, holder)).toBeLessThanOrEqual(CAMPAIGN.base + 1e-9);
  });

  it("re-targeting the player's own campaign replaces (never duplicates) their prior one", () => {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(true);
    session.foldPlayerCampaignMove(target, holder);
    session.bumpBeatSeq();
    session.foldPlayerCampaignMove(npc(50), holder); // a new target
    const camps = (session as unknown as { campaigns: Campaign[] }).campaigns;
    expect(camps.filter((c) => c.owners[0] === PLAYER)).toHaveLength(1);
    expect(camps.find((c) => c.owners[0] === PLAYER)!.target).toBe(npc(50));
  });

  it("survives a snapshot/restore with progress, knownTo, and the throttle counters intact", () => {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(true);
    session.foldPlayerCampaignMove(target, holder);
    session.bumpBeatSeq();
    session.foldPlayerCampaignMove(target, otherHolder);
    const before = (session as unknown as { campaigns: Campaign[] }).campaigns;

    const revived = new GameSessionAdapter();
    revived.restore(session.snapshot());
    expect((revived as unknown as { campaigns: Campaign[] }).campaigns).toEqual(before);

    // The throttle survives too: a same-beat call right after restore still earns no extra progress.
    revived.setCampaignsEnabled(true);
    const campsBefore = (revived as unknown as { campaigns: Campaign[] }).campaigns[0]!.progress;
    revived.foldPlayerCampaignMove(target, npc(60));
    expect((revived as unknown as { campaigns: Campaign[] }).campaigns[0]!.progress).toBe(campsBefore);
  });
});

describe("Phase 2 — EngineCommandsAdapter.recordInteraction wiring (the full player-offense path)", () => {
  function wired() {
    const rel = new RelationshipModel(0.5);
    const events = new InMemoryEventStore();
    const knowledge = new InMemoryKnowledgeService(events);
    const rng = new SeededRandom(77);
    const commands = new EngineCommandsAdapter(events, knowledge, rel, rng);
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(true);
    commands.setPlayerCampaignFold((t, h) => session.foldPlayerCampaignMove(t, h));
    return { commands, session, rel };
  }
  const tiltFor = (session: GameSessionAdapter, t: EntityId, v: EntityId): number =>
    (session as unknown as { campaignTiltFor(a: EntityId, b: EntityId): number }).campaignTiltFor(t, v);

  it("a LANDED more-threatened pitch from the player grows their own campaign and tilts the vote toward the target", () => {
    const { commands, session, rel } = wired();
    rel.edge(holder, PLAYER).trust = 0.9; // trusted — no backfire risk

    commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, holder],
      content: "You pulled them aside and made the case that the other one is the real threat.",
      consequence: { aboutEdges: [{ holder, about: target, direction: "more-threatened", emphasis: "strong" }] },
    });

    expect(tiltFor(session, target, holder)).toBeGreaterThan(0);
  });

  it("does NOT grow the campaign when the pitch BACKFIRES (I2 — a failed social move moves nothing)", () => {
    const rel = new RelationshipModel(0.5);
    rel.edge(holder, PLAYER).trust = 0.05;
    rel.edge(holder, PLAYER).affinity = 0.05;
    rel.edge(holder, target).trust = 0.9;
    rel.edge(holder, target).affinity = 0.9;
    const events = new InMemoryEventStore();
    const knowledge = new InMemoryKnowledgeService(events);
    const rng = new ScriptedRandom([0.0, 0.5, 0.5, 0.5, 0.5]); // force the backfire roll to hit
    const commands = new EngineCommandsAdapter(events, knowledge, rel, rng);
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(true);
    commands.setPlayerCampaignFold((t, h) => session.foldPlayerCampaignMove(t, h));

    commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, holder],
      content: "You floated it, but it read as transparent manipulation.",
      consequence: { aboutEdges: [{ holder, about: target, direction: "more-threatened", emphasis: "strong" }] },
    });

    expect((session as unknown as { campaigns: Campaign[] }).campaigns).toHaveLength(0);
    expect(tiltFor(session, target, holder)).toBe(0);
  });

  it("does NOT grow a campaign for a `less-threatened` (protect-shaped) pitch — evict-only for now", () => {
    const { commands, session, rel } = wired();
    rel.edge(holder, PLAYER).trust = 0.9;

    commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, holder],
      content: "You told them not to worry about the other one.",
      consequence: { aboutEdges: [{ holder, about: target, direction: "less-threatened", emphasis: "strong" }] },
    });

    expect((session as unknown as { campaigns: Campaign[] }).campaigns).toHaveLength(0);
  });

  it("does NOT grow a campaign when the campaign layer is OFF — byte-identical to before this phase", () => {
    const rel = new RelationshipModel(0.5);
    const events = new InMemoryEventStore();
    const knowledge = new InMemoryKnowledgeService(events);
    const rng = new SeededRandom(77);
    const commands = new EngineCommandsAdapter(events, knowledge, rel, rng);
    const session = new GameSessionAdapter(rel);
    session.setCampaignsEnabled(false); // explicit OFF (default flip 2026-11-03)
    commands.setPlayerCampaignFold((t, h) => session.foldPlayerCampaignMove(t, h));
    rel.edge(holder, PLAYER).trust = 0.9;

    commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, holder], content: "a pitch",
      consequence: { aboutEdges: [{ holder, about: target, direction: "more-threatened", emphasis: "strong" }] },
    });

    expect((session as unknown as { campaigns: Campaign[] }).campaigns).toHaveLength(0);
  });

  it("is unaffected when `setPlayerCampaignFold` is never wired (standalone — no crash, no regression)", () => {
    const rel = new RelationshipModel(0.5);
    const events = new InMemoryEventStore();
    const knowledge = new InMemoryKnowledgeService(events);
    const commands = new EngineCommandsAdapter(events, knowledge, rel, new SeededRandom(77));
    rel.edge(holder, PLAYER).trust = 0.9;

    expect(() => commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, holder], content: "a pitch",
      consequence: { aboutEdges: [{ holder, about: target, direction: "more-threatened", emphasis: "strong" }] },
    })).not.toThrow();
  });
});

describe("Phase 2 boundary — the player's pitch reaches the campaign layer over the MCP boundary", () => {
  // The recurring "missing wiring" failure mode (CLAUDE.md): a deeply-nested provider hookup can
  // typecheck and unit-test green while being dead over the REAL tool-call path. This dispatches the
  // real `recordInteraction` tool through the real `McpServer`, exactly like a live MCP client would.
  function playerServer() {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter(sb.engine.relationships);
    session.setCampaignsEnabled(true);
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge, sb.engine.relationships);
    commands.setPlayerCampaignFold((t, h) => session.foldPlayerCampaignMove(t, h));
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    return { server, rel: sb.engine.relationships, session };
  }

  it("dispatches recordInteraction with an evict-shaped aboutEdges pitch and grows the player's campaign", async () => {
    const { server, rel, session } = playerServer();
    rel.edge(npc(1), PLAYER).trust = 0.9; // trusted — no backfire risk

    const res = (await server.callTool("recordInteraction", {
      initiator: PLAYER, witnessSet: [PLAYER, npc(1)],
      content: "You pulled npc:1 aside and made the case that npc:2 is the real threat.",
      consequence: { aboutEdges: [{ holder: npc(1), about: npc(2), direction: "more-threatened", emphasis: "strong" }] },
    })) as { eventId: string };

    expect(res.eventId).toBeTruthy();
    const camps = (session as unknown as { campaigns: Campaign[] }).campaigns;
    expect(camps.some((c) => c.owners[0] === PLAYER && c.target === npc(2))).toBe(true);
  });
});

describe("Phase 2 calibration — a sustained player campaign raises the target's odds without exceeding the NPC ceiling", () => {
  /** A voter's baseline stat context (no bloc/deal/jury terms) for the pure `voteChoice` comparison. */
  const ctx = (rel: RelationshipModel, tiltFor?: (t: EntityId, v: EntityId) => number): SeasonCtx => ({
    player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel,
    ...(tiltFor ? { campaignTiltFor: tiltFor } : {}),
  });

  /** Build a REAL house (real characters/influence, exactly like the NPC campaign's own BDD fixture
   *  `sustainedAgainstTarget`) where the PLAYER sustains a real, earned (bumpBeatSeq-throttled) evict
   *  pitch campaign against X, lobbying the electorate one holder per beat. */
  function sustainedPlayerCampaign(seed: number): { rel: RelationshipModel; tiltFor: (t: EntityId, v: EntityId) => number; X: EntityId; Y: EntityId; voters: EntityId[] } {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.createCharacter({ playerName: "The Player", seed });
    session.setCampaignsEnabled(true);
    const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
    const X = ids[3]!, Y = ids[4]!;
    const voters = [ids[5]!, ids[6]!, ids[7]!, ids[8]!];
    // `campaignTiltFor` reads the OWNER's own directed edge toward the voter (mirrors the existing
    // NPC campaign convention exactly — the BDD `sustainedAgainstTarget` fixture sets `edge(owner,
    // voter).affinity`, not the reverse), so the player's own rapport with the electorate is what the
    // trust-gate multiplier reads.
    for (const v of voters) rel.edge(PLAYER, v).trust = 1.0;
    for (const v of voters) { rel.edge(v, X).threat = 0.4; rel.edge(v, Y).threat = 0.42; } // baseline slightly favors keeping X
    // One earned pitch per beat, one voter at a time — never more than one progress-move per beat, and
    // well inside the campaign's own week-length lifetime (never lapses mid-run).
    for (const v of voters) {
      session.foldPlayerCampaignMove(X, v);
      session.bumpBeatSeq();
    }
    const tiltFor = (t: EntityId, v: EntityId): number =>
      (session as unknown as { campaignTiltFor(a: EntityId, b: EntityId): number }).campaignTiltFor(t, v);
    return { rel, tiltFor, X, Y, voters };
  }

  it("raises the target's vote count vs. no campaign, without exceeding the NPC tilt ceiling", () => {
    let on = 0, off = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { rel, tiltFor, X, Y, voters } = sustainedPlayerCampaign(seed);
      for (const v of voters) {
        if (voteChoice(v, [X, Y], ctx(rel, tiltFor)) === X) on++;
        if (voteChoice(v, [X, Y], ctx(rel)) === X) off++;
        // The player's channel is bounded to the SAME ceiling `campaignTilt` gives an NPC — never a
        // stronger lever just because the pitcher is the player.
        expect(tiltFor(X, v)).toBeLessThanOrEqual(CAMPAIGN.base + 1e-9);
      }
    }
    expect(on).toBeGreaterThan(off); // the campaign raises the target's odds
    expect(on).toBeLessThan(4 * 8); // but is not destiny — some ballots still hold
  });

  it("is deterministic — the same seed always produces the same tilt", () => {
    const a = sustainedPlayerCampaign(42);
    const b = sustainedPlayerCampaign(42);
    expect(a.tiltFor(a.X, a.voters[0]!)).toBe(b.tiltFor(b.X, b.voters[0]!));
  });

  it("a bystander voter never pitched is unmoved — symmetric perspective, no omniscience", () => {
    const { tiltFor, X } = sustainedPlayerCampaign(9);
    const bystander = npc(999);
    expect(tiltFor(X, bystander)).toBe(0);
  });
});
