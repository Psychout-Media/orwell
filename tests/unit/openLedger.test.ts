import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { sessionCoreIsSuperset } from "../../src/engine/sessionSnapshot";
import { openLedgerProposal, OPEN_LEDGER_TEXT_MAX } from "../../src/engine/openLedger";
import type { SessionSnapshot as SessionCore } from "../../src/engine/sessionSnapshot";

/**
 * ORW-407 slice 1 - the open ledger: a commitment or claim made to or by the player in narration is kept as free text
 * with provenance, survives a save, is shown back when that houseguest is present, is not duplicated, and changes no
 * relationship number. Roles only; the cast comes from a seed.
 */
type Priv = { openLedger: { entries: Array<Record<string, unknown>> } };

function played(seed = 11): GameSessionAdapter {
  const g = new GameSessionAdapter();
  g.createCharacter({ playerName: "The Player", seed });
  g.noteMessage({ messageId: `m-${seed}-1` });
  return g;
}
/** A houseguest who is in the player's room right now, moving the player to one if needed. */
function withCompanion(g: GameSessionAdapter): string {
  for (const room of ["living-room", "kitchen", "backyard", "bedroom", "bathroom"]) {
    const wa = g.movePlayer(room) ?? g.whereabouts();
    const who = wa?.present.find((p) => p.id !== g.getGameState().player?.id);
    if (who) return who.id as string;
  }
  throw new Error("no companion found");
}
const briefText = (g: GameSessionAdapter): string => g.getMomentPrompt({ brief: {} }).showBrief?.text ?? "";
const WORDS = "I promise I will never put you up on the block this week";
const req = (id: string, text = WORDS) => ({ text, speaker: id, addressedTo: ["player"], kind: "promise to protect" });

describe("openLedgerProposal (shape gate)", () => {
  const known = new Set(["npc:1", "npc:2"]);
  it("takes exactly four fields and a free-string kind", () => {
    const p = openLedgerProposal({ text: " a  b ", speaker: "npc:1", addressedTo: ["player"], kind: "made-up kind" }, known);
    expect(p).toEqual({ text: "a b", speaker: "npc:1", addressedTo: ["player"], kind: "made-up kind" });
    expect(openLedgerProposal({ text: "x", speaker: "npc:1", addressedTo: ["player"] }, known)).toBe("bad-shape");
    expect(openLedgerProposal({ text: "x", speaker: "npc:1", addressedTo: ["player"], kind: "k", extra: 1 }, known)).toBe("bad-shape");
  });
  it("rejects empty, long, unknown ids and NPC-to-NPC claims (a later slice)", () => {
    expect(openLedgerProposal({ text: " ", speaker: "npc:1", addressedTo: ["player"], kind: "k" }, known)).toBe("empty");
    expect(openLedgerProposal({ text: "x".repeat(OPEN_LEDGER_TEXT_MAX + 1), speaker: "npc:1", addressedTo: ["player"], kind: "k" }, known)).toBe("too-long");
    expect(openLedgerProposal({ text: "x", speaker: "npc:9", addressedTo: ["player"], kind: "k" }, known)).toBe("bad-speaker");
    expect(openLedgerProposal({ text: "x", speaker: "npc:1", addressedTo: ["npc:2"], kind: "k" }, known)).toBe("not-involving-player");
  });
});

describe("recordOpenLedger (the adapter write-back)", () => {
  it("keeps an invented promise verbatim with provenance and witnesses", () => {
    const g = played();
    const id = withCompanion(g);
    const res = g.recordOpenLedger(req(id));
    expect(res).toMatchObject({ accepted: true });
    const e = (g as unknown as Priv).openLedger.entries[0]!;
    expect(e).toMatchObject({ text: WORDS, speaker: id, addressedTo: ["player"], kind: "promise to protect", status: "open" });
    expect(e.witnesses).toContain(id);
    expect(e.witnesses).toContain("player");
    expect(e.room).toBe(g.whereabouts()!.room);
    expect(typeof e.quoteHash).toBe("string");
    expect(typeof e.beatSeq).toBe("number");
  });

  it("is not duplicated on repetition", () => {
    const g = played();
    const id = withCompanion(g);
    g.recordOpenLedger(req(id));
    const again = g.recordOpenLedger(req(id, `  ${WORDS.toUpperCase()}  `));
    expect(again).toMatchObject({ accepted: true, duplicate: true });
    expect((g as unknown as Priv).openLedger.entries.length).toBe(1);
  });

  it("survives a save and restore, and the save never thins", () => {
    const g = played();
    const id = withCompanion(g);
    g.recordOpenLedger(req(id));
    const snap = JSON.parse(JSON.stringify(g.snapshot())) as SessionCore;
    expect((snap as unknown as { openLedger: { entries: unknown[] } }).openLedger.entries.length).toBe(1);
    const h = new GameSessionAdapter();
    h.restore(snap);
    expect((h as unknown as Priv).openLedger.entries[0]).toMatchObject({ text: WORDS });
    const thinned = { ...snap } as SessionCore & { openLedger?: unknown };
    delete thinned.openLedger;
    expect(sessionCoreIsSuperset(thinned as SessionCore, snap)).toBe(false);
    expect(sessionCoreIsSuperset(snap, thinned as SessionCore)).toBe(true);
  });

  it("appears in the narrator's brief on a later turn only while that houseguest is present", () => {
    const g = played();
    const id = withCompanion(g);
    g.recordOpenLedger(req(id));
    expect(briefText(g)).toContain(`"${WORDS}"`);
    expect(briefText(g)).toMatch(/open between you and/);
    // move to a room where that houseguest is not
    const away = ["living-room", "kitchen", "backyard", "bedroom", "bathroom"].find((r) => {
      const wa = g.movePlayer(r) ?? g.whereabouts();
      return wa && !wa.present.some((p) => p.id === id);
    });
    if (away) expect(briefText(g)).not.toContain(WORDS);
  });

  it("refuses a speaker who is not present, and refuses when off, pre-game or headless", () => {
    const g = played();
    const id = withCompanion(g);
    const absent = g.getGameState().house.map((h) => h.id as string).find((x) => x !== id && x !== g.getGameState().player?.id && !g.whereabouts()!.present.some((p) => p.id === x));
    if (absent) expect(g.recordOpenLedger(req(absent)).reason).toBe("not-present");
    const off = played(4); off.setOpenLedgerEnabled(false);
    expect(off.recordOpenLedger(req("npc:1")).reason).toBe("off");
    expect(new GameSessionAdapter().recordOpenLedger(req("npc:1")).reason).toBe("no-game");
    const headless = new GameSessionAdapter();
    headless.createCharacter({ playerName: "The Player", seed: 3 });
    expect(headless.recordOpenLedger(req("npc:1")).reason).toBe("no-game");
    expect(JSON.stringify(headless.snapshot())).not.toContain("openLedger");
  });

  it("changes no game state and draws no randomness (only the openLedger key differs)", () => {
    const a = played(21);
    const b = played(21);
    const ia = withCompanion(a);
    const ib = withCompanion(b);
    expect(ib).toBe(ia);
    const seq = b.getGameState().beatSeq;
    b.recordOpenLedger(req(ib));
    expect(b.getGameState().beatSeq).toBe(seq);
    const strip = (g: GameSessionAdapter): string => { const s = JSON.parse(JSON.stringify(g.snapshot())) as Record<string, unknown>; delete s.openLedger; return JSON.stringify(s); };
    expect(strip(b)).toBe(strip(a));
    expect(JSON.stringify(b.advanceGame())).toBe(JSON.stringify(a.advanceGame()));
  });
});
