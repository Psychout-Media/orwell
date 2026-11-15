import { describe, it, expect } from "vitest";
import { npc, PLAYER } from "../../src/domain/ids";
import { ARCHETYPES } from "../../src/engine/characterFactory";
import { validateCastGenesis, publicProseRepeatsHidden } from "../../src/engine/castGenesis";
import type { CastGenesisProposal, GenesisContext, GenesisNpcContext } from "../../src/engine/castGenesis";

/**
 * ORW-286 item 7 (Ryne, BDD cards 30-33): the model-written free-text `identityConcept` feeds the PORTRAIT prompt ("Character: ...") and the player's card, and the genesis model writes it in the
 * same proposal as that houseguest's HIDDEN elements. It must not repeat them. The engine strips a public identity that echoes a hidden element's text (the floor stands without a freeform identity)
 * and never puts the hidden text in the violation. A paraphrase is not caught (stated limit); an unrelated identity is untouched. Roles only; hidden text is a sentinel.
 */
const NATO = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "Yankee", "Zulu", "Nova", "Onyx", "Perry", "Reed", "Sable", "Vesper"];
const synth = (i: number): string => `${NATO[i % NATO.length]} ${NATO[(i + 7) % NATO.length]}`;
function ctx15(): GenesisContext {
  const npcs: GenesisNpcContext[] = Array.from({ length: 15 }, (_, i) => ({
    id: npc(i + 1), floorArchetype: ARCHETYPES[i % ARCHETYPES.length]!.archetype, floorStats: { ...ARCHETYPES[i % ARCHETYPES.length]!.bias }, floorName: synth(i),
  }));
  return { npcs, playerId: PLAYER };
}
const SECRET = "SENTINELX quietly sabotaged the previous winner's finale speech";
const HIDDEN = [
  { kind: "divergent-persona", detail: "smiles through a grudge" },
  { kind: "pre-game-tie", detail: "knew a producer" },
  { kind: "secret-motive", detail: SECRET },
];
function proposalWith(identity: string): CastGenesisProposal {
  const ctx = ctx15();
  return { npcs: ctx.npcs.map((c, i) => (i === 0 ? { id: c.id, identity, hiddenElements: HIDDEN } : { id: c.id })) };
}

describe("publicProseRepeatsHidden — the pure check", () => {
  it("catches a verbatim run of words, ignoring case and punctuation", () => {
    expect(publicProseRepeatsHidden("A podcaster who, SENTINELX Quietly sabotaged the previous winner's finale!", [SECRET])).toBe(true);
  });
  it("does not fire on an unrelated identity, on generic overlap, or on a too-short detail", () => {
    expect(publicProseRepeatsHidden("a chaos-agent podcaster who treats the house like a live show", [SECRET])).toBe(false);
    expect(publicProseRepeatsHidden("sabotaged nothing; the previous winner loves her", [SECRET])).toBe(false);   // words overlap, no 4-word run
    expect(publicProseRepeatsHidden("is jealous of everyone", ["is jealous"])).toBe(false);                      // a 2-word detail is too generic to match on
  });
});

describe("validateCastGenesis — the public identity may not repeat a hidden element (ORW-286 item 7)", () => {
  it("strips an identity that echoes a hidden element, and the violation never carries the hidden text", () => {
    const res = validateCastGenesis(proposalWith("an ER nurse who SENTINELX quietly sabotaged the previous winner's finale speech last year"), ctx15());
    const first = res.npcs[0]!;
    expect(first.identityConcept).toBeUndefined();                                            // the floor stands without a freeform identity
    expect(first.hiddenElements?.some((e) => e.detail === SECRET)).toBe(true);                // the hidden element itself is still committed (Vault side)
    const v = res.violations.find((x) => x.npcId === npc(1) && x.field === "identity");
    expect(v).toMatchObject({ rule: "public identity repeats a hidden element", action: "stripped" });
    expect(JSON.stringify(res.violations)).not.toContain("SENTINELX");                        // never echoes the hidden value
  });
  it("keeps an identity that does not repeat one (the control: the check is not stripping everything)", () => {
    const identity = "a chaos-agent podcaster who treats the house like a live show";
    const res = validateCastGenesis(proposalWith(identity), ctx15());
    expect(res.npcs[0]!.identityConcept).toBe(identity);
    expect(res.violations.some((x) => x.field === "identity")).toBe(false);
  });
});
