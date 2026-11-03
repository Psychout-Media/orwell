import { flagDefaultOn } from "../../src/domain/flagDefaults";
import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EdgeRecord } from "../../src/domain/saveState";
import { assertNoSentinels } from "../../tests/support/assertions";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0099 (hidden half) — the off-screen NPC↔NPC SECRET-BARTER tick driver. Roles only:
 * a-GIVER holds a learned secret ABOUT a-SUBJECT; a-WANTER fears the subject and so VALUES the secret;
 * everyone else does not. The barter REUSES the existing 0099 trade/value core (`npcBarterStep` →
 * `tradeValue`) driven on a bounded off-screen tick — it invents no new secrets system. SELF-GATED:
 * OFF ⇒ nothing runs (proven byte-identical in `secretBarterNeutral.test.ts`).
 *
 * Cast = player + npc(1..15) (`createCharacter` generates those ids). HARD rule: roles only, no names.
 */

const GIVER = npc(1);   // holds a learned secret about the SUBJECT
const SUBJECT = npc(2); // the houseguest the secret is about
const WANTER = npc(3);  // fears the SUBJECT ⇒ VALUES a secret about them ⇒ the barter's recipient
const ALL_NPCS: EntityId[] = Array.from({ length: 15 }, (_, i) => npc(i + 1));
const SECRET_FACT = "sb-fact-1";

/** A mid-game live state with every NPC still in the house (none evicted) — so `isActiveNpc` holds. */
function midGameLive(): LiveSeasonState {
  return {
    week: 1,
    beat: "hoh-competition",
    active: [PLAYER, ...ALL_NPCS],
    vetoUsed: false,
    evictionOrder: [],
    finished: false,
  };
}

/**
 * Craft the edges so ONE recipient (WANTER) values a secret about SUBJECT and NOBODY else does: WANTER
 * fears the subject (high threat, low affinity) and trusts the giver; every other NPC likes the subject
 * (no threat) and distrusts the giver, so their `tradeValue` sits deterministically below the barter
 * floor (`SECRET_TRADE.barterValueFloor`). ⇒ WANTER is the unique over-floor recipient.
 */
function barterEdges(): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  const e = (from: EntityId, to: EntityId, o: Partial<EdgeRecord>): void => {
    edges.push({ from, to, trust: 0.3, affinity: 0.3, threat: 0.3, alignment: 0.3, confidence: 0.5, reliability: 0.3, ...o });
  };
  e(WANTER, SUBJECT, { threat: 0.9, affinity: 0.05 }); // fears the subject ⇒ wants leverage on them
  e(WANTER, GIVER, { trust: 0.7 });                    // trusts the giver ⇒ the offer isn't discounted
  for (const n of ALL_NPCS) {
    if (n === WANTER || n === SUBJECT || n === GIVER) continue;
    e(n, SUBJECT, { threat: 0.0, affinity: 0.9 }); // likes the subject ⇒ the secret is worthless to them
    e(n, GIVER, { trust: 0.0 });                   // distrusts the giver ⇒ any offer is discounted
  }
  return edges;
}

/** Stand up a started game, restore a crafted mid-game state + edges, and seed the giver's secret. */
function barterGame(user: string, seed: number, secretContent = "a real secret about the subject"): {
  reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]>;
} {
  const reg = new GameSessionRegistry();
  reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed });
  const snap = reg.snapshot(user) as SessionSnapshot;
  snap.live = midGameLive();
  snap.relationships = barterEdges();
  reg.restore(user, snap);
  const sb = reg.sandboxFor(user);
  // The GIVER learned a secret ABOUT the SUBJECT (seeded AFTER restore so it survives the rebuild).
  sb.engine.knowledge.seedBelief(
    GIVER,
    { content: secretContent, factId: SECRET_FACT, subject: SUBJECT, confidence: 1 },
    "origin",
  );
  return { reg, sb };
}

const holds = (
  sb: ReturnType<GameSessionRegistry["sandboxFor"]>, who: EntityId, factId: string,
): boolean => sb.engine.knowledge.knownTo(who).some((k) => (k.factId ?? k.id) === factId);

describe("0099 — secretBarterTick when EXPLICITLY OFF (no transfer, the dedicated stream never advances)", () => {
  it("a fresh session starts at the code default", () => {
    const { sb } = barterGame("dflt", 11);
    expect(sb.session.secretBarterEnabledNow()).toBe(flagDefaultOn("ORWELL_SECRET_BARTER", process.env));
  });

  it("a disabled barter is a no-op — the valuing recipient never receives the secret", () => {
    const { sb } = barterGame("off", 11);
    sb.session.setSecretBarterEnabled(false); // explicit OFF (default flip 2026-11-03)
    for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge);
    expect(holds(sb, WANTER, SECRET_FACT), "no transfer when off").toBe(false);
    expect(sb.session.snapshot().secretBarterTickCount, "the dedicated stream never advanced").toBeUndefined();
    expect(sb.session.snapshot().secretBarterCount, "no secret spent when off").toBeUndefined();
  });
});

describe("0099 — when enabled, an NPC barters a held secret to a valuing recipient's HIDDEN knowledge", () => {
  it("the secret enters the recipient's knowledge via a hidden pathway (fail-before / pass-after)", () => {
    const { sb } = barterGame("on", 7);
    // Fail-before: the recipient does not yet hold the secret.
    expect(holds(sb, WANTER, SECRET_FACT), "recipient has not learned it yet").toBe(false);
    const before = sb.engine.events.count();

    sb.session.setSecretBarterEnabled(true);
    for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge);

    // Pass-after: the valuing recipient now HOLDS the bartered belief (lineage preserved).
    expect(holds(sb, WANTER, SECRET_FACT), "the valuing recipient received the bartered secret").toBe(true);
    // A secret was spent into the economy; the dedicated stream advanced (both persisted, monotonic).
    expect(sb.session.snapshot().secretBarterCount ?? 0, "a secret was spent").toBeGreaterThan(0);
    expect(sb.session.snapshot().secretBarterTickCount ?? 0, "the dedicated stream advanced").toBeGreaterThan(0);

    // Every transfer is HIDDEN off-screen content — the player is NEVER in a barter event's witness set.
    const produced = sb.engine.events.queryAll().slice(before).filter((ev) => ev.type === "gossip");
    expect(produced.length, "the barter recorded at least one NPC→NPC transfer event").toBeGreaterThan(0);
    for (const ev of produced) {
      expect(ev.hidden, "every barter transfer is hidden").toBe(true);
      expect(ev.witnessSet, "the player NEVER witnesses an NPC↔NPC barter").not.toContain(PLAYER);
    }
    // The player never learned it (no pathway terminated at them) — it is the recipient's hidden knowledge.
    expect(holds(sb, PLAYER, SECRET_FACT), "the player has no pathway to the bartered secret").toBe(false);
  });

  it("a recipient who does NOT value the secret is never the one bought (the value gate bites)", () => {
    const { sb } = barterGame("value", 5);
    sb.session.setSecretBarterEnabled(true);
    for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge);
    // WANTER (fears the subject) got it; a NON-valuing NPC (npc 4, likes the subject / distrusts the
    // giver ⇒ below the barter floor) never did — the trade is valued to the recipient, not uniform noise.
    expect(holds(sb, WANTER, SECRET_FACT), "the valuing recipient received it").toBe(true);
    expect(holds(sb, npc(4), SECRET_FACT), "a non-valuing recipient never received it").toBe(false);
  });
});

describe("0099 — the Vault Wall holds for the player AND admin (the bartered secret never crosses)", () => {
  it("no bartered off-screen secret reaches any player-facing or admin/God-Mode surface", () => {
    const SENTINEL = "SENTINEL-0099-BARTER-secret-detail";
    const { reg, sb } = barterGame("vault", 9, `[off-screen] the subject's buried secret ${SENTINEL}`);
    sb.session.setSecretBarterEnabled(true);
    for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge);
    // The barter genuinely fired (the sentinel now lives in an NPC's HIDDEN knowledge) — the test is not vacuous.
    expect(holds(sb, WANTER, SECRET_FACT), "the sentinel secret was bartered into NPC hidden knowledge").toBe(true);
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
    // …and the admin / God-Mode surface.
    const adminBlob = JSON.stringify(sb.admin.inspect());

    // The bartered secret content never appears on a player or admin surface — it reaches the player
    // only via an existing pathway (none here), never as a Vault read.
    assertNoSentinels(playerBlob, [SENTINEL]);
    assertNoSentinels(adminBlob, [SENTINEL]);
  });
});

describe("0099 — persistence: the barter state survives a restart intact (non-degradation #4)", () => {
  it("the dedicated stream counter + the spent-secret count round-trip through a fresh adapter", () => {
    const { sb } = barterGame("persist", 7);
    sb.session.setSecretBarterEnabled(true);
    for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge);
    const beforeTick = sb.session.snapshot().secretBarterTickCount;
    const beforeCount = sb.session.snapshot().secretBarterCount;
    expect(beforeCount ?? 0, "a secret was spent").toBeGreaterThan(0);

    const revived = new GameSessionAdapter();
    revived.restore(sb.session.snapshot());
    expect(revived.snapshot().secretBarterTickCount, "dedicated stream counter restored").toBe(beforeTick);
    expect(revived.snapshot().secretBarterCount, "spent-secret count restored").toBe(beforeCount);
  });

  it("the recipient DURABLY holds the bartered secret across a full registry snapshot/restore (deepens, never thins)", () => {
    const { reg, sb } = barterGame("persist-know", 7);
    sb.session.setSecretBarterEnabled(true);
    for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge);
    expect(holds(sb, WANTER, SECRET_FACT), "the recipient learned it").toBe(true);

    // Round-trip the whole sandbox (the knowledge layer is part of the durable SessionSnapshot).
    const snap = reg.snapshot("persist-know") as SessionSnapshot;
    reg.restore("persist-know", snap);
    const revived = reg.sandboxFor("persist-know");
    expect(holds(revived, WANTER, SECRET_FACT), "the bartered secret survives the restart — the knowledge layer deepens").toBe(true);
  });
});

describe("0099 (#1438) — a holder barters its TOP-valued secret, not the lexicographically-first factId", () => {
  const SUBJECT_LOW = npc(4);              // a well-liked houseguest NOBODY fears ⇒ a secret about them is worthless
  const FACT_WORTHLESS = "sb-a-worthless"; // sorts FIRST ⇒ the OLD code's `[0]` pick — the whole bug
  const FACT_VALUED = "sb-z-valued";       // sorts LAST ⇒ the OLD code never reached it, so it never moved

  /**
   * GIVER holds BOTH secrets. WANTER fears SUBJECT (so VALUES the valued secret) but likes SUBJECT_LOW (so
   * the worthless secret is worthless to them too); everyone else likes both subjects / distrusts GIVER ⇒
   * they sit below the barter floor. WANTER's giver-trust is kept MODEST (0.2) so the worthless secret
   * stays below the floor for WANTER as well — independent of the generated subjects' headline severities —
   * so it is NEVER the one bartered, while the valued secret clears the floor comfortably (interest 1.0).
   */
  function twoSecretEdges(): EdgeRecord[] {
    const edges: EdgeRecord[] = [];
    const e = (from: EntityId, to: EntityId, o: Partial<EdgeRecord>): void => {
      edges.push({ from, to, trust: 0.3, affinity: 0.3, threat: 0.3, alignment: 0.3, confidence: 0.5, reliability: 0.3, ...o });
    };
    e(WANTER, SUBJECT, { threat: 0.9, affinity: 0.05 });    // fears SUBJECT ⇒ VALUES the valued secret (interest 1.0)
    e(WANTER, SUBJECT_LOW, { threat: 0.0, affinity: 0.9 }); // likes SUBJECT_LOW ⇒ the worthless secret is worthless
    e(WANTER, GIVER, { trust: 0.2 });                       // modest trust ⇒ the worthless secret stays below the floor
    for (const n of ALL_NPCS) {
      if (n === WANTER || n === GIVER) continue;
      if (n !== SUBJECT) e(n, SUBJECT, { threat: 0.0, affinity: 0.9 });         // likes SUBJECT ⇒ valued secret worthless to them
      if (n !== SUBJECT_LOW) e(n, SUBJECT_LOW, { threat: 0.0, affinity: 0.9 }); // likes SUBJECT_LOW too
      e(n, GIVER, { trust: 0.0 });                                             // distrusts GIVER ⇒ any offer discounted
    }
    return edges;
  }

  function twoSecretGame(user: string, seed: number): {
    reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]>;
  } {
    const reg = new GameSessionRegistry();
    reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed });
    const snap = reg.snapshot(user) as SessionSnapshot;
    snap.live = midGameLive();
    snap.relationships = twoSecretEdges();
    reg.restore(user, snap);
    const sb = reg.sandboxFor(user);
    // GIVER holds BOTH — the worthless one (sorts first) AND the valued one (sorts last), seeded AFTER
    // restore so they survive the rebuild. The OLD code keyed on the first factId ⇒ it re-weighed ONLY the
    // worthless `sb-a` every tick and NEVER bartered the valued `sb-z`.
    sb.engine.knowledge.seedBelief(GIVER, { content: "a dull, worthless detail about a well-liked houseguest", factId: FACT_WORTHLESS, subject: SUBJECT_LOW, confidence: 1 }, "origin");
    sb.engine.knowledge.seedBelief(GIVER, { content: "a juicy secret about a feared houseguest", factId: FACT_VALUED, subject: SUBJECT, confidence: 1 }, "origin");
    return { reg, sb };
  }

  it("spends the top-valued secret (fail-before / pass-after) and never the worthless first-sorted one", () => {
    const { sb } = twoSecretGame("top-secret", 7);
    // Fail-before: the wanter holds NEITHER secret.
    expect(holds(sb, WANTER, FACT_VALUED), "wanter has not learned the valued secret yet").toBe(false);
    expect(holds(sb, WANTER, FACT_WORTHLESS), "wanter has not learned the worthless secret yet").toBe(false);

    sb.session.setSecretBarterEnabled(true);
    for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge);

    // Pass-after: the holder bartered its TOP-valued secret to the valuing recipient — THE FIX. Under the
    // OLD lexicographically-first selection the giver only ever re-weighed the worthless `sb-a`, so the
    // valued `sb-z` NEVER moved — this assertion fails on the bug (#1438).
    expect(holds(sb, WANTER, FACT_VALUED), "the valued (top) secret reached its wanter").toBe(true);
    // …and the worthless first-sorted secret sits below the barter floor for everyone ⇒ it never changes hands.
    expect(holds(sb, WANTER, FACT_WORTHLESS), "the worthless first-sorted secret is never the one bartered").toBe(false);
    for (const n of [npc(5), npc(6), SUBJECT]) {
      expect(holds(sb, n, FACT_WORTHLESS), "the worthless secret stays with only the giver").toBe(false);
    }
    expect(sb.session.snapshot().secretBarterCount ?? 0, "a secret was spent into the hidden economy").toBeGreaterThan(0);
  });
});
