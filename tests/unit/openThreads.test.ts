import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSandbox } from "../support/sandbox";
import { PLAYER as PLAYER_ID } from "../../src/domain/ids";
import { BRIEF_THREADS_MAX, openThreadsSection } from "../../src/engine/showBrief";

/**
 * ORW-223 slice 2 - the Show Brief OPEN THREADS section: kind and status only, bounded, Vault-free, played games only,
 * and absent (byte-identical brief) when nothing is in motion. Roles only.
 */
const PLAYER = "player";
type Priv = { deals: { make: (...a: unknown[]) => unknown }; livingIds(): string[]; nameOf(id: string): string };

function played(seed = 21): GameSessionAdapter {
  const g = new GameSessionAdapter();
  g.createCharacter({ playerName: "The Player", seed });
  g.noteMessage({ messageId: `m-${seed}-1` });
  return g;
}
const brief = (g: GameSessionAdapter) => g.getMomentPrompt({ brief: {} }).showBrief!;
const partner = (g: GameSessionAdapter): string => (g as unknown as Priv).livingIds().find((id) => id !== (g.getGameState().player!.id))!;

describe("openThreadsSection (pure)", () => {
  it("is undefined when empty, capped at the max, de-duplicated and deterministic", () => {
    expect(openThreadsSection(undefined)).toBeUndefined();
    expect(openThreadsSection([])).toBeUndefined();
    const many = Array.from({ length: 12 }, (_, i) => `a deal with person ${i}: still standing`);
    const s = openThreadsSection([...many, many[0]!])!;
    expect(s.split("\n").filter((l) => l.startsWith("- ")).length).toBe(BRIEF_THREADS_MAX);
    expect(s).toBe(openThreadsSection([...many, many[0]!]));
  });
});

describe("the brief's OPEN THREADS section", () => {
  it("a quiet played game has no section (byte-identical brief)", () => {
    const g = played();
    const b = brief(g);
    expect(b.text).not.toContain("OPEN THREADS");
    expect(b.sections.map((s) => s.id)).toEqual(["header", "now", "changed", "established"]);
  });

  it("a standing deal appears by kind and status, with no id, term or number", () => {
    const g = played(22);
    const p = g.getGameState().player!.id;
    const other = partner(g);
    (g as unknown as Priv).deals.make([p, other], "safety", "SENTINEL-DEAL-TERMS-1", undefined, 1);
    const b = brief(g);
    const sec = b.text.slice(b.text.indexOf("5. OPEN THREADS"));
    expect(sec).toContain(`a deal with ${(g as unknown as Priv).nameOf(other)}: still standing`);
    expect(b.sections.map((s) => s.id).at(-1)).toBe("threads");
    expect(b.text).not.toContain("SENTINEL-DEAL-TERMS-1");
    expect(sec.split("\n").slice(1).join("\n")).not.toMatch(/deal:|npc:|\d/);
    expect(brief(g).text).toBe(b.text); // pure read
  });

  it("a vague deal reads as running out; a throw promise reads as a promise owed", () => {
    const g = played(23);
    const p = g.getGameState().player!.id;
    const ids = (g as unknown as Priv).livingIds().filter((id) => id !== p);
    (g as unknown as Priv).deals.make([p, ids[0]!], "safety", "x", undefined, 1, { vague: true });
    (g as unknown as Priv).deals.make([p, ids[1]!], "comp-throw", "y", undefined, 1);
    const t = brief(g).text;
    expect(t).toContain(`a deal with ${(g as unknown as Priv).nameOf(ids[0]!)}: running out`);
    expect(t).toContain(`a promise you owe ${(g as unknown as Priv).nameOf(ids[1]!)}: still open`);
  });

  it("not a played game (headless): no section even with a deal", () => {
    const g = new GameSessionAdapter();
    g.createCharacter({ playerName: "The Player", seed: 24 });
    const p = g.getGameState().player!.id;
    (g as unknown as Priv).deals.make([p, partner(g)], "safety", "z", undefined, 1);
    expect(brief(g).text).not.toContain("OPEN THREADS");
  });

  it("the section never exceeds the cap even with many deals", () => {
    const g = played(25);
    const p = g.getGameState().player!.id;
    for (const id of (g as unknown as Priv).livingIds().filter((i) => i !== p)) (g as unknown as Priv).deals.make([p, id], "safety", "t", undefined, 1);
    const sec = brief(g).text.slice(brief(g).text.indexOf("5. OPEN THREADS"));
    expect(sec.split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(BRIEF_THREADS_MAX);
  });
});

describe("the Vault Wall (hidden-state sentinels)", () => {
  it("hidden event, hidden element, Vault confessional and Diary Room entry never reach the brief or the section", () => {
    const sb = buildSandbox(41);
    const g = new GameSessionAdapter();
    g.setPlayerKnowledgeReader(() => sb.engine.knowledge.knownTo(PLAYER_ID).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId, pathway: f.pathway })));
    g.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
    g.createCharacter({ playerName: "The Player", seed: 41 });
    g.noteMessage({ messageId: "m-41-1" });
    const npcs = (g as unknown as Priv).livingIds().filter((id) => id !== PLAYER_ID);
    const [a, b] = npcs;
    const EV = "SENTINEL-OT-HIDDEN-EVENT-1", EL = "SENTINEL-OT-HIDDEN-ELEMENT-2", CF = "SENTINEL-OT-CONFESSIONAL-3", DR = "SENTINEL-OT-DIARY-4";
    sb.engine.events.record({ id: "ot:hid", ts: 9001, type: "scheme", initiator: a!, witnessSet: [a!, b!], hidden: true, content: EV });
    sb.engine.vault.writeHidden({ id: "ot-el", kind: "hidden-attribute", content: EL });
    sb.engine.vault.writeHidden({ id: "ot-cf", kind: "confessional", content: CF });
    sb.engine.events.record({ id: "ot:cf", ts: 9002, type: "confessional", initiator: a!, witnessSet: [a!], hidden: true, content: CF });
    sb.engine.knowledge.recordDiaryRoom(DR);
    (g as unknown as Priv).deals.make([PLAYER_ID, a!], "safety", "terms", undefined, 1);
    const b1 = g.getMomentPrompt({ brief: {} }).showBrief!;
    expect(b1.text).toContain("5. OPEN THREADS");
    expect(b1.text).toContain("a deal with");
    expect(b1.text).not.toContain("a rumor that reached you"); // the Diary Room is not a pathway
    for (const x of [EV, EL, CF, DR]) expect(JSON.stringify(b1)).not.toContain(x);
  });
});
