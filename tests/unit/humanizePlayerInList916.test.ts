import { describe, it, expect } from "vitest";
import { humanizeIds } from "../../src/domain/humanize";

/**
 * ORW-916 (Fable week-1 run): the player's own competition drop was never told. The staged-comp round line lists the dropped by id ("npc:7, player fall behind and are out; 5 remain. player quietly slips out"), and the bare-word
 * player id was left as the ordinary word whenever the text before it, skipping punctuation, ended in a content word or an id: after a list comma ("npc:7, player") and at a sentence start ("5 remain. player ..."). The narrator was then
 * handed a raw lowercase "player" in the very place the player's own result stood. Roles only: the player and an NPC.
 */
const ents = [{ id: "player", name: "Player Name" }, { id: "npc:7", name: "Other Name" }];

describe("a bare player id that stands as a list item or opens a sentence is the player, not the dictionary word", () => {
  it("resolves after a list comma and at a sentence start", () => {
    expect(humanizeIds("npc:7, player fall behind and are out; 5 remain. player quietly slips out.", ents)).toBe("Other Name, Player Name fall behind and are out; 5 remain. Player Name quietly slips out.");
  });
  it("resolves at the end of a list after a semicolon or an 'and'", () => {
    expect(humanizeIds("npc:7 and player come up short; player is out.", ents)).toBe("Other Name and Player Name come up short; Player Name is out.");
  });
  it("still leaves the ordinary word alone after a content word with no punctuation", () => {
    expect(humanizeIds("a poker player and every player; the social player", ents)).toBe("a poker player and every player; the social player");
    expect(humanizeIds("outlast every player in the house", ents)).toBe("outlast every player in the house");
  });
});
