import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * B4 slice 8 - the other half of the assurance fold: an assurance that is KEPT (the HOH finalized nominations without the houseguest they had assured safe/loyal; a voter voted the OTHER nominee out
 * after assuring this one 'vote'/'safe') is resolved kept ONCE and the assured remembers a favor (the 0024 ledger's `deal-kept`). Flag-off (ORWELL_ASSURANCES) nothing changes. Roles only.
 */
type G = {
  recordAssurance(a: unknown): void; setAssurancesEnabled(on: boolean): void;
  assuranceKeptAtNominations(h: string, ns: string[]): void; assuranceKeptAtVote(v: string, sp: string): void;
  assuranceNominated(h: string, n: string): void;
};
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`asrkept-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  sb.session.setAssurancesEnabled(true);
  const [holder, assured, other] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { sb, g: sb.session as unknown as G, holder: holder!, assured: assured!, other: other! };
}
const statuses = (sb: { session: { snapshot(): { live?: unknown } } }) => ((sb.session.snapshot().live as { assurances?: { items: { status: string; to: string }[] } }).assurances?.items ?? []).map((i) => i.status);
const memory = (sb: { session: { snapshot(): { live?: unknown } } }, holder: string, subject: string) => ((sb.session.snapshot().live as { npcMemory?: Record<string, Record<string, { kind: string }[]>> }).npcMemory?.[holder]?.[subject] ?? []).map((e) => e.kind);

describe("a kept assurance (B4 slice 8)", () => {
  it("nominations that spare the assured resolve a 'safe' assurance kept (once) and the assured remembers a favor", () => {
    const { sb, g, holder, assured, other } = started();
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    g.assuranceKeptAtNominations(holder, [other, PLAYER]); g.assuranceKeptAtNominations(holder, [other, PLAYER]);
    expect(statuses(sb)).toEqual(["kept"]);
    expect(memory(sb, assured, holder)).toEqual(["deal-kept"]);
  });
  it("nominating the assured is a break, not a keep", () => {
    const { sb, g, holder, assured, other } = started();
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    g.assuranceNominated(holder, assured);
    g.assuranceKeptAtNominations(holder, [assured, other]);
    expect(statuses(sb)).toEqual(["broken"]);
  });
  it("a 'vote' assurance is kept when the voter spares the assured, and is not kept by nominations (wrong kind)", () => {
    const { sb, g, holder, assured } = started();
    g.recordAssurance({ from: holder, to: assured, kind: "vote", sincerity: 1, source: "npc" });
    g.assuranceKeptAtNominations(holder, []);
    expect(statuses(sb)).toEqual(["open"]);
    g.assuranceKeptAtVote(holder, assured);
    expect(statuses(sb)).toEqual(["kept"]);
  });
  it("flag off: nothing resolves", () => {
    const { sb, g, holder, assured, other } = started();
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    g.setAssurancesEnabled(false);
    g.assuranceKeptAtNominations(holder, [other, PLAYER]);
    expect(statuses(sb)).toEqual(["open"]);
  });
  it("liveSeason calls both hooks exactly once, at the nominations and the vote tally", () => {
    const src = readFileSync("src/engine/liveSeason.ts", "utf8");
    expect(src.match(/ctx\.assuranceKeptAtNominations\?\.\(s\.hoh!, nominees\)/g)?.length).toBe(1);
    expect(src.match(/ctx\.assuranceKeptAtVote\(v,/g)?.length).toBe(1);
  });
});
