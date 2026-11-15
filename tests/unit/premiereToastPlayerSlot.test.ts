import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-368 (Ryne's prod playtest, 2026-11-15: "The champagne circle was completely skipped? Only two people went. Every houseguest should introduce themselves." and "it seems to want me to go every time...
 * after a few people, it comes back to me as if I need to go again"). The engine releases the toast TWO speakers per advance and the narrator got the same line in EVERY batch: "the player's slot is theirs to take in
 * chat - invite it". So every batch turned the scene back to the player, and the circle stalled after the first batch. The engine already holds the done list (`spoke`, the player's slot in it); now the narrator is told,
 * from that list, where the player's slot stands: not yet (`later`), in this batch (`now`: invite ONCE), or passed (`done`: never again), and to voice every speaker named. Roles only.
 */
let n = 0;
function toast(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`pts${n++}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  for (let i = 0; i < 40 && sb.session.premiereIntros()?.entrance?.stage === "entrances"; i++) sb.session.advanceGame();
  return sb;
}
const INVITE = /take it in chat|invite it/i;

describe("the player's toast slot is invited once, in its own batch", () => {
  for (const seed of [31, 32, 33]) {
    it(`seed ${seed}: before the slot the narrator is told NOT to invite the player; in the slot's batch it invites once; after it, never again`, () => {
      const sb = toast(seed);
      const seen: Array<{ playerToast: string | undefined; invite: boolean; speakers: string[] }> = [];
      for (let i = 0; i < 30 && sb.session.premiereIntros()?.entrance?.stage === "toast"; i++) {
        sb.session.advanceGame();
        const e = sb.session.premiereIntros()?.entrance;
        if (!e || e.stage !== "toast") break;
        const prompt = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
        const toastLine = prompt.split("\n").find((l) => l.includes("THE TOAST (engine truth)")) ?? "";
        seen.push({ playerToast: e.playerToast, invite: INVITE.test(toastLine) && !/do not invite|never invite/i.test(toastLine), speakers: (e.speakers ?? []).map((x) => x.name) });
      }
      expect(seen.length, "the toast ran in several batches").toBeGreaterThan(3);
      const states = seen.map((x) => x.playerToast);
      expect(states.filter((s) => s === "now"), "the player's slot comes up in exactly ONE batch").toHaveLength(1);
      const at = states.indexOf("now");
      expect(states.slice(0, at).every((s) => s === "later"), "before it: later").toBe(true);
      expect(states.slice(at + 1).every((s) => s === "done"), "after it: done").toBe(true);
      expect(seen.filter((x) => x.invite).length, "the narrator is told to invite the player exactly once (in the slot's own batch)").toBe(1);
      expect(seen[at]!.invite, "and that batch is the one with the player's slot").toBe(true);
      expect(seen.some((x, i) => i !== at && x.invite), "no other batch invites the player").toBe(false);
    });
  }

  it("every houseguest except the player is released to speak exactly once, and the toast ends only when the done list is full", () => {
    const sb = toast(34);
    const released: string[] = [];
    let ended = false;
    for (let i = 0; i < 30; i++) {
      const v = sb.session.advanceGame();
      const sp = ((v.event?.detail as { speakers?: Array<string | { id: string; isPlayer?: boolean }> } | undefined)?.speakers) ?? [];
      for (const x of sp) released.push(typeof x === "string" ? x : x.isPlayer ? PLAYER : x.id);
      if (sb.session.premiereIntros()?.entrance?.stage === "done" || !sb.session.premiereIntros()?.entrance) { ended = true; break; }
    }
    expect(ended).toBe(true);
    const order = sb.session.snapshot().live!.premiereEntrance!.order.filter((x) => x !== PLAYER);
    expect(order.length).toBe(15);
    expect([...new Set(released.filter((x) => x !== "host" && x !== PLAYER))].sort(), "the released set IS the cast's entrance order (no missing or invented id)").toEqual([...order].sort());
    expect(released.filter((x) => x !== "host").length, "each exactly once, the player's slot included").toBe(new Set(released.filter((x) => x !== "host")).size);
  });

  it("before the first batch is released there is no \"after this batch\" count to report", () => {
    const e = toast(36).session.premiereIntros()!.entrance!;
    expect(e.stage).toBe("toast");
    expect(e.speakers).toBeUndefined();
    expect(e.toastRemaining).toBeUndefined();
  });

  it("the engine tells the narrator how many speakers are still to come, and it reaches 0 only at the end (the circle cannot be closed early by the narrator)", () => {
    const sb = toast(36);
    const remaining: number[] = [];
    for (let i = 0; i < 30 && sb.session.premiereIntros()?.entrance?.stage === "toast"; i++) {
      sb.session.advanceGame();
      const e = sb.session.premiereIntros()?.entrance;
      if (!e || e.stage !== "toast") break;
      remaining.push(e.toastRemaining!);
      const line = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt.split("\n").find((l) => l.includes("THE TOAST (engine truth)")) ?? "";
      if (e.toastRemaining! > 0) expect(line, "while speakers remain the narrator is told the toast is NOT over").toMatch(/THE TOAST IS NOT OVER: \d+ more speaker/);
      else expect(line, "the last batch says so").toMatch(/LAST batch/);
    }
    expect(remaining.length).toBeGreaterThan(3);
    expect(remaining.every((r, i) => i === 0 || r < remaining[i - 1]!), "the count falls with every batch").toBe(true);
    expect(remaining[remaining.length - 1]).toBe(0);
  });

  it("the narrator is told to voice EVERY houseguest speaker of THIS batch: each named, each non-player with a facts block; the player's slot is an invitation only", () => {
    const sb = toast(35);
    for (let k = 0; k < 4 && sb.session.premiereIntros()?.entrance?.stage === "toast"; k++) {
      sb.session.advanceGame();
      const e = sb.session.premiereIntros()?.entrance;
      if (!e || e.stage !== "toast") break;
      const prompt = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
      expect(prompt).toMatch(/Voice EVERY houseguest speaker named here/);
      const speakers = (e.speakers ?? []) as Array<{ id?: string; name: string; isPlayer?: boolean; host?: boolean }>;
      expect(speakers.length).toBeGreaterThan(0);
      for (const sp of speakers) {
        expect(prompt, `${sp.name} is named in the batch line`).toContain(sp.name);
        if (sp.isPlayer) expect(prompt).toMatch(/PLAYER'S slot: invite it, never voice it/);
        else if (!sp.host) expect(prompt, `${sp.name} has a facts block`).toContain(`THE TOAST \u2014 ${sp.name}'s facts`);
      }
    }
  });
});
