import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { ExposeResult } from "../../src/ports/GameSession";

/**
 * Watch list item 10 (ORW-106): a lie that gets caught is held against the player, and a bluff nobody believed costs nothing. Live path: the player BLUFFS an expose (the house believes it), later
 * really exposes the true secret, and the bluff is caught. Every houseguest who believed the bluff now believes the player LESS (credibility < 1, from their own lied-to-me claim); the subject, who
 * never believed it, and a game with no bluff are untouched (credibility 1). Flags set explicitly (lies-caught, credibility, beliefs). Roles only.
 */
type G = { credibilityOf(observer: EntityId, speaker: EntityId): number; setCredibilityEnabled(on: boolean): void; setLiesCaughtEnabled(on: boolean): void; setNpcBeliefsEnabled(on: boolean): void };
function season(user: string, seed: number, liesCaught = true): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const g = sb.session as unknown as G;
  g.setNpcBeliefsEnabled(true); g.setCredibilityEnabled(true); g.setLiesCaughtEnabled(liesCaught);
  return sb;
}
const edge = (sb: UserSandbox, a: EntityId, b: EntityId) => sb.engine.relationships.edge(a, b);
const npcsOf = (sb: UserSandbox): EntityId[] => sb.session.livingIds().filter((id) => id !== PLAYER);
function learnSecretAbout(sb: UserSandbox, subject: EntityId): string {
  sb.engine.knowledge.seedBelief(subject, { content: `the truth about ${subject}`, originalContent: "x", factId: `seed:${subject}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: `the truth about ${subject}`, subject, confidence: 0.85 }, `told-by:${subject}`);
  const fact = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === subject)!;
  return fact.factId ?? fact.id;
}
/** The house trusts the player and fears the subject, so a bluff about the subject is believed. */
function primeHouse(sb: UserSandbox, subject: EntityId): void {
  for (const id of npcsOf(sb)) {
    if (id === subject) continue;
    const e = edge(sb, id, PLAYER); e.trust = 0.9; e.affinity = 0.8; e.threat = 0.05;
    const es = edge(sb, id, subject); es.threat = 0.9; es.affinity = 0.05;
  }
}
const cred = (sb: UserSandbox, observer: EntityId): number => (sb.session as unknown as G).credibilityOf(observer, PLAYER);

describe("a caught lie costs the liar credibility with exactly those who believed it (live expose path)", () => {
  it("bluff, then the real expose: every believer believes the player less; the subject and a no-bluff control do not", () => {
    const sb = season("cred-live-treat", 5);
    const subject = npcsOf(sb)[0]!;
    primeHouse(sb, subject);
    const believers = npcsOf(sb).filter((id) => id !== subject);
    for (const id of npcsOf(sb)) expect(cred(sb, id), "before anything, the player is fully believed").toBe(1);
    expect((sb.session.exposeSecret({ bluff: true, subject }) as ExposeResult).exposed).toBe(true);
    for (const id of believers) expect(cred(sb, id), "a bluff nobody has caught yet costs nothing").toBe(1);
    expect((sb.session.exposeSecret({ factId: learnSecretAbout(sb, subject) }) as ExposeResult).exposed).toBe(true);
    for (const id of believers) expect(cred(sb, id), `${id} caught the lie and believes the player less`).toBeLessThan(1);
    expect(cred(sb, subject), "the subject never believed the bluff, so holds nothing against the player").toBe(1);
  });

  it("control: a TRUE expose with no earlier bluff costs no one any credibility", () => {
    const sb = season("cred-live-control", 5);
    const subject = npcsOf(sb)[0]!;
    primeHouse(sb, subject);
    expect((sb.session.exposeSecret({ factId: learnSecretAbout(sb, subject) }) as ExposeResult).exposed).toBe(true);
    for (const id of npcsOf(sb)) expect(cred(sb, id)).toBe(1);
  });

  it("mutant control: with lies-caught off the same bluff-then-expose leaves everyone fully believing the player", () => {
    const sb = season("cred-live-off", 5, false);
    const subject = npcsOf(sb)[0]!;
    primeHouse(sb, subject);
    sb.session.exposeSecret({ bluff: true, subject });
    sb.session.exposeSecret({ factId: learnSecretAbout(sb, subject) });
    for (const id of npcsOf(sb)) expect(cred(sb, id)).toBe(1);
  });
});
