import { describe, it, expect } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import { PLAYER } from "../../src/domain/ids";
import { declaredStance, ASSURANCE } from "../../src/engine/assurances";
import { renderGameContext, momentFragment } from "../../src/engine/momentPrompts";
import type { GameStateView } from "../../src/ports/GameSession";

/**
 * ORW-737: a promise a houseguest makes aloud comes from an ENGINE decision (the declared stance), never from the narrator. Roles only. Pure shape, then a real seeded played game, then the prompt.
 */
describe("ORW-737 the declared stance is the engine's, pure", () => {
  const base = { standing: false, pull: 0.05, honesty: 1, keepRoll: 0.99, lieRoll: 0 };
  it("a standing assurance is declared again", () => expect(declaredStance({ ...base, standing: true })).toBe("will-keep"));
  it("a fully honest voter who would not keep declines to commit, whatever the lie roll", () => {
    for (const r of [0, 0.3, 0.99]) expect(declaredStance({ ...base, lieRoll: r })).toBe("wont-commit");
  });
  it("a dishonest voter who would not keep lies only under the bounded chance", () => {
    expect(declaredStance({ ...base, honesty: 0, lieRoll: ASSURANCE.stanceLieScale - 0.01 })).toBe("will-keep");
    expect(declaredStance({ ...base, honesty: 0, lieRoll: ASSURANCE.stanceLieScale + 0.01 })).toBe("wont-commit");
  });
  it("a voter whose own pull would keep the player declares it truthfully", () => expect(declaredStance({ ...base, pull: 0.95, keepRoll: 0.2 })).toBe("will-keep"));
});

type Sess = {
  live?: { week: number; hoh?: string; finalNominees?: string[]; nominees?: string[]; assurances?: { items: Array<{ from: string; to: string; kind: string; status: string }> }; active: string[] };
  declaredStanceFor(id: string): "will-keep" | "wont-commit" | undefined;
  keepPromisersOfPlayer(): Array<{ id: string }>;
};

describe("ORW-737 the declared stance in a played game", () => {
  it("is decided only where something is at stake, is stable, and the eviction list is exactly the ledger", async () => {
    let onBlockSeen = 0, willKeep = 0, wontCommit = 0, unstable = 0, strayVoter = 0, listWrong = 0, hohBeforeKeeps = 0;
    for (const seed of [3]) {
      await playMixGame(seed, 900, { advanceEvery: 6, stopAtWeek: 5, onStep: (x) => {
        const s = x as Sess;
        if (!s.live) return;
        const block = (s.live.finalNominees ?? s.live.nominees) ?? [];
        const onBlock = block.includes(PLAYER);
        const promisers = new Set((s.live.assurances?.items ?? []).filter((a) => a.to === PLAYER && a.status !== "lapsed" && (a.kind === "vote" || a.kind === "safe")).map((a) => a.from));
        const got = new Set(s.keepPromisersOfPlayer().map((p) => p.id));
        for (const id of got) if (!promisers.has(id)) listWrong++;
        for (const id of s.live.active) {
          if (id === PLAYER) continue;
          const d = s.declaredStanceFor(id);
          if (d !== s.declaredStanceFor(id)) unstable++;
          if (!d) continue;
          const standing = (s.live.assurances?.items ?? []).some((a) => a.from === id && a.to === PLAYER && (a.status === "open" || a.status === "kept"));
          if (onBlock && id !== s.live.hoh && !block.includes(id)) { onBlockSeen++; d === "will-keep" ? willKeep++ : wontCommit++; }
          else if (!standing && !(s.live.hoh === id && block.length === 0)) strayVoter++;
          if (s.live.hoh === id && block.length === 0 && !standing && d === "will-keep") hohBeforeKeeps++;
        }
      } });
    }
    expect(unstable).toBe(0);
    expect(strayVoter).toBe(0);
    expect(listWrong).toBe(0);
    expect(hohBeforeKeeps).toBe(0); // the HOH's nomination intent is hidden: only a recorded assurance lets them say it
    // when the player is on the block, voters are asked and not all of them promise
    if (onBlockSeen > 0) expect(wontCommit).toBeGreaterThan(0);
  }, 120000);
});

describe("ORW-737 the narrator is handed only the stance", () => {
  const mk = (extra: Record<string, unknown>): GameStateView => ({ started: true, player: { id: "p", name: "Role P", status: "active" }, house: [], week: 3, phase: "eviction", presentKnowledge: [{ id: "a", name: "Role A", knows: [], suspects: [], declaredStance: "wont-commit" }], ...extra } as unknown as GameStateView);
  it("renders the stance line and the rule, and the eviction list names only the ledger", () => {
    const out = renderGameContext(mk({ keepPromisers: [{ id: "b", name: "Role B" }] }));
    expect(out).toContain("declaredStance (what they tell the player about keeping them): wont-commit");
    expect(out).toContain("the ONLY commitment that houseguest may make about a future vote, nomination or veto");
    expect(out).toContain("WHO TOLD THE PLAYER THEY WOULD KEEP THEM");
    expect(out).toContain("Role B");
  });
  it("renders nothing of it when nothing is at stake", () => {
    const out = renderGameContext({ started: true, player: { id: "p", name: "Role P", status: "active" }, house: [], week: 3, phase: "eviction" } as unknown as GameStateView);
    expect(out).not.toContain("declaredStance");
    expect(out).not.toContain("WHO TOLD THE PLAYER");
  });
  it("the eviction fragment ties any 'promised the player their vote' to that line", () => {
    expect(momentFragment("eviction")).toContain("ONLY if the WHO TOLD THE PLAYER line names them");
  });
});
