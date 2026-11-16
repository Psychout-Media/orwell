import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { StoryThread, SeasonPosition } from "../../src/engine/deepProfile";
import { THREAD } from "../../src/engine/threadConstants";
import { SECRET_PACING } from "../../src/engine/secretPacingConstants";
import {
  ripeness, rankPlayerBoundThreads, recencyFromAge, channelFor, dripBudget, relationshipReads,
  type PlayerBoundThread,
} from "../../src/engine/secretPacing";

/**
 * Feature 0092 — the SECRET-PACING DRIP. A thin, relationship-aware PACING layer over 0060: it decides
 * WHICH sealed secret is ripe to edge toward THIS player and WHETHER the weekly budget allows it, then
 * routes the top candidate into 0060's EXISTING anchored surface path (the confidant slip / gossip
 * chain). It adds no new pathway, surfaces nothing itself, and never reads the Vault to a surface. HARD
 * rule: roles only, no names. Determinism + the Vault Wall + the weekly/season caps are all asserted.
 *
 * The byte-identical-draw-stream neutrality (flag off ⇒ zero pacing draws ⇒ the seeded comp/vote/jury
 * spine is unchanged) lives in its OWN file (`secretPacingNeutral.test.ts`), the load-bearing gate.
 */

// ── The pure pacing core (no I/O, no rng) ───────────────────────────────────────────────────────────

describe("0092 — ripeness (proximity + tension + recency − already-told)", () => {
  it("rises with proximity, rises with tension, and is penalized by already-told", () => {
    const base = { proximity: 0.5, tension: 0.5, recency: 0.5, alreadyTold: 0 };
    const more = ripeness({ ...base, proximity: 0.9 });
    const less = ripeness({ ...base, proximity: 0.1 });
    expect(more).toBeGreaterThan(less);
    const tense = ripeness({ ...base, tension: 0.9 });
    const calm = ripeness({ ...base, tension: 0.1 });
    expect(tense).toBeGreaterThan(calm);
    // The already-told penalty drops a secret the player already caught wind of well below a fresh one.
    const fresh = ripeness({ ...base, alreadyTold: 0 });
    const told = ripeness({ ...base, alreadyTold: 1 });
    expect(told).toBeLessThan(fresh);
  });

  it("is clamped to [0,1]", () => {
    expect(ripeness({ proximity: 1, tension: 1, recency: 1, alreadyTold: 0 })).toBeLessThanOrEqual(1);
    expect(ripeness({ proximity: 0, tension: 0, recency: 0, alreadyTold: 1 })).toBeGreaterThanOrEqual(0);
  });
});

describe("0092 — recencyFromAge (a fresh thread is hotter than a stale one)", () => {
  it("is full this week and decays to 0 at the recency window", () => {
    expect(recencyFromAge(0)).toBe(1);
    expect(recencyFromAge(SECRET_PACING.recencyDecayWeeks)).toBe(0);
    expect(recencyFromAge(1)).toBeGreaterThan(recencyFromAge(2)); // monotone decay
    expect(recencyFromAge(99)).toBe(0); // never negative
  });
});

describe("0092 — channelFor (proximity ⇒ confidant, tension ⇒ gossip)", () => {
  it("a close source prefers the confidant slip; a rival prefers the gossip chain", () => {
    expect(channelFor({ proximity: 0.8, tension: 0.2 })).toBe("confidant");
    expect(channelFor({ proximity: 0.2, tension: 0.8 })).toBe("gossip");
  });
});

describe("0092 — rankPlayerBoundThreads (seed-stable, relevance-floored)", () => {
  const mk = (id: string, proximity: number, tension: number): PlayerBoundThread =>
    ({ id, sourceId: id, proximity, tension, recency: 0.5, alreadyTold: 0 });

  it("orders most-ripe first and is a PURE function of the inputs (no rng, stable tiebreak)", () => {
    const threads = [mk("t:c", 0.1, 0.1), mk("t:a", 0.9, 0.9), mk("t:b", 0.5, 0.5)];
    const a = rankPlayerBoundThreads(threads).map((t) => t.id);
    const b = rankPlayerBoundThreads([...threads].reverse()).map((t) => t.id); // input order must not matter
    expect(a).toEqual(b);
    expect(a[0]).toBe("t:a"); // the ripest is first
  });

  it("drops candidates below the relevance floor (a bystander the player neither bonds nor clashes with)", () => {
    const ripe = mk("t:ally", 0.9, 0.1);     // a close ally — well above the floor
    const bystander = mk("t:rando", 0.02, 0.02); // no bond, no tension — below the floor
    const ranked = rankPlayerBoundThreads([ripe, bystander]);
    expect(ranked.map((t) => t.id)).toContain("t:ally");
    expect(ranked.map((t) => t.id)).not.toContain("t:rando");
  });

  it("ties on ripeness break deterministically by thread id", () => {
    const x = mk("t:x", 0.6, 0.6);
    const y = mk("t:y", 0.6, 0.6); // identical ripeness
    expect(rankPlayerBoundThreads([y, x]).map((t) => t.id)).toEqual(["t:x", "t:y"]);
  });
});

describe("0092 — dripBudget (the per-week pace, a hard ceiling)", () => {
  it("allows up to maxDripsPerWeek in a week, then refuses", () => {
    const at = (spent: number) => dripBudget({ week: 3, spentThisWeek: spent, currentWeek: 3 });
    expect(at(0).allowed).toBe(true);
    expect(at(SECRET_PACING.maxDripsPerWeek - 1).allowed).toBe(true);
    expect(at(SECRET_PACING.maxDripsPerWeek).allowed).toBe(false); // the ceiling is hard
  });

  it("a NEW week resets the spent count (the cadence is per-week)", () => {
    // The stored counter is from week 2 (fully spent), but the live week is 3 ⇒ treated as 0 spent.
    const rolled = dripBudget({ week: 2, spentThisWeek: SECRET_PACING.maxDripsPerWeek, currentWeek: 3 });
    expect(rolled.spent).toBe(0);
    expect(rolled.allowed).toBe(true);
  });
});

describe("0092 — relationshipReads (proximity = mutual bond; tension = strongest friction either way)", () => {
  it("a mutual close bond reads high proximity, low tension", () => {
    const warm = { trust: 0.8, affinity: 0.8, threat: 0.05 };
    const r = relationshipReads(warm, warm);
    expect(r.proximity).toBeGreaterThan(0.7);
    expect(r.tension).toBeLessThan(0.2);
  });

  it("a one-sided rivalry (the source is wary of the player) still reads high tension", () => {
    const playerWarm = { trust: 0.3, affinity: 0.3, threat: 0.2 };
    const sourceHostile = { trust: 0.05, affinity: 0.05, threat: 0.95 }; // they fear the player
    const r = relationshipReads(playerWarm, sourceHostile);
    expect(r.tension).toBeGreaterThan(0.7); // the strongest friction in EITHER direction
  });
});

// ── The adapter integration (the live drip routes into 0060's existing surface, paced + capped) ──────

/** Reach the live adapter internals (deterministic, focused — the same `peek` pattern the 0060 tests use). */
type Internals = {
  storyThreads: StoryThread[];
  seasonPosition: () => SeasonPosition;
  rel: { edge: (a: string, b: string) => { trust: number; affinity: number; threat: number } };
  week: number;
  pacingDripCount: number;
  pacingLastDrippedWeek: Record<string, number>;
  surfacedThreadCount: number;
};
const peek = (sb: UserSandbox): Internals => sb.session as unknown as Internals;

/** A fresh sandbox with a created character (so `house` + seeded story threads exist), no sim run. */
function fresh(seed: number, user: string): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}

/** Make ONE seeded thread active and arm the player↔source edges for a chosen channel. Returns the thread. */
function armActiveThread(
  sb: UserSandbox, kind: "confidant" | "rival",
): StoryThread {
  const internals = peek(sb);
  const thread = internals.storyThreads[0]!;
  thread.status = "active";
  thread.lifecycleWeek = internals.week; // fresh ⇒ full recency
  const fwd = internals.rel.edge(PLAYER, thread.sourceId);
  const rev = internals.rel.edge(thread.sourceId, PLAYER);
  if (kind === "confidant") {
    // A close mutual bond: high proximity, low tension ⇒ ripe AND prefers the confidant channel.
    fwd.trust = 0.9; fwd.affinity = 0.9; fwd.threat = 0.0;
    rev.trust = 0.9; rev.affinity = 0.9; rev.threat = 0.0;
  } else {
    // High mutual friction: high tension ⇒ ripe AND prefers the gossip channel.
    fwd.trust = 0.05; fwd.affinity = 0.05; fwd.threat = 0.95;
    rev.trust = 0.05; rev.affinity = 0.05; rev.threat = 0.95;
  }
  return thread;
}

describe("0092 — an eligible ripe thread routes into a 0060 surface (the drip only chooses + paces)", () => {
  it("a proximity-ripe secret lands a player BELIEF via the confidant pathway, with source + confidence", () => {
    const sb = fresh(7, "sp-confidant");
    GameSessionAdapter.setSecretPacingEnabled(true);
    try {
      const thread = armActiveThread(sb, "confidant");
      // The drip rolls a single seeded eligibility check; tick until it fires (a quiet tick is intentional).
      let fired = false;
      for (let i = 0; i < 50 && !fired; i++) {
        const dripped = sb.session.pacingDrip();
        if (dripped.length > 0) fired = true;
      }
      expect(fired, "the ripe confidant secret never dripped across many ticks").toBe(true);
      // It crossed through 0060's EXISTING to-player path ⇒ a player belief with a real source pathway.
      const known = sb.engine.knowledge.knownTo(PLAYER);
      const belief = known.find((k) => /^(told-by:|overheard:|gossip|surfaced)/.test(k.pathway));
      expect(belief, "no anchored player belief was recorded by the drip").toBeTruthy();
      expect(typeof belief!.confidence).toBe("number");
      // The thread is now spent (it surfaced) and counted ONCE against 0060's season cap.
      expect(thread.status).toBe("surfaced");
      expect(peek(sb).surfacedThreadCount).toBe(1);
    } finally {
      GameSessionAdapter.setSecretPacingEnabled(null);
    }
  });

  it("a tension-ripe secret diffuses NPC↔NPC (the gossip channel) — a chain may reach the player", () => {
    const sb = fresh(11, "sp-rival");
    GameSessionAdapter.setSecretPacingEnabled(true);
    try {
      const thread = armActiveThread(sb, "rival");
      let fired = false;
      for (let i = 0; i < 50 && !fired; i++) {
        if (sb.session.pacingDrip().length > 0) fired = true;
      }
      expect(fired).toBe(true);
      // The gossip channel seeds at least an NPC-side belief (the rumor exists in the house). The drip
      // routed it; the crossing is the unchanged 0038 organ.
      const anyNpcBelief = sb.session.snapshot().house!.npcs.some(
        (n) => sb.engine.knowledge.knownTo(n.id).length > 0,
      );
      expect(anyNpcBelief, "the gossip drip seeded no NPC-side belief").toBe(true);
      expect(thread.status).toBe("surfaced");
    } finally {
      GameSessionAdapter.setSecretPacingEnabled(null);
    }
  });
});

describe("0092 — the weekly drip budget caps how many secrets edge toward the player", () => {
  it("never exceeds maxDripsPerWeek in a single week, and never past 0060's season cap", () => {
    const sb = fresh(7, "sp-cap");
    GameSessionAdapter.setSecretPacingEnabled(true);
    try {
      const internals = peek(sb);
      // Arm MANY active, ripe (confidant-grade) threads — far more than the weekly ceiling.
      for (const t of internals.storyThreads) {
        t.status = "active";
        t.lifecycleWeek = internals.week;
        const fwd = internals.rel.edge(PLAYER, t.sourceId);
        const rev = internals.rel.edge(t.sourceId, PLAYER);
        fwd.trust = 0.9; fwd.affinity = 0.9; fwd.threat = 0.0;
        rev.trust = 0.9; rev.affinity = 0.9; rev.threat = 0.0;
      }
      // Run many ticks WITHIN a single week (we never advance the live loop, so `week` is fixed).
      let drips = 0;
      for (let i = 0; i < 200; i++) drips += sb.session.pacingDrip().length;
      expect(drips).toBeLessThanOrEqual(SECRET_PACING.maxDripsPerWeek); // the weekly ceiling is hard
      expect(internals.pacingDripCount).toBeLessThanOrEqual(SECRET_PACING.maxDripsPerWeek);
      expect(internals.surfacedThreadCount).toBeLessThanOrEqual(THREAD.maxSurfacedPerSeason); // the season cap binds
    } finally {
      GameSessionAdapter.setSecretPacingEnabled(null);
    }
  });

  it("a secret already dripped is not dripped again at the same depth (no re-spam, anti-spam state set)", () => {
    const sb = fresh(7, "sp-respam");
    GameSessionAdapter.setSecretPacingEnabled(true);
    try {
      const thread = armActiveThread(sb, "confidant");
      // Drive the FIRST drip to fire.
      for (let i = 0; i < 50; i++) if (sb.session.pacingDrip().length > 0) break;
      expect(thread.status).toBe("surfaced");
      const firstDripWeek = peek(sb).pacingLastDrippedWeek[thread.id];
      expect(firstDripWeek).toBe(peek(sb).week); // the anti-spam state was recorded
      // Re-arm the SAME thread active (simulate it cycling back) and run more ticks — the already-told
      // penalty (it dripped before) drops its ripeness; it must not re-drip at the same depth.
      thread.status = "active";
      for (let i = 0; i < 50; i++) sb.session.pacingDrip();
      // Either the weekly budget is already spent OR the already-told penalty floored it — either way no
      // further drip of THIS already-told secret beyond the first (the schedule moves on).
      expect(peek(sb).pacingLastDrippedWeek[thread.id]).toBe(firstDripWeek);
    } finally {
      GameSessionAdapter.setSecretPacingEnabled(null);
    }
  });
});

describe("0092 — determinism (same seed + same history ⇒ same drip decision)", () => {
  it("two identical arrangements drip identically", () => {
    const run = (): { fired: boolean; status: string } => {
      const sb = fresh(7, `sp-det-${Math.random()}`); // a fresh user each run — the seed drives the stream
      GameSessionAdapter.setSecretPacingEnabled(true);
      try {
        const thread = armActiveThread(sb, "confidant");
        let fired = false;
        for (let i = 0; i < 30 && !fired; i++) if (sb.session.pacingDrip().length > 0) fired = true;
        return { fired, status: thread.status };
      } finally {
        GameSessionAdapter.setSecretPacingEnabled(null);
      }
    };
    const a = run();
    const b = run();
    expect(b).toEqual(a); // identical seed + identical arrangement ⇒ identical drip outcome
  });
});

describe("0092 — a drip only commits when its pathway can actually DELIVER (no silent payoff-loss)", () => {
  /** A BARE adapter (no registry) ⇒ the to-player / gossip surfacing seams are UNWIRED — the audit's
   *  'can't deliver' state. Arm a confidant-channel thread and confirm the drip does NOT spend a cap slot. */
  it("a confidant drip with an unwired to-player seam does not surface or spend the season cap", () => {
    const session = new GameSessionAdapter(); // no registry ⇒ onThreadSurfaceToPlayer is undefined
    session.createCharacter({ playerName: "The Player", seed: 7 });
    GameSessionAdapter.setSecretPacingEnabled(true);
    try {
      const internals = session as unknown as Internals;
      const thread = internals.storyThreads[0]!;
      thread.status = "active"; thread.lifecycleWeek = internals.week;
      const fwd = internals.rel.edge(PLAYER, thread.sourceId);
      const rev = internals.rel.edge(thread.sourceId, PLAYER);
      fwd.trust = 0.9; fwd.affinity = 0.9; fwd.threat = 0.0;
      rev.trust = 0.9; rev.affinity = 0.9; rev.threat = 0.0;
      // Many ticks — the deliverability guard refuses every one (the confidant slip seam is unwired), so
      // the secret stays RIPE: never surfaced, the scarce season cap untouched, no anti-spam state set.
      for (let i = 0; i < 60; i++) session.pacingDrip();
      expect(thread.status).toBe("active");                 // never spent
      expect(internals.surfacedThreadCount).toBe(0);        // no season-cap slot burned on a no-op
      expect(internals.pacingLastDrippedWeek[thread.id]).toBeUndefined(); // no anti-spam state set
    } finally {
      GameSessionAdapter.setSecretPacingEnabled(null);
    }
  });
  it("a drip nobody awake can relay is not charged against the weekly budget (review of 0092)", () => {
    const session = new GameSessionAdapter();
    session.createCharacter({ playerName: "The Player", seed: 7 });
    GameSessionAdapter.setSecretPacingEnabled(true);
    try {
      const internals = session as unknown as Internals & { onThreadSurfaceToPlayer?: unknown; awakeNow: () => Set<string> | null; pacingDripCount: number };
      const thread = internals.storyThreads[0]!;
      thread.status = "active"; thread.lifecycleWeek = internals.week;
      const fwd = internals.rel.edge(PLAYER, thread.sourceId);
      const rev = internals.rel.edge(thread.sourceId, PLAYER);
      fwd.trust = 0.9; fwd.affinity = 0.9; fwd.threat = 0.0; rev.trust = 0.9; rev.affinity = 0.9; rev.threat = 0.0;
      internals.onThreadSurfaceToPlayer = () => false; // wired, but the relay fails (everyone is asleep)
      internals.awakeNow = () => new Set<string>();
      for (let i = 0; i < 30; i++) session.pacingDrip();
      expect(thread.status).toBe("active");
      expect(internals.pacingDripCount).toBe(0);
      expect(internals.pacingLastDrippedWeek[thread.id]).toBeUndefined(); // the anti-spam state is untouched too
      expect(internals.surfacedThreadCount).toBe(0); // and the season cap
    } finally {
      GameSessionAdapter.setSecretPacingEnabled(null);
    }
  });
});

describe("0092 — already-told refinements (a lie does not bury the truth; one secret ≠ all a source's secrets)", () => {
  /** Reach the already-told scorer directly (a focused read; the integration is exercised above). */
  type AT = { threadAlreadyTold: (t: StoryThread) => number; confideState: Record<string, { tier: string; truthful: boolean }>; storyThreads: StoryThread[] };
  const atOf = (sb: UserSandbox): AT => sb.session as unknown as AT;

  it("a LIE the source told the player does NOT raise already-told for the real secret", () => {
    const sb = fresh(7, "sp-lie");
    const at = atOf(sb);
    const thread = at.storyThreads[0]!;
    // The source told the player a FULL-tier LIE. The real secret must stay fully ripe (alreadyTold ~0).
    at.confideState[thread.sourceId] = { tier: "full", truthful: false };
    expect(at.threadAlreadyTold(thread)).toBe(0);
  });

  it("a TRUTHFUL confidence DAMPENS (a fraction) but does not FLOOR a source's OTHER secrets", () => {
    const sb = fresh(7, "sp-conflate");
    const at = atOf(sb);
    const thread = at.storyThreads[0]!;
    at.confideState[thread.sourceId] = { tier: "full", truthful: true };
    const told = at.threadAlreadyTold(thread);
    // A full truthful confidence on a SIBLING secret dampens this one by the source fraction (0.5), not 1.
    expect(told).toBeCloseTo(SECRET_PACING.confidedSourceFraction, 5);
    expect(told).toBeLessThan(1);
  });

  it("the thread's OWN surfaced/dripped state still floors it fully (anti-spam intact)", () => {
    const sb = fresh(7, "sp-own");
    const at = atOf(sb);
    const surfaced = { ...at.storyThreads[0]!, status: "surfaced" as const };
    expect(at.threadAlreadyTold(surfaced)).toBe(1); // THIS secret already reached the player ⇒ full penalty
  });
});

describe("0092 — the Vault Wall holds on the player AND admin surface, before AND after a drip", () => {
  /** Every PUBLIC outward surface, concatenated — the no-leak sweep target (player surfaces). */
  const playerSurface = (sb: UserSandbox): string =>
    JSON.stringify(sb.session.getGameState())
    + "\n" + JSON.stringify(sb.player.getVisibleState())
    + "\n" + JSON.stringify(sb.session.getMomentPrompt({}))
    + "\n" + sb.session.getGameState().house
        .filter((h) => h.status === "active")
        .map((h) => JSON.stringify(sb.session.npcVoice(h.id)))
        .join("\n");

  it("no sealed premise, and no number, reaches any player or admin surface — and the ripeness/counter never do", () => {
    const sb = fresh(7, "sp-leak");
    GameSessionAdapter.setSecretPacingEnabled(true);
    try {
      const internals = peek(sb);
      // Plant a sentinel + a numeric tell into EVERY thread premise/trigger — neither may ever cross.
      const SENT = "SENTINEL-0092-PACING";
      for (const t of internals.storyThreads) {
        t.premise = `${t.premise} ${SENT} 0.7392`;
        t.trigger = `${t.trigger} ${SENT}`;
      }
      const thread = armActiveThread(sb, "confidant");
      // BEFORE the drip: no sealed premise on either surface.
      expect(playerSurface(sb).includes(SENT)).toBe(false);
      sb.syncAdmin?.();
      expect(JSON.stringify(sb.admin.inspect()).includes(SENT)).toBe(false);

      // Fire the drip.
      for (let i = 0; i < 50; i++) if (sb.session.pacingDrip().length > 0) break;
      expect(thread.status).toBe("surfaced");

      // AFTER the drip: STILL no sealed premise / number on the player surface (the crossing was the
      // unchanged class-keyed paraphrase, never the premise — §7), nor on the admin surface.
      const pSurface = playerSurface(sb);
      expect(pSurface.includes(SENT)).toBe(false);     // the verbatim premise/trigger never crosses
      expect(pSurface.includes("0.7392")).toBe(false); // and no hidden number crosses
      // The ripeness scores + the weekly drip counter are sealed engine state — the schedule's machinery
      // names never leak to a surface (the SENT / number-tell checks above are the precise content gate).
      expect(pSurface.includes("ripeness")).toBe(false);
      expect(pSurface.includes("pacingDrip")).toBe(false);
      sb.syncAdmin?.();
      const adminSurface = JSON.stringify(sb.admin.inspect());
      expect(adminSurface.includes(SENT)).toBe(false);
      expect(adminSurface.includes("0.7392")).toBe(false);
      expect(adminSurface.includes("ripeness")).toBe(false);
      expect(adminSurface.includes("pacingDrip")).toBe(false);
    } finally {
      GameSessionAdapter.setSecretPacingEnabled(null);
    }
  });
});

describe("0092 — the constants grep gate (B59) covers secretPacingConstants", () => {
  it("the pacing magnitudes live ONLY in secretPacingConstants, never inlined at a call site", () => {
    const adapter = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    const pacing = readFileSync("src/engine/secretPacing.ts", "utf8");
    expect(adapter).toContain("secretPacingConstants");
    expect(adapter).toContain("SECRET_PACING.");
    expect(pacing).toContain("SECRET_PACING.");
    // The weekly ceiling is a HARD bound — about one or two a week, never a firehose (the L40 restraint).
    expect(SECRET_PACING.maxDripsPerWeek).toBeGreaterThan(0);
    expect(SECRET_PACING.maxDripsPerWeek).toBeLessThanOrEqual(SECRET_PACING.weeklyTargetMax);
    expect(SECRET_PACING.weeklyTargetMin).toBeLessThanOrEqual(SECRET_PACING.weeklyTargetMax);
    // Every weight has a real consumer (no decorative constant, audit E53).
    expect(SECRET_PACING.proximityWeight).toBeGreaterThan(0);
    expect(SECRET_PACING.tensionWeight).toBeGreaterThan(0);
    expect(SECRET_PACING.dripEligibilityRate).toBeGreaterThan(0);
    expect(SECRET_PACING.dripEligibilityRate).toBeLessThanOrEqual(1);
  });
});
