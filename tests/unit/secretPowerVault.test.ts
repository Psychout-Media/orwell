import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { UserSandbox } from "../../src/composition/registry";
import { LEVERAGE, SECRET_TRADE } from "../../src/engine/leverageConstants";
import type { ExposeResult, TradeResult } from "../../src/ports/GameSession";

/**
 * Features 0093 + 0099 — the load-bearing VAULT SENTINEL sweep (player AND admin). Secrets-as-power must
 * NEVER cross a magnitude or a hidden standing delta to the player OR the admin, the player can ONLY
 * wield a secret they legitimately learned (the bright line — no Vault-minting), a bluff reads NOTHING
 * from the Vault (and the engine never confirms whether it matched a truth), and no NPC↔NPC bartered
 * fact reaches the player without a pathway. Roles only — no names; all fixtures generated.
 */

function startedSeason(user: string, seed: number): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}

/** Plant a learned secret about `subject` into the player's knowledge; return the wieldable factId. */
function learnSecretAbout(sb: UserSandbox, subject: EntityId): string {
  sb.engine.knowledge.seedBelief(subject, { content: `a learned secret about ${subject}`, originalContent: "x", factId: `seed:${subject}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: `a learned secret about ${subject}`, subject, confidence: 0.85 }, `told-by:${subject}`);
  const fact = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === subject)!;
  return fact.factId ?? fact.id;
}

/** Every assembled player-facing projection, as one string to sweep for sentinels/numbers. */
function allPlayerProjections(sb: UserSandbox): string {
  const s = sb.session;
  const npcs = s.livingIds().filter((id) => id !== PLAYER);
  return [
    JSON.stringify(s.getGameState()),
    JSON.stringify(s.gameStatus()),
    JSON.stringify(s.seasonRecap()),
    JSON.stringify(s.whereabouts()),
    ...npcs.map((id) => JSON.stringify(s.npcVoice(id))),
  ].join("\n---\n");
}

/** The admin/God-Mode projection (walled from the Vault too — mandate #2). */
function adminProjection(sb: UserSandbox): string {
  return JSON.stringify(sb.admin.inspect());
}

/** Any relationship/magnitude scalar leaking as a decimal (the anti-sycophancy no-number rule). */
const NO_NUMBER = /[-+]?\d+\.\d+/;

describe("0093/0099 — the player can ONLY wield a secret they legitimately learned (the bright line)", () => {
  it("a secret the player has NOT learned offers no lever — expose/trade/leverage are all rejected", () => {
    const sb = startedSeason("vw-reject", 1);
    const subject = sb.session.livingIds().find((id) => id !== PLAYER)!;
    const recipient = sb.session.livingIds().find((id) => id !== PLAYER && id !== subject)!;
    // No learning step — the player references a factId they never held.
    const bogus = "know:never-learned";
    expect(sb.session.exposeSecret({ factId: bogus })).toEqual({ exposed: false, refused: "not-learned" });
    expect(sb.session.tradeSecret({ factId: bogus, toNpcId: recipient })).toEqual({ accepted: false, refused: "not-learned" });
    // A leveraged deal still FORMS (additive), but the leverage is ignored (no fold) — proven below.
    const before = JSON.stringify(sb.engine.relationships.edge(subject, PLAYER));
    sb.session.makeDeal({ with: subject, kind: "safety", terms: "x", leverage: { factId: bogus } });
    expect(JSON.stringify(sb.engine.relationships.edge(subject, PLAYER))).toBe(before); // no squeeze fold
  });

  it("a mere SUSPICION (no pathway) is not a wieldable fact", () => {
    const sb = startedSeason("vw-suspicion", 2);
    const subject = sb.session.livingIds().find((id) => id !== PLAYER)!;
    // A suspicion is NOT in knownTo — it never surfaces in the player-knowledge reader.
    sb.engine.knowledge.addSuspicion(PLAYER, { content: "I bet they're hiding something", subject, confidence: 0.4 });
    const suspId = sb.engine.knowledge.suspicionsOf(PLAYER)[0]!.id;
    expect(sb.session.exposeSecret({ factId: suspId })).toEqual({ exposed: false, refused: "not-learned" });
  });

  it("no UNDISCLOSED secret is read to evaluate the attempt — the sealed secret never surfaces", () => {
    const sb = startedSeason("vw-undisclosed", 3);
    const subject = sb.session.livingIds().find((id) => id !== PLAYER)!;
    sb.session.exposeSecret({ factId: "know:never" }); // rejected
    // The subject's actual sealed hidden elements never appear on any player projection.
    const sealed = (sb.session as unknown as { house: { npcs: Array<{ id: EntityId; character: { hiddenElements?: Array<{ detail: string }> } }> } }).house
      .npcs.find((n) => n.id === subject)!.character.hiddenElements?.map((e) => e.detail) ?? [];
    const projections = allPlayerProjections(sb) + adminProjection(sb);
    for (const detail of sealed) expect(projections.includes(detail)).toBe(false);
  });
});

describe("0093/0099 — no magnitude / hidden standing delta crosses to the player OR the admin", () => {
  it("after a leverage + expose + trade, no player projection carries a number or a magnitude", () => {
    const sb = startedSeason("vw-nonum", 4);
    const subject = sb.session.livingIds().find((id) => id !== PLAYER)!;
    const recipient = sb.session.livingIds().find((id) => id !== PLAYER && id !== subject)!;
    const f1 = learnSecretAbout(sb, subject);
    sb.session.makeDeal({ with: subject, kind: "safety", terms: "keep me safe", leverage: { factId: f1 } });
    const f2 = learnSecretAbout(sb, recipient); // a secret about the recipient's rival to trade
    sb.session.tradeSecret({ factId: f2, toNpcId: subject, askKind: "vote" });
    const f3 = learnSecretAbout(sb, subject);
    sb.session.exposeSecret({ factId: f3 });

    const proj = allPlayerProjections(sb);
    // The lever constants (the magnitudes) must never appear, and no relationship decimal leaks.
    for (const n of [LEVERAGE.dealFactorCap, LEVERAGE.exposeSubjectHit.threat!, SECRET_TRADE.dealFactorCap]) {
      expect(proj.includes(String(n))).toBe(false);
    }
    // Strip the public beatSeq counter (an integer, not a magnitude) before the no-decimal sweep.
    expect(proj).not.toMatch(NO_NUMBER);
  });

  it("the result objects carry NO number — only a Vault-safe narratable phrase", () => {
    const sb = startedSeason("vw-result", 5);
    const subject = sb.session.livingIds().find((id) => id !== PLAYER)!;
    const f = learnSecretAbout(sb, subject);
    const res = sb.session.exposeSecret({ factId: f })!;
    expect(JSON.stringify(res)).not.toMatch(NO_NUMBER);
    expect(res.exposed).toBe(true);
  });

  it("the ADMIN / God-Mode projection is walled too — no leverage strength or hidden standing delta", () => {
    const sb = startedSeason("vw-admin", 6);
    const subject = sb.session.livingIds().find((id) => id !== PLAYER)!;
    const f = learnSecretAbout(sb, subject);
    sb.session.exposeSecret({ factId: f });
    const adminOut = adminProjection(sb);
    for (const n of [LEVERAGE.exposeSubjectHit.threat!, LEVERAGE.exposerBacklashFromSubject.trust!]) {
      expect(adminOut.includes(String(n))).toBe(false);
    }
    // The admin sees Vault-free roster/ceremony facts only — never the secret-power magnitudes.
    expect(adminOut).not.toMatch(/leverageStrength|exposeSubjectHit|tradeValue/);
  });
});

describe("0093 — information becomes power (a holder gains an option a non-holder lacks)", () => {
  it("a player who LEARNED a secret can expose it (engine resolves); a player without it is rejected", () => {
    // Holder: learned ⇒ expose succeeds. Non-holder: same season, a DIFFERENT subject they never learned.
    const sb = startedSeason("vw-power", 7);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const known = npcs[0]!;
    const unknown = npcs[1]!;
    const f = learnSecretAbout(sb, known);
    const exposedKnown = sb.session.exposeSecret({ factId: f }) as ExposeResult;
    const exposedUnknown = sb.session.exposeSecret({ factId: `know:none-${unknown}` }) as ExposeResult;
    expect(exposedKnown.exposed).toBe(true); // holding the secret unlocked the concrete action
    expect(exposedUnknown.exposed).toBe(false); // without it, the same action is unavailable
  });
});

describe("0093 — leverage colors a deal but never forces it; expose is bounded + recorded + capped", () => {
  it("a WARY houseguest (high threat, low warmth) can refuse the squeeze and resent it", () => {
    const sb = startedSeason("vw-wary", 8);
    const subject = sb.session.livingIds().find((id) => id !== PLAYER)!;
    // Make the subject hostile to the player so even a max leverage lands below the refusal floor.
    const e = sb.engine.relationships.edge(subject, PLAYER);
    e.trust = 0.0; e.affinity = 0.0; e.threat = 0.95;
    const f = learnSecretAbout(sb, subject);
    const before = { ...sb.engine.relationships.edge(subject, PLAYER) };
    sb.session.makeDeal({ with: subject, kind: "safety", terms: "or this gets out", leverage: { factId: f } });
    const after = sb.engine.relationships.edge(subject, PLAYER);
    // The squeeze RESENTS: their read of the player sours (trust down / threat up) — never a number to the player.
    expect(after.trust).toBeLessThanOrEqual(before.trust);
    expect(after.threat).toBeGreaterThanOrEqual(before.threat);
  });

  it("expose RECORDS a witnessed pathway event so the house now KNOWS it (never a Vault read)", () => {
    const sb = startedSeason("vw-record", 9);
    const subject = sb.session.livingIds().find((id) => id !== PLAYER)!;
    const other = sb.session.livingIds().find((id) => id !== PLAYER && id !== subject)!;
    const f = learnSecretAbout(sb, subject);
    sb.session.exposeSecret({ factId: f });
    // Another houseguest now holds the exposed fact in their KNOWLEDGE (a recorded pathway, not the Vault).
    const otherKnows = sb.engine.knowledge.knownTo(other).some((k) => k.subject === subject);
    expect(otherKnows).toBe(true);
  });

  it("expose is CAPPED per season and a used secret cannot be wielded again", () => {
    const sb = startedSeason("vw-cap", 10);
    // The per-season cap is the premise: ORWELL_NO_HARD_CAPS (default ON since 2026-11-05) replaces it with an escalating cost, so pin it OFF explicitly.
    (sb.session as unknown as { setNoHardCapsEnabled(on: boolean): void }).setNoHardCapsEnabled(false);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    // Spend the whole season cap on distinct learned secrets.
    let exposed = 0;
    for (let i = 0; i < npcs.length && i < LEVERAGE.maxExposesPerSeason + 2; i++) {
      const f = learnSecretAbout(sb, npcs[i]!);
      const r = sb.session.exposeSecret({ factId: f }) as ExposeResult;
      if (r.exposed) exposed++;
    }
    expect(exposed).toBe(LEVERAGE.maxExposesPerSeason); // exactly the cap was spent
    // The next expose — a FRESH secret about a never-exposed houseguest — is refused for the cap.
    const freshSubject = npcs[LEVERAGE.maxExposesPerSeason]!;
    const fExtra = learnSecretAbout(sb, freshSubject);
    expect((sb.session.exposeSecret({ factId: fExtra }) as ExposeResult).refused).toBe("capped");

    // And a used (exposed) secret can't be re-leveraged.
    const sb2 = startedSeason("vw-spent", 11);
    const subj = sb2.session.livingIds().find((id) => id !== PLAYER)!;
    const f = learnSecretAbout(sb2, subj);
    expect((sb2.session.exposeSecret({ factId: f }) as ExposeResult).exposed).toBe(true);
    expect((sb2.session.exposeSecret({ factId: f }) as ExposeResult).refused).toBe("already-spent");
  });
});

describe("0099 — a traded secret is valued to the recipient; the recipient learns it via a pathway", () => {
  it("a secret about a recipient's RIVAL is taken; the recipient then holds it (told pathway, not Vault)", () => {
    const sb = startedSeason("vw-trade", 12);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!; // the secret's subject (a rival of the recipient)
    const recipient = npcs[1]!;
    // Make the recipient fear/distrust the subject so the secret is VALUABLE to them.
    const re = sb.engine.relationships.edge(recipient, subject);
    re.threat = 0.9; re.affinity = 0.05;
    // And warm the recipient to the player so they accept the offer.
    const rp = sb.engine.relationships.edge(recipient, PLAYER);
    rp.trust = 0.7; rp.affinity = 0.7; rp.threat = 0.05;
    const f = learnSecretAbout(sb, subject);
    const res = sb.session.tradeSecret({ factId: f, toNpcId: recipient, askKind: "vote" }) as TradeResult;
    expect(res.accepted).toBe(true);
    expect(sb.engine.knowledge.knownTo(recipient).some((k) => k.subject === subject)).toBe(true);
  });

  it("a per-season trade count + usedAs survive a restart (non-degradation)", () => {
    const sb = startedSeason("vw-persist", 13);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!;
    const recipient = npcs[1]!;
    const rp = sb.engine.relationships.edge(recipient, PLAYER); rp.trust = 0.7; rp.affinity = 0.7; rp.threat = 0.05;
    const re = sb.engine.relationships.edge(recipient, subject); re.threat = 0.9; re.affinity = 0.05;
    const f = learnSecretAbout(sb, subject);
    const res = sb.session.tradeSecret({ factId: f, toNpcId: recipient, askKind: "vote" }) as TradeResult;
    expect(res.accepted).toBe(true);
    const core = sb.session.snapshot();
    expect(core.secretTradeCount).toBe(1);
    expect(core.secretUsedAs?.[f]).toBe("traded");
  });
});

describe("deception — a bluff reads NOTHING from the Vault, and the engine never confirms a match", () => {
  it("a bluff expose needs no learned fact and never reveals whether it matched a real truth", () => {
    const sb = startedSeason("vw-bluff", 14);
    const subject = sb.session.livingIds().find((id) => id !== PLAYER)!;
    // No learning step. A pure bluff — invents a claim about the subject.
    const res = sb.session.exposeSecret({ bluff: true, subject }) as ExposeResult;
    expect(res).toBeTruthy();
    // The result NEVER carries a truth marker or a number — the engine refuses to confirm a match.
    expect(JSON.stringify(res)).not.toMatch(/truthful|matched|real|wasTrue/);
    expect(JSON.stringify(res)).not.toMatch(NO_NUMBER);
    // No undisclosed secret of the subject was read to evaluate the bluff (sealed details stay sealed).
    const sealed = (sb.session as unknown as { house: { npcs: Array<{ id: EntityId; character: { hiddenElements?: Array<{ detail: string }> } }> } }).house
      .npcs.find((n) => n.id === subject)!.character.hiddenElements?.map((e) => e.detail) ?? [];
    const proj = allPlayerProjections(sb);
    for (const d of sealed) expect(proj.includes(d)).toBe(false);
  });
});
