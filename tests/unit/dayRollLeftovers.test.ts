import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { CLOCK } from "../../src/engine/sleepConstants";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-400: (1) the daily recap / day ledger carried raw gossip drift markers ("... · roughly#702") and repeated the same overheard line;
 * (2) presenceTenure / convoPartners survived the night, so the morning opened with last night's tenure. Roles only; no model.
 */
const RAW = "word in the house: the HOH is lying · roughly#702 · supposedly#813";
const fact = (content: string, i: number) => ({ id: `f${i}`, content, subject: "npc:1", factId: `fact${i}`, pathway: "overheard:evt:1" });

function rig(seed: number, facts: ReturnType<typeof fact>[]) {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setPlayerKnowledgeReader(() => facts as never);
  session.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
  session.createCharacter({ playerName: "The Player", seed });
  session.noteMessage({ messageId: "m-1" } as never);
  const i = session as any;
  i.live.nightDepth = CLOCK.wakeHour + 6;
  return { session, i };
}

describe("ORW-400 recap gossip markers", () => {
  it("surfaced lines and the day ledger carry no raw drift marker, and an identical line appears once", () => {
    const { i } = rig(41, [fact(RAW, 1), fact(RAW, 2), fact(RAW, 3)]);
    const recap = i.buildRecapForDay(1);
    expect(recap.surfaced.join("|")).not.toMatch(/#\d+/);
    expect(recap.surfaced).toHaveLength(1);
    const ledger = (i.live.dayLedger ?? []).flatMap((d: { events: string[] }) => d.events).join("|");
    expect(ledger).not.toMatch(/#\d+/);
  });
});

describe("ORW-400 day roll leftovers", () => {
  it("a played game's morning starts with zero tenure and no conversation partners", () => {
    const { session, i } = rig(42, []);
    i.presenceTenure = new Map([["npc:1", 27], [PLAYER, 27]]);
    i.convoPartners = { ids: ["npc:1"], tick: i.presenceTickCount };
    i.live.timeOfDay = "night";
    session.turnIn();
    expect([...(i.presenceTenure?.values() ?? [])].every((n: number) => n === 0)).toBe(true);
    expect(i.convoPartners).toBeNull();
  });

  it("a headless game's tenure is left alone by the recap", () => {
    const sb = buildSandbox(43);
    const session = new GameSessionAdapter();
    session.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
    session.createCharacter({ playerName: "The Player", seed: 43 });
    const i = session as any;
    i.presenceTenure = new Map([["npc:1", 27]]);
    i.buildRecapForDay(1);
    expect(i.presenceTenure.get("npc:1")).toBe(27);
  });
});
