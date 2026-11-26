import { describe, it, expect } from "vitest";
import { playUntil } from "./playedSeason";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-962 (leftover of ORW-851): a standing deal offer a houseguest has floated reached the narrator only through the state read (its own voicing instruction rides `openDealOffer.howToVoice`), so an offer the model did
 * not go and look up was never voiced. It was open in all six played seasons that were probed. Real path: the scripted talking player plays seed 1 until the engine has an offer standing; the moment prompt must then name
 * who offers, the kind and the terms, and carry the engine's own instruction for answering. Reads only; nothing is set by hand. Roles only.
 */
describe("a standing deal offer is in the narrator's moment prompt (played)", () => {
  it("while an offer stands the prompt names who, the kind, the terms and how to answer", async () => {
    const at = await playUntil(1, (s) => !!s.sess.gameStatus().openDealOffer, { user: "wf-1", maxMessages: 1500 });
    const offer = at.sess.gameStatus().openDealOffer!;
    const line = (at.sess.getMomentPrompt({}).systemPrompt as string).split("\n").find((l: string) => l.startsWith("- STANDING DEAL OFFER")) ?? "";
    expect(line, "the prompt carries the standing-offer line").not.toBe("");
    expect(line).toContain(offer.from.name);
    expect(line).toContain(offer.kind);
    expect(line).toContain(offer.terms);
    expect(line).toContain("submitDecision");
  }, 600_000);
  it("with no offer standing there is no such line", () => {
    const s = new GameSessionRegistry().sandboxFor("no-offer").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 5 });
    s.noteMessage({ messageId: "m0" });
    expect(s.gameStatus().openDealOffer ?? null).toBeNull();
    expect(s.getMomentPrompt({}).systemPrompt as string).not.toContain("- STANDING DEAL OFFER");
  });
});
