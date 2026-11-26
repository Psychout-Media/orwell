import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, type EntityId } from "../../src/domain/ids";
import { houseMeetingLine, houseMeetingRefusedLine } from "../../src/engine/momentPrompts";
import { meetingClaimFor, MEETING_PACE, meetingWeekSpent } from "../../src/engine/houseMeeting";

/** ORW-593 (stale replay, dropped kinds, call pace) and ORW-596 (an NPC accuses the player, who answers in their own words). Roles only. */
type Live = { playedGame?: boolean; week: number; dayNumber?: number; houseMeetings?: Array<Record<string, unknown>>; houseMeetingShown?: { id: string; msg?: string }; beliefs?: Record<string, Array<Record<string, unknown>>> };
function boot(reg: GameSessionRegistry, seed = 7) {
  const s = reg.sandboxFor("u").session as GameSessionAdapter;
  s.setNpcBeliefsEnabled(true);
  s.createCharacter({ playerName: "The Player", seed });
  (s as unknown as { live: Live }).live.playedGame = true;
  return s;
}
const first = (n: string) => n.split(/\s+/)[0]!;
const live = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const meetingLine = (s: GameSessionAdapter) => s.getMomentPrompt({}).systemPrompt.split("\n").find((l) => l.includes("HOUSE MEETING (")) ;
const refusedLine = (s: GameSessionAdapter) => s.getMomentPrompt({}).systemPrompt.split("\n").find((l) => l.includes("HOUSE MEETING REFUSED"));
function cast(s: GameSessionAdapter) {
  const npcs = s.getGameState().house.filter((h) => h.id !== PLAYER);
  return { names: npcs.map((h) => first(h.name)), ids: npcs.map((h) => h.id as EntityId) };
}

describe("ORW-593 - a shown meeting is not replayed after a restart", () => {
  it("the shown mark is saved: after a reload the old meeting is not handed to the narrator again", () => {
    const d = mkdtempSync(join(tmpdir(), "orwell-hm-"));
    const reg = new GameSessionRegistry(new FileSaveStore(d));
    const s = boot(reg);
    const { names } = cast(s);
    s.noteMessage({ messageId: "m1" });
    s.resolvePlayerMove({ text: `I call a house meeting. ${names[0]} is going after ${names[1]}.` });
    expect(meetingLine(s)).toBeDefined();
    expect(live(s).houseMeetingShown?.msg).toBe("m1");
    reg.saveUser("u");
    const reloaded = new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as GameSessionAdapter;
    expect(live(reloaded).houseMeetingShown?.id).toBeDefined();
    reloaded.noteMessage({ messageId: "m2" });
    expect(meetingLine(reloaded), "a meeting from before the restart is not told again").toBeUndefined();
  });
});

describe("ORW-593 - the two listener-relative kinds are carried, not dropped", () => {
  it("maps them onto the kinds that name the object, with the caller as the object", () => {
    expect(meetingClaimFor({ kind: "voted-to-evict-you", subject: "a" as EntityId }, "c" as EntityId)).toEqual({ kind: "voted-against", subject: "a", object: "c" });
    expect(meetingClaimFor({ kind: "targets-you", subject: "a" as EntityId }, "c" as EntityId)).toEqual({ kind: "going-after", subject: "a", object: "c" });
    const other = { kind: "lying-about" as const, subject: "a" as EntityId };
    expect(meetingClaimFor(other, "c" as EntityId)).toBe(other);
  });

  it("'voted to evict me' and 'is targeting us', said by the player, each hold a meeting", () => {
    for (const phrase of ["voted to evict me", "is targeting us"]) {
      const s = boot(new GameSessionRegistry());
      const { names } = cast(s);
      s.resolvePlayerMove({ text: `I call a house meeting. ${names[0]} ${phrase}.` });
      const heard = s.houseMeetingThePlayerHeard();
      expect(heard, phrase).toBeDefined();
      expect(heard!.accused).toContain(names[0]);
      expect(heard!.claim.object, phrase).toContain("Player");
    }
  });
});

describe("ORW-593 - the player's calls are paced like the house's", () => {
  it("one meeting a week for the house: a second call is refused with a reason the narrator voices, and holds nothing", () => {
    expect(MEETING_PACE.perWeek).toBe(1);
    expect(meetingWeekSpent([{ week: 2 }], 2)).toBe(true);
    expect(meetingWeekSpent([{ week: 2 }], 3)).toBe(false);
    const s = boot(new GameSessionRegistry());
    const { names } = cast(s);
    s.resolvePlayerMove({ text: `I call a house meeting. ${names[0]} is going after ${names[1]}.` });
    expect(live(s).houseMeetings).toHaveLength(1);
    s.resolvePlayerMove({ text: `I call a house meeting. ${names[2]} is lying to ${names[3]}.` });
    expect(live(s).houseMeetings, "no second meeting in the same week").toHaveLength(1);
    const line = refusedLine(s)!;
    expect(line).toMatch(/already been called together this week/);
    expect(line).toMatch(/do not narrate one/);
    live(s).week += 1; // the week rolls: the house will gather again
    s.resolvePlayerMove({ text: `I call a house meeting. ${names[2]} is lying to ${names[3]}.` });
    expect(live(s).houseMeetings).toHaveLength(2);
    expect(refusedLine(s)).toBeUndefined();
  });

  it("every refusal reads as words and no raw token", () => {
    for (const r of ["ceremony", "asleep", "nobody", "spent"]) expect(houseMeetingRefusedLine(r)).not.toMatch(/undefined|spent|npc:|claim:/);
  });
});

describe("ORW-596 - an NPC accuses the player, who answers in their own words", () => {
  function accused(seed = 7) {
    const s = boot(new GameSessionRegistry(), seed);
    const { ids, names } = cast(s);
    const caller = ids[0]!;
    const m = s.holdHouseMeeting({ caller, accused: PLAYER, claim: { kind: "going-after", subject: PLAYER, object: caller } });
    return { s, ids, names, caller, m };
  }

  it("holds the accusation open: the engine draws no answer and tells the narrator the reply is the player's", () => {
    const { s, m } = accused();
    expect(m).toBeDefined();
    expect(m!.answer).toBeUndefined();
    expect(m!.awaitingPlayerAnswer).toBe(true);
    const line = meetingLine(s)!;
    expect(line).toMatch(/has NOT answered/);
    expect(line).toMatch(/never deny, admit, deflect or answer for them/);
    expect(line, "no truth marker, no id").not.toMatch(/isTrue|claim:|meeting:|npc:|confidence|trust/i);
    expect(meetingLine(s), "it is told again on the next turn while it stands").toBeDefined();
  });

  it("the player's answer settles it, is told once, and a garbled one changes nothing", () => {
    const { s, m } = accused();
    expect(() => s.submitDecision({ kind: "meeting-answer", vote: "maybe" } as never)).toThrow(/decision refused \(bad-answer\)/); // ORW-1063
    expect(m!.answer).toBeUndefined();
    s.submitDecision({ kind: "meeting-answer", vote: "deny", statement: "  That is   not true.\n" } as never);
    expect(m!.answer).toBe("deny");
    expect(m!.awaitingPlayerAnswer).toBeUndefined();
    expect((m as unknown as { playerWords: string }).playerWords).toBe("That is not true.");
    s.noteMessage({ messageId: "x1" });
    expect(meetingLine(s)).toMatch(/the accused DENIES it/);
    s.noteMessage({ messageId: "x2" });
    expect(meetingLine(s), "one turn").toBeUndefined();
    s.submitDecision({ kind: "meeting-answer", vote: "admit" } as never);
    expect(m!.answer, "answered once").toBe("deny");
  });

  it("an accusation the player never answers lapses when the week rolls and is not voiced again", () => {
    const { s, m } = accused();
    live(s).week += 1;
    expect(meetingLine(s)).toBeUndefined();
    s.submitDecision({ kind: "meeting-answer", vote: "deny" } as never);
    expect(m!.answer).toBeUndefined();
  });

  it("a houseguest holding a grievance against the player calls the house on the same rule as against an NPC", () => {
    const s = boot(new GameSessionRegistry());
    const { ids } = cast(s);
    const holder = ids[0]!;
    (live(s).beliefs ??= {})[holder] = [{ id: `${holder}|targets-me|${PLAYER}||1`, holder, kind: "targets-me", subject: PLAYER, object: holder, value: true, origin: "told", confidence: 0.9, week: 1 }];
    const call = (s as unknown as { npcCallsHouseMeeting(): void });
    let held = false;
    for (let day = 1; day <= 200 && !held; day++) {
      live(s).dayNumber = day;
      (live(s) as unknown as { meetingCallsDecided?: string[] }).meetingCallsDecided = []; // ORW-686: the once-per-day record is now persisted on the live season (was an in-memory set)
      call.npcCallsHouseMeeting();
      held = (live(s).houseMeetings ?? []).length > 0;
    }
    expect(held).toBe(true);
    const m = live(s).houseMeetings![0]!;
    expect(m.accused).toBe(PLAYER);
    expect(m.caller).toBe(holder);
    expect(m.awaitingPlayerAnswer).toBe(true);
  });

  it("is refused while the player is asleep, and the player cannot accuse themselves", () => {
    const { s, ids } = accused();
    const s2 = boot(new GameSessionRegistry());
    const c = cast(s2).ids;
    s2.resumeNapTicks();
    expect(s2.holdHouseMeeting({ caller: c[0]!, accused: PLAYER, claim: { kind: "going-after", subject: PLAYER, object: c[0]! } })).toBeUndefined();
    expect(s.holdHouseMeeting({ caller: PLAYER, accused: PLAYER, claim: { kind: "lying-about", subject: PLAYER } })).toBeUndefined();
    void ids;
  });

  it("PARITY: the same accusation and the same answer move the same stores whether the accused is a houseguest or the player (roles substituted)", () => {
    const answersSeen = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) {
      const A = boot(new GameSessionRegistry(), seed), B = boot(new GameSessionRegistry(), seed);
      const { ids } = cast(A);
      const caller = ids[0]!, npcAccused = ids[1]!, listeners = ids.slice(2);
      // Identical starting reads in both worlds: every listener feels the same about the caller, and the same about the accused (an NPC in A, the player in B).
      for (const w of [A, B]) {
        const rel = (w as unknown as { rel: { edge(a: EntityId, b: EntityId): { trust: number; affinity: number; threat: number } } }).rel;
        listeners.forEach((l, i) => { const t = 0.35 + 0.1 * (i % 5); for (const e of [rel.edge(l, caller), rel.edge(l, npcAccused), rel.edge(l, PLAYER)]) { e.trust = e === rel.edge(l, caller) ? 0.65 : t; e.affinity = 0.5; e.threat = 0.3; } });
      }
      const ma = A.holdHouseMeeting({ caller, accused: npcAccused, claim: { kind: "going-after", subject: npcAccused, object: caller } });
      const mb = B.holdHouseMeeting({ caller, accused: PLAYER, claim: { kind: "going-after", subject: PLAYER, object: caller } });
      if (!ma || !mb) { expect(ma === undefined, `seed ${seed}`).toBe(mb === undefined); continue; }
      answersSeen.add(ma.answer!);
      B.submitDecision({ kind: "meeting-answer", vote: ma.answer, statement: "in my own words" } as never);
      expect(mb.answer).toBe(ma.answer);
      const arel = (A as unknown as { rel: { edge(a: EntityId, b: EntityId): Record<string, number> } }).rel;
      const brel = (B as unknown as { rel: { edge(a: EntityId, b: EntityId): Record<string, number> } }).rel;
      for (const l of listeners) {
        const heldBy = (w: GameSessionAdapter, ids: string[]) => (live(w).beliefs![l] ?? []).find((b) => ids.some((id) => String(b.id).endsWith(`|${id}`)));
        const accA = heldBy(A, ma.claimIds), accB = heldBy(B, mb.claimIds);
        expect(!!accA, `seed ${seed} listener planted`).toBe(!!accB);
        if (accA && accB) { expect(accB.confidence, `seed ${seed} confidence`).toBeCloseTo(accA.confidence as number, 9); expect(!!accB.refuted, `seed ${seed} refuted`).toBe(!!accA.refuted); }
        for (const k of ["trust", "affinity", "threat"]) {
          expect(brel.edge(l, caller)[k], `seed ${seed} ${k} toward the caller`).toBeCloseTo(arel.edge(l, caller)[k]!, 9);
          expect(brel.edge(l, PLAYER)[k], `seed ${seed} ${k} toward the accused`).toBeCloseTo(arel.edge(l, npcAccused)[k]!, 9);
        }
      }
    }
    expect(answersSeen.size, "the parity run covered more than one answer").toBeGreaterThan(1);
  });

  it("WALL: the accusation line, the heard view and the answer result carry no truth marker or engine id", () => {
    const { s } = accused();
    const heard = s.houseMeetingThePlayerHeard()!;
    expect(Object.keys(heard).sort()).toEqual(["accused", "awaitingAnswer", "caller", "claim"]);
    expect(JSON.stringify(heard)).not.toMatch(/isTrue|intent|"id"|outcome|belief|trust|claimId|meeting:/i);
    const res = s.submitDecision({ kind: "meeting-answer", vote: "redirect", statement: "ask them" } as never);
    expect(JSON.stringify(res)).not.toMatch(/isTrue|claimId|meeting:|outcome|holds-harder|doubts|trust/i);
    const after = houseMeetingLine({ caller: "Ann", accused: "Bo", claim: { kind: "lying-about", subject: "Bo" }, awaitingAnswer: true });
    expect(after).not.toMatch(/undefined/);
  });
});
