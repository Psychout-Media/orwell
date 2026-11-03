import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Feature 0129 slice 1 — the jury-house roster projection. Present ONLY while the player is a juror; lists the OTHER
 * jurors with a categorical bearing toward the player; Vault-free; read-only (the seeded spine is unaffected).
 * Roles only — no names.
 */
let seq = 0;
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") submit({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else if (p.kind === "exit-interview") submit({ kind: "exit-interview", vote: p.stances![0]! });
  else if (p.kind === "spectator-choice") submit({ kind: "spectator-choice", vote: "watch" });
  else if (p.kind === "finale-interview") submit({ kind: "finale-interview", vote: "gracious" });
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}
function newGame(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`jh${seq++}`);
  sb.session.createCharacter({ playerName: "P", seed });
  return sb;
}
/** Play until the player holds a juror's seat (status "jury") and at least one OTHER juror exists; null if the seed misses. */
function playUntilJuror(seed: number) {
  const sb = newGame(seed);
  for (let i = 0; i < 8000; i++) {
    const v = sb.session.advanceGame();
    const st = sb.session.getGameState();
    if (st.player?.status === "jury" && st.juryHouse && st.juryHouse.jurors.length >= 1 && !v.pending) return sb;
    if (v.pending) resolve(sb.session, v.pending);
    if (v.finished) return null;
  }
  return null;
}
function findJuror() {
  for (let seed = 1; seed <= 80; seed++) { const sb = playUntilJuror(seed); if (sb) return sb; }
  throw new Error("no seed in 1..80 seated the player on the jury with another juror present");
}

describe("0129 — the jury house projection", () => {
  it("is ABSENT while the player is still playing", () => {
    const sb = newGame(1);
    sb.session.advanceGame();
    expect(sb.session.getGameState().player!.status).toBe("active");
    expect(sb.session.getGameState().juryHouse).toBeUndefined();
  });

  it("lists the OTHER jurors only — never the player, never anyone still in the house or out pre-jury", () => {
    const sb = findJuror();
    const st = sb.session.getGameState();
    const jh = st.juryHouse!;
    const live = sb.session.snapshot().live!;
    expect(jh.jurors.every((j) => j.id !== PLAYER)).toBe(true);
    const juryStart = Math.max(0, (st.house.length) - 2 - 9);   // cast − 2 − 9: evictions before it go home pre-jury
    const active = new Set(st.house.filter((h) => h.status === "active").map((h) => h.id));
    for (const j of jh.jurors) {
      expect(active.has(j.id)).toBe(false);
      expect(live.evictionOrder.indexOf(j.id)).toBeGreaterThanOrEqual(juryStart);        // a juror, not a pre-jury evictee
      expect(["warm", "even", "cool", "sour"]).toContain(j.bearing);
    }
  });

  it("carries only the whitelisted public keys — no number, no hidden field", () => {
    const sb = findJuror();
    for (const j of sb.session.getGameState().juryHouse!.jurors) {
      expect(Object.keys(j).sort()).toEqual(["bearing", "evictedWeek", "id", "name"]);
    }
    expect(Object.keys(sb.session.getGameState().juryHouse!)).toEqual(["jurors"]);
  });

  it("a planted Vault sentinel never reaches the projection", () => {
    const sb = findJuror();
    const sentinel = "SENTINEL-0129-juryhouse-secret";
    sb.engine.vault.writeHidden({ id: "jh:vault", kind: "confessional", content: sentinel });
    sb.engine.vault.writeHidden({ id: "jh:scene", kind: "offscreen", content: sentinel } as never);
    expect(JSON.stringify(sb.session.getGameState().juryHouse)).not.toContain(sentinel);
    expect(JSON.stringify(sb.session.getGameState())).not.toContain(sentinel);
  });

  it("bearing reads the RECORDED manner toward the player (sour for a blindside, warm for respected, even when unrecorded)", () => {
    const sb = findJuror();
    const core = sb.session.snapshot();
    const live = core.live!;
    const [first] = sb.session.getGameState().juryHouse!.jurors;
    live.mannerByEvictee = { ...(live.mannerByEvictee ?? {}), [first!.id]: { [PLAYER]: { blindsided: true } } };
    sb.session.restore(core);
    expect(sb.session.getGameState().juryHouse!.jurors.find((j) => j.id === first!.id)!.bearing).toBe("sour");
    live.mannerByEvictee![first!.id] = { [PLAYER]: { respected: true } };
    sb.session.restore(core);
    expect(sb.session.getGameState().juryHouse!.jurors.find((j) => j.id === first!.id)!.bearing).toBe("warm");
    delete live.mannerByEvictee![first!.id];
    sb.session.restore(core);
    expect(sb.session.getGameState().juryHouse!.jurors.find((j) => j.id === first!.id)!.bearing).toBe("even");
  });

  it("is read-only: reading the projection never changes the season (the seeded spine is byte-identical)", () => {
    const run = (readIt: boolean): string => {
      const sb = newGame(11);
      for (let i = 0; i < 8000; i++) {
        if (readIt) { sb.session.getGameState(); }
        const v = sb.session.advanceGame();
        if (v.pending) resolve(sb.session, v.pending);
        if (v.finished) break;
      }
      const l = sb.session.snapshot().live!;
      return JSON.stringify({ w: l.winner, f: l.finalTwo, j: l.jury, o: l.evictionOrder });
    };
    expect(run(true)).toBe(run(false));
  });

  it("a self-evicted player never gets a jury house (0061 forfeit)", () => {
    const sb = newGame(7);
    sb.session.advanceGame();
    sb.session.requestSelfEviction();
    sb.session.submitDecision({ kind: "self-evict", confirmed: true });
    for (let i = 0; i < 400; i++) { const v = sb.session.advanceGame(); if (v.pending) resolve(sb.session, v.pending); if (v.finished) break; expect(sb.session.getGameState().juryHouse).toBeUndefined(); }
    expect(npc(1)).toBeTruthy();
  });
});
