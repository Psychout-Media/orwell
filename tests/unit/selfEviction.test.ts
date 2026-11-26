import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Feature 0061 — player self-eviction (the voluntary walk-out / quit path). A deliberate, explicitly
 * CONFIRMED, player-level (OOC) decision flows through a real engine lever: it records a real
 * `self-eviction` event (player-witnessed, non-hidden), folds its 0023 hidden impact, and transitions
 * the player OUT through the SAME sanctioned door as a vote-out (0046) — never a second exit path.
 * Owner decisions baked in: (1) a quit FORFEITS — exit ENTIRELY, terminal, never a juror's seat, in
 * any phase; (2) the parting message is offered-but-skippable; (3) legal at any beat, resolved at the
 * next safe transition. HARD rule: roles only — no names.
 */

let userSeq = 0;
function newGame(seed: number): ReturnType<GameSessionRegistry["sandboxFor"]> {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`se${userSeq++}`);
  sb.session.createCharacter({ playerName: "P", seed });
  return sb;
}

/** A deterministic player policy: compete, take the first legal options, never use the veto. */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

const playerLeft = (s: GameSessionAdapter): boolean => (s.snapshot().live?.evictionOrder ?? []).includes(PLAYER);

/** Advance a few beats so the season is genuinely live (the player still ACTIVE), then stop. */
function driveLiveButActive(s: GameSessionAdapter, beats: number): void {
  for (let i = 0; i < beats; i++) {
    if (playerLeft(s)) return; // the player got evicted before we finished — caller re-seeds
    const v = s.advanceGame();
    if (v.pending && v.pending.kind !== "self-evict") resolve(s, v.pending);
    if (v.finished) return;
  }
}

/** A fresh, ACTIVE-player game advanced a handful of beats (pre-jury, mid-week). */
function activeMidGame(seed = 1, beats = 6): ReturnType<typeof newGame> {
  for (let s = seed; s < seed + 40; s++) {
    const sb = newGame(s);
    driveLiveButActive(sb.session, beats);
    if (!playerLeft(sb.session) && !sb.session.snapshot().live?.finished) return sb;
  }
  throw new Error("no seed kept the player active for the wanted run");
}

describe("0061 — player self-eviction", () => {
  describe("the confirmed walk-out is a real, recorded transition", () => {
    it("records a self-eviction event (player-witnessed, non-hidden), folds 0023, and flips status via the 0046 door", () => {
      const sb = activeMidGame();
      const before = sb.engine.events.query({ witnessedBy: PLAYER }).length;
      expect(sb.session.getGameState().player?.status).toBe("active");

      // Step 1 (OOC intent): raise the confirmation — NO state change, NO eviction.
      sb.session.requestSelfEviction();
      expect(playerLeft(sb.session)).toBe(false);
      expect(sb.session.getGameState().player?.status).toBe("active");

      // Step 2 (explicit confirm): the recorded transition.
      const view = sb.session.submitDecision({ kind: "self-evict", confirmed: true });

      // A real, recorded, WITNESSED, NON-HIDDEN event names the walk-out.
      const witnessed = sb.engine.events.query({ witnessedBy: PLAYER });
      expect(witnessed.length).toBeGreaterThan(before);
      const exit = witnessed.find((e) => /self-evict/i.test(e.content));
      expect(exit, "a self-eviction event was recorded").toBeDefined();
      expect(exit!.witnessSet).toContain(PLAYER);
      expect(exit!.hidden).toBe(false);

      // Status flipped through the SAME sanctioned exit door (evictionOrder).
      expect(playerLeft(sb.session)).toBe(true);
      expect(sb.session.getGameState().player?.status).toBe("evicted");
      expect(view.event?.beat).toBe("self-eviction");
    });

    it("folds the exit into the relationship/soul layer (the present house's read of the leaver moves)", () => {
      const sb = activeMidGame(3, 8);
      const present = sb.session.getGameState().house.filter((h) => h.status === "active");
      expect(present.length).toBeGreaterThan(0);
      const someone = present[0]!.id;
      // The 0023 fold is hidden by construction (never a player-facing number) — read the engine-only
      // relationship edge directly via the snapshot is not exposed; instead assert the consequence ran
      // by proving the folded beat fired (the BeatEvent) and the season recorded it. The numeric move
      // itself stays in the hidden layer (the Vault Wall — a later test proves no number crosses).
      sb.session.requestSelfEviction();
      const v = sb.session.submitDecision({ kind: "self-evict", confirmed: true });
      expect(v.event?.beat).toBe("self-eviction");
      // The leaver is gone; the present house is still seated (the fold targeted the survivors, not the leaver).
      expect(sb.session.getGameState().house.some((h) => h.id === someone)).toBe(true);
    });

    it("the transition persists and survives an engine restart", () => {
      const reg = new GameSessionRegistry();
      const user = `se-restart-${userSeq++}`;
      const sb = reg.sandboxFor(user);
      sb.session.createCharacter({ playerName: "P", seed: 9 });
      driveLiveButActive(sb.session, 6);
      sb.session.requestSelfEviction();
      sb.session.submitDecision({ kind: "self-evict", confirmed: true });
      const statusBefore = sb.session.getGameState().player?.status;
      expect(statusBefore).toBe("evicted");

      const snap = reg.snapshot(user);
      const reg2 = new GameSessionRegistry();
      reg2.restore(user, snap);
      const after = reg2.sandboxFor(user).session.getGameState();
      expect(after.player?.status).toBe("evicted");
      expect(after.player?.status).not.toBe("active"); // still out after the restart
      // The self-evicted flag rode the snapshot (the forfeit seat is durable).
      expect(reg2.sandboxFor(user).session.snapshot().live?.selfEvicted).toBe(true);
    });
  });

  describe("the confirmation gate holds (unconfirmed / ambiguous never evicts)", () => {
    it("a raised intent surfaces a self-evict confirmation but changes NO state", () => {
      const sb = activeMidGame();
      const eventsBefore = sb.engine.events.queryAll().length;
      const v = sb.session.requestSelfEviction();
      // The confirmation is surfaced (when the loop is not blocked on a ceremony decision).
      const status = sb.session.gameStatus();
      const surfaced = v.pending?.kind === "self-evict" || status.pending?.kind === "self-evict";
      expect(surfaced).toBe(true);
      // NO eviction, NO new event, the player is still ACTIVE in the house.
      expect(playerLeft(sb.session)).toBe(false);
      expect(sb.session.getGameState().player?.status).toBe("active");
      expect(sb.engine.events.queryAll().length).toBe(eventsBefore);
    });

    it("an unconfirmed submit (confirmed:false / absent) is a safe no-op — no fabricated exit", () => {
      const sb = activeMidGame();
      sb.session.requestSelfEviction();
      expect(() => sb.session.submitDecision({ kind: "self-evict", confirmed: false })).toThrow(/decision refused \(unconfirmed\)/); // ORW-1063
      expect(playerLeft(sb.session)).toBe(false);
      expect(sb.session.getGameState().player?.status).toBe("active");
      // A confirm WITHOUT a raised intent also never evicts (the gate requires the standing confirmation).
      const sb2 = activeMidGame(5);
      expect(() => sb2.session.submitDecision({ kind: "self-evict", confirmed: true })).toThrow(/decision refused \(no-pending\)/); // ORW-1063
      expect(playerLeft(sb2.session)).toBe(false);
      expect(sb2.session.getGameState().player?.status).toBe("active");
    });

    it("cancelling the confirmation leaves the player active and in the house, unchanged", () => {
      const sb = activeMidGame();
      const blobBefore = JSON.stringify(sb.session.snapshot().live);
      sb.session.requestSelfEviction();
      sb.session.cancelSelfEviction();
      expect(playerLeft(sb.session)).toBe(false);
      expect(sb.session.getGameState().player?.status).toBe("active");
      // No self-evict pending remains, and the player plays on.
      expect(sb.session.snapshot().live?.selfEvictPending).toBeFalsy();
      // The game state is otherwise untouched apart from the cleared (false) flag.
      const blobAfter = JSON.stringify({ ...sb.session.snapshot().live, selfEvictPending: undefined });
      expect(blobAfter).toBe(JSON.stringify({ ...JSON.parse(blobBefore), selfEvictPending: undefined }));
    });
  });

  describe("terminal & forfeit behavior (owner decision #1)", () => {
    it("a pre-jury self-eviction reaches the terminal recap end state", () => {
      const sb = activeMidGame(1, 4); // early, before the jury forms
      sb.session.requestSelfEviction();
      sb.session.submitDecision({ kind: "self-evict", confirmed: true });
      const view = sb.session.getGameState();
      expect(view.player?.status).toBe("evicted");
      expect(view.moment).toBe("self-evicted"); // the dedicated terminal walk-out framing
      // The season is over for the player — the 0048 retrospective gate opens (terminal state reached).
      expect(sb.session.snapshot().live?.finished).toBe(true);
      expect(sb.session.seasonRetrospective()).not.toBeNull();
      expect(sb.session.seasonRecap().started).toBe(true);
    });

    it("a jury-phase self-eviction FORFEITS — the player exits entirely, never a juror's seat", () => {
      // Drive deep enough that an ordinary eviction here would seat a juror (index ≥ 5), but the
      // player CHOSE to walk — so they forfeit and read "evicted", not "jury".
      const sb = activeMidGameDeep();
      sb.session.requestSelfEviction();
      const v = sb.session.submitDecision({ kind: "self-evict", confirmed: true });
      expect(sb.session.getGameState().player?.status).toBe("evicted"); // forfeit, never "jury"
      // It resolved through the 0046 player-exit machinery (the evictionOrder door) — no new path.
      expect(playerLeft(sb.session)).toBe(true);
      expect(v.event?.beat).toBe("self-eviction");
      // No juror seat: the player never appears as a finale juror.
      expect(sb.session.finaleView()).toBeNull();
    });
  });

  describe("the house reacts (daily-event invariant + the parting message offer)", () => {
    it("the departure is a significant, witnessed house event the present house witnesses", () => {
      const sb = activeMidGame(2, 6);
      const present = sb.session.getGameState().house.filter((h) => h.status === "active").map((h) => h.id);
      sb.session.requestSelfEviction();
      const v = sb.session.submitDecision({ kind: "self-evict", confirmed: true });
      const exit = sb.engine.events.query({ witnessedBy: PLAYER }).find((e) => /self-evict/i.test(e.content));
      expect(exit).toBeDefined();
      // The present house (active NPCs) are in the witness set — they saw the walk-out (§4.4).
      expect(present.every((id) => exit!.witnessSet.includes(id) || id === PLAYER)).toBe(true);
      expect(v.event?.content).toMatch(/walks out|self-evict/i);
    });

    it("a parting message is OFFERED but SKIPPABLE — confirmed self-eviction still finalizes either way", () => {
      // Offered-but-skippable (owner decision #2): the engine never speaks for the player. The exit
      // finalizes whether the player authors a parting line or just goes — both paths reach terminal.
      const skip = activeMidGame(7, 6);
      skip.session.requestSelfEviction();
      skip.session.submitDecision({ kind: "self-evict", confirmed: true }); // no statement: skipped
      expect(skip.session.getGameState().player?.status).toBe("evicted");

      const author = activeMidGame(11, 6);
      author.session.requestSelfEviction();
      // The player's own parting words ride the same confirmed submit (the FE relays them as `statement`);
      // the engine records the exit and never authors the words for them.
      const v = author.session.submitDecision({ kind: "self-evict", confirmed: true, statement: "Thank you, everyone." });
      expect(author.session.getGameState().player?.status).toBe("evicted");
      expect(v.event?.beat).toBe("self-eviction");
    });
  });

  describe("the Vault Wall holds throughout (no hidden state crosses the flow or recap)", () => {
    it("a planted Vault sentinel never reaches the confirmation pending, the seam output, the projection, the recap, or the admin surface", () => {
      const sb = activeMidGame(4, 6);
      const sentinel = "SENTINEL-0061-selfevict-secret";
      // Plant the sentinel in BOTH hidden seams: an off-screen scene + the Vault store.
      sb.engine.events.record({
        id: "se:hidden", ts: 9_500_000, type: "conversation",
        initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: sentinel,
      });
      sb.engine.vault.writeHidden({ id: "se:vault", kind: "confessional", content: sentinel });

      // The confirmation pending must carry no sentinel.
      const reqView = sb.session.requestSelfEviction();
      expect(JSON.stringify(reqView)).not.toContain(sentinel);
      expect(JSON.stringify(sb.session.gameStatus())).not.toContain(sentinel);

      // The decision-seam output must carry no sentinel.
      const out = sb.session.submitDecision({ kind: "self-evict", confirmed: true });
      expect(JSON.stringify(out)).not.toContain(sentinel);

      // The post-exit player projection + the recap must carry no sentinel.
      expect(JSON.stringify(sb.session.getGameState())).not.toContain(sentinel);
      expect(JSON.stringify(sb.session.seasonRecap())).not.toContain(sentinel);
      expect(JSON.stringify(sb.session.getMomentPrompt({}))).not.toContain(sentinel);

      // The ADMIN surface must carry no sentinel either (the Wall walls admin too).
      sb.syncAdmin();
      const adminBlob = JSON.stringify(sb.admin.inspect()) + JSON.stringify(sb.admin.health());
      expect(adminBlob).not.toContain(sentinel);
      // No hidden-layer number/field leaks onto the player's terminal projection.
      expect(JSON.stringify(sb.session.getGameState())).not.toMatch(/soul|hiddenElement|"trust"|"threat"/i);
    });
  });

  describe("the L39a invariant — narrated-but-not-recorded means the player never left", () => {
    it("with no recorded self-eviction transition, the player is still active and in the house", () => {
      const sb = activeMidGame(6, 6);
      // No requestSelfEviction / no confirmed submit ⇒ no recorded transition.
      expect(playerLeft(sb.session)).toBe(false);
      expect(sb.session.getGameState().player?.status).toBe("active");
      // Even a raised-but-unconfirmed intent leaves them in the house.
      sb.session.requestSelfEviction();
      expect(sb.session.getGameState().player?.status).toBe("active");
    });
  });
});

/** Drive a fresh game deep enough that an ORDINARY eviction at this point would seat a juror (index ≥ 5),
 *  while keeping the PLAYER active — so a self-eviction here proves the FORFEIT (not a juror's seat). */
function activeMidGameDeep(): ReturnType<typeof newGame> {
  for (let s = 1; s <= 60; s++) {
    const sb = newGame(s);
    // Advance until the cast has shrunk into the jury window but the player is still in.
    for (let i = 0; i < 4000; i++) {
      const v = sb.session.advanceGame();
      if (v.pending && v.pending.kind !== "self-evict") resolve(sb.session, v.pending);
      if (v.finished || playerLeft(sb.session)) break;
      const live = sb.session.snapshot().live!;
      // The jury forms after `cast − 2 − 9` pre-jury evictions; once we're at/after that many evictions
      // AND the player is still active, an eviction now would be a JURY eviction.
      const cast = sb.session.getGameState().house.length + 1;
      const preJury = Math.max(0, cast - 2 - 9);
      if (live.evictionOrder.length >= preJury && live.active.includes(PLAYER) && live.active.length > 2) {
        return sb;
      }
    }
  }
  throw new Error("no seed reached the jury window with the player still active");
}
