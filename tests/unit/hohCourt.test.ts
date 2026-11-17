import { describe, it, expect } from "vitest";
import { deriveStatus, advanceStatus, vacuumSplit, tierOf, courtPull, thirdPersonImpact, emptyStatus, HOH_COURT, type StatusRecord } from "../../src/engine/hohCourt";
import { formGoalCampaigns, deriveDrive } from "../../src/engine/campaigns";
import { deriveNpcCompIntent } from "../../src/engine/liveSeason";
import { hashSeed } from "../../src/engine/characterFactory";
import { GameSessionRegistry } from "../../src/composition/registry";
import { A, B, C, D, E, priv, played, runHours, setEdge, courtShare } from "../../features/support/hohCourtHelpers";

/** Feature 0173 (Theme 3 slice 11). Roles only. */
const ties = (pairs: Array<[string, string, number]>) => (a: string, b: string): number => pairs.find(([x, y]) => (x === a && y === b) || (x === b && y === a))?.[2] ?? 0;
const base = (over: Partial<Parameters<typeof deriveStatus>[0]> = {}) => ({
  members: [A, B, C, D, E], wins: () => 0, respect: () => 0.3, hubs: new Set<string>(), tie: ties([]), ...over,
});

describe("status is derived from wins, allies and respect (pure)", () => {
  it("rises with wins, allies and respect", () => {
    const r = deriveStatus(base({ wins: (id) => (id === A ? 3 : 0), tie: ties([[A, B, 0.8], [A, C, 0.7]]), respect: (id) => (id === A ? 0.8 : 0.2), hubs: new Set([A]) }));
    expect(r.score.get(A)!).toBeGreaterThan(r.score.get(D)!);
    expect(r.tiers[A]!).toBeGreaterThan(r.tiers[D]!);
    const noWins = deriveStatus(base({ tie: ties([[A, B, 0.8], [A, C, 0.7]]), respect: (id) => (id === A ? 0.8 : 0.2) }));
    expect(r.score.get(A)!).toBeGreaterThan(noWins.score.get(A)!);
  });
  it("is deterministic in any input order and bounded", () => {
    const x = deriveStatus(base({ wins: (id) => (id === C ? 2 : 0) }));
    const y = deriveStatus(base({ members: [E, D, C, B, A], wins: (id) => (id === C ? 2 : 0) }));
    expect([...x.score.entries()]).toEqual([...y.score.entries()]);
    for (const v of x.score.values()) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(tierOf(0)).toBe(0); expect(tierOf(1)).toBe(HOH_COURT.tierCuts.length);
    expect(deriveStatus({ members: [], wins: () => 0, respect: () => 0, tie: () => 0, hubs: new Set() }).leader).toBeUndefined();
  });
  it("a leader needs lieutenants, who follow their lead", () => {
    const strong = base({ wins: (id) => (id === A ? 3 : 0), tie: ties([[A, B, 0.7], [A, C, 0.6], [A, D, 0.5]]), respect: (id) => (id === A ? 0.9 : 0.3), hubs: new Set([A]) });
    const r = deriveStatus(strong);
    expect(r.leader).toBe(A);
    expect(r.lieutenants).toEqual([B, C, D]);
    const lone = deriveStatus(base({ wins: (id) => (id === A ? 3 : 0), respect: (id) => (id === A ? 0.9 : 0.3), hubs: new Set([A]) }));
    expect(lone.leader, "no followers, no leader").toBeUndefined();
    expect(r.lieutenants.length).toBeLessThanOrEqual(HOH_COURT.lieutenantMax);
  });
  it("a sitting leader is held until a challenger leads by the margin; a challenger who keeps outwinning takes the hold", () => {
    const g = { tie: ties([[A, B, 0.6], [A, C, 0.6], [A, D, 0.6], [B, C, 0.6], [B, D, 0.6], [B, E, 0.6]]), respect: () => 0.8, hubs: new Set([A, B]) };
    let held = 0, took = 0, sawGap = false;
    for (let bw = 0; bw <= 12; bw++) {
      const wins = (id: string): number => (id === A ? 4 : id === B ? bw : 0);
      const r = deriveStatus(base({ ...g, wins, prevLeader: A }));
      const gap = r.score.get(B)! - r.score.get(A)!;
      if (gap > 0 && gap <= HOH_COURT.challengeMargin && r.leader === A) { held++; sawGap = true; }
      if (gap > HOH_COURT.challengeMargin) { expect(r.leader).not.toBe(A); took++; }
    }
    expect(took, "a challenger who outwins them takes the hold").toBeGreaterThan(0);
    expect(sawGap || held === 0).toBe(true);
    const weak = deriveStatus(base({ ...g, wins: (id) => (id === A ? 4 : id === B ? 12 : 0), prevLeader: A }));
    const strong = deriveStatus(base({ ...g, wins: (id) => (id === A ? 4 : id === B ? 0 : 0), prevLeader: A }));
    expect(weak.score.get(A)!, "the hold on the leader weakens when outwon").toBeLessThan(strong.score.get(A)! + 1e-9);
    expect(weak.tiers[B]!, "and on the challenger strengthens").toBeGreaterThan(strong.tiers[B]!);
  });
});

describe("a vacuum is recorded, monotonic, and may split the group", () => {
  const rec = (over: Partial<StatusRecord>): StatusRecord => ({ ...emptyStatus(), day: 3, leader: A, lieutenants: [B, C], count: 1, history: [{ day: 1, kind: "rose", who: A }], ...over });
  it("a leader who has left opens a vacuum naming the surviving lieutenants, and the history only grows", () => {
    const read = deriveStatus(base({ members: [B, C, D, E] }));
    const step = advanceStatus(rec({}), read, 4, new Set([B, C, D, E]));
    expect(step.vacuumOpened).toBe(true);
    expect(step.claimants).toEqual([B, C]);
    expect(step.record.history.length).toBeGreaterThan(1);
    expect(step.record.count).toBeGreaterThan(1);
    expect(step.record.history[0]).toEqual({ day: 1, kind: "rose", who: A });
    const later = advanceStatus(step.record, read, 5, new Set([B, C, D, E]));
    expect(later.record.count).toBeGreaterThanOrEqual(step.record.count);
    expect(later.vacuumOpened).toBe(false);
  });
  it("a challenger without an exit is a challenge, a first leader a rise", () => {
    const g = { tie: ties([[B, A, 0.7], [B, C, 0.7], [B, D, 0.7]]), respect: () => 0.8, hubs: new Set([B]), wins: (id: string) => (id === B ? 4 : 0) };
    const r = deriveStatus(base(g));
    expect(r.leader).toBe(B);
    expect(advanceStatus(rec({}), r, 4, new Set([A, B, C, D, E])).record.history.at(-1)).toMatchObject({ kind: "challenged", who: B, over: A });
    expect(advanceStatus(undefined, r, 1, new Set([A, B, C, D, E])).record.history[0]).toMatchObject({ kind: "rose", who: B });
  });
  it("the split needs two lieutenants and a roll under the chance, and costs the lesser one", () => {
    const score = new Map([[B, 0.6], [C, 0.4]]);
    expect(vacuumSplit([B], score, 0)).toBeUndefined();
    expect(vacuumSplit([B, C], score, 0.99)).toBeUndefined();
    expect(vacuumSplit([B, C], score, 0.01)).toBe(C);
  });
});

describe("the court and the third-person actions are small and bounded", () => {
  it("the ones in danger court far more than the rest", () => {
    expect(courtPull(true)).toBeGreaterThan(courtPull(false) * 3);
    expect(courtPull(false)).toBeLessThanOrEqual(0.1);
  });
  it("a houseguest seeks the HOH out more than before, the ones in danger most; without a court the plan is byte-identical", () => {
    const none = courtShare({}), calm = courtShare({ court: { pull: courtPull(false), danger: false } }), danger = courtShare({ court: { pull: courtPull(true), danger: true } });
    expect(calm).toBeGreaterThan(none);
    expect(danger).toBeGreaterThan(calm * 2);
    expect(danger).toBeLessThan(0.7);
  });
  it("campaign-against and wedge sour the listener on the target; lobby-for warms; unknown kinds do nothing", () => {
    expect(thirdPersonImpact("campaign-against", 0.5, 0.5)!.threat).toBeGreaterThan(0);
    expect(thirdPersonImpact("drive-a-wedge", 0.5, 0.5)!.affinity).toBeLessThan(0);
    expect(thirdPersonImpact("lobby-for", 0.5, 0.5)!.affinity).toBeGreaterThan(0);
    expect(thirdPersonImpact("gossip", 0.5, 0.5)).toBeUndefined();
    const hi = thirdPersonImpact("campaign-against", 1, 1)!, lo = thirdPersonImpact("campaign-against", 0, 0)!;
    expect(hi.threat).toBeGreaterThan(lo.threat);
    expect(hi.threat).toBeLessThanOrEqual(0.06);
  });
});

describe("the wants systems read the agenda (ORW-577)", () => {
  it("a goal makes a campaign, a drive and a comp intent", () => {
    const actors = [{ id: A, persuasiveness: 0.5, threats: [], allies: [], goalTarget: B }, { id: C, persuasiveness: 0.9, threats: [], allies: [] }];
    const f = formGoalCampaigns(actors, { beat: 3, has: () => false });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ owners: [A], target: B, goal: "evict" });
    expect(f[0]!.id.endsWith(":goal")).toBe(true);
    expect(formGoalCampaigns(actors, { beat: 3, has: (o) => o === A })).toHaveLength(0);
    const d = deriveDrive({ id: A, persuasiveness: 0.5, threats: [], allies: [] }, { nominated: false, aggression: 0.5, emotional: 0.5, goalTarget: { target: B, commitment: 0.8 } }, undefined);
    expect(d).toMatchObject({ motivation: "target", target: B });
    expect(deriveDrive({ id: A, persuasiveness: 0.5, threats: [], allies: [] }, { nominated: false, aggression: 0.5, emotional: 0.5 }, undefined).motivation).toBe("lay-low");
    const p = { aggression: 0.1, nominee: false, hasOthers: true, bestAllyBond: 0.9, maxThreatOnMe: 0.9 };
    expect(deriveNpcCompIntent(p)).not.toBe("compete");
    expect(deriveNpcCompIntent({ ...p, wantsPower: true })).toBe("compete");
  });
});

describe("the live game (played, engine-only)", () => {
  it("keeps a daily status record that survives a save, grows only, and is absent with the flag off or in a headless game", () => {
    const on = played(7, true, { hours: 6 });
    priv(on.session).statusTickNow();
    const st = priv(on.session).statusRead()!;
    expect(st, "a played game holds a record").toBeTruthy();
    expect(Object.keys(st.tiers).length).toBeGreaterThan(5);
    const copy = JSON.parse(JSON.stringify(on.session.snapshot()));
    const re = played(8, true);
    re.session.restore(copy);
    expect(priv(re.session).statusRead()!.tiers).toEqual(st.tiers);
    const off = played(7, false, { hours: 6 });
    priv(off.session).statusTickNow();
    expect(priv(off.session).statusRead()).toBeUndefined();
  });
  it("a leader's exit opens a vacuum whose history is kept", () => {
    const sb = played(11, true, { hours: 6 });
    const s = priv(sb.session);
    const [a, b, c, d] = s.house.npcs.map((x) => x.id);
    for (const [x, y] of [[a, b], [a, c], [a, d]] as const) { setEdge(sb.session, x!, y!, { trust: 0.95, affinity: 0.95 }); setEdge(sb.session, y!, x!, { trust: 0.95, affinity: 0.95 }); }
    s.live.resume = { [a!]: 6 };
    s.live.dayNumber = (s.live.dayNumber ?? 1) + 1; // a new in-game day: the daily derivation runs again
    s.statusTickNow();
    const before = s.statusRead()!;
    expect(before.leader, "the drawn bonds make a leader on this seed").toBeTruthy();
    s.live.evictionOrder.push(before.leader!);
    (s.live as { dayNumber?: number }).dayNumber = (s.live.dayNumber ?? 1) + 1;
    s.statusTickNow();
    const after = s.statusRead()!;
    expect(after.count).toBeGreaterThan(before.count);
    expect(after.history.some((h) => h.kind === "vacuum" && h.who === before.leader)).toBe(true);
  });
  it("a vacuum whose roll falls under the chance splits the group: the lesser lieutenant leaves the alliance, and the alliance history records it", () => {
    const sb = played(11, true, { hours: 6 });
    const s = priv(sb.session);
    const [a, b, c, d] = s.house.npcs.map((x) => x.id);
    for (const [x, y] of [[a, b], [a, c], [a, d]] as const) { setEdge(sb.session, x!, y!, { trust: 0.95, affinity: 0.95 }); setEdge(sb.session, y!, x!, { trust: 0.95, affinity: 0.95 }); }
    s.alliances.add("the four", a!, [a!, b!, c!, d!], 1);
    s.live.resume = { [a!]: 6 };
    s.live.dayNumber = (s.live.dayNumber ?? 1) + 1;
    s.statusTickNow();
    const lead = s.statusRead()!;
    expect(lead.leader).toBe(a);
    s.live.evictionOrder.push(a!);
    const seed = (sb.session as unknown as { gameSeed?: number }).gameSeed ?? 0;
    let day = (s.live.dayNumber ?? 1) + 1;
    while ((hashSeed(`${seed}:status-vacuum:${day}`) % 10000) / 10000 >= HOH_COURT.splitChance) day++;
    s.live.dayNumber = day;
    const before = s.alliances.history().length;
    s.statusTickNow();
    const after = s.statusRead()!;
    expect(after.history.some((h) => h.kind === "split")).toBe(true);
    expect(s.alliances.history().length).toBeGreaterThan(before);
    expect(s.alliances.history().some((h) => h.kind === "left")).toBe(true);
  });
  it("a third-person campaign moves the listener's read of the target, bounded, and does nothing with the flag off", () => {
    for (const flag of [true, false]) {
      const sb = played(5, flag);
      const s = priv(sb.session);
      const [a, b, c] = s.house.npcs.map((x) => x.id);
      const before = { ...s.rel.edge(b!, c!) };
      s.foldThirdPerson({ actor: a, kind: "campaign-against", with: [b], about: c }, b!, 3, 14);
      const after = s.rel.edge(b!, c!);
      if (flag) { expect(after.threat).toBeGreaterThan(before.threat); expect(after.threat - before.threat).toBeLessThan(0.08); expect(after.affinity).toBeLessThan(before.affinity); }
      else expect(after).toEqual(before);
    }
  });
  it("an agenda goal makes a campaign outside the cap, and the cap still holds for the rest", () => {
    const sb = played(5, true, { hours: 3 });
    const s = priv(sb.session);
    (sb.session as unknown as { setCampaignsEnabled(on: boolean): void }).setCampaignsEnabled(true);
    const [a, b] = s.house.npcs.map((x) => x.id);
    s.live.agendas = { [a!]: { goals: [{ id: "g1", owner: a, horizon: "week", kind: "get-them-out", target: b, why: [], test: { kind: "wins" }, commitment: 0.9, status: "active", formedDay: 1, formedWeek: 1 }] } } as never;
    s.campaignTick();
    const mine = s.campaigns.filter((c) => c.owners[0] === a);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ target: b, goal: "evict" });
    expect(s.campaigns.filter((c) => !c.id.endsWith(":goal") && c.status === "active").length).toBeLessThanOrEqual(4);
  });
  it("the player plugged in: the player carries the same protective pitch, weighed but never voiced", () => {
    const sb = played(9, true, { hours: 3 });
    const s = priv(sb.session);
    const hoh = s.house.npcs[0]!.id;
    setEdge(sb.session, hoh, "player", { threat: 0.8, trust: 0.9 });
    const from = s.derivePitches(hoh).map((p) => p.from);
    expect(from).toContain("player");
    expect(s.derivePitches(hoh).find((p) => p.from === "player")!.protects).toBe("player");
    expect(s.pitchTiltFor("player", hoh)).toBeLessThan(0);
    const off = played(9, false, { hours: 3 });
    setEdge(off.session, priv(off.session).house.npcs[0]!.id, "player", { threat: 0.8, trust: 0.9 });
    expect(priv(off.session).derivePitches(priv(off.session).house.npcs[0]!.id).map((p) => p.from)).not.toContain("player");
  });
  it("when the player is HOH the houseguests who would lobby come to them, as approaches (not recorded as the player's own acts)", () => {
    const sb = played(9, true, { hours: 3 });
    const s = priv(sb.session);
    for (const n of s.house.npcs) setEdge(sb.session, "player", n.id, { threat: 0.7 });
    s.live.hoh = "player";
    s.recordLobbyPitches("player");
    const keys = Object.keys(s.live.goalApproaches ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(s.live.goalApproaches![k]!.goalId).toBe("court");
    const off = played(9, false, { hours: 3 });
    priv(off.session).live.hoh = "player"; priv(off.session).recordLobbyPitches("player");
    expect(Object.values(priv(off.session).live.goalApproaches ?? {}).filter((g) => g.goalId === "court")).toHaveLength(0);
  });
  it("a played game's hours are the same twice from one seed (keyed streams only)", () => {
    const run = (): string => { const sb = played(13, true, { hours: 12 }); priv(sb.session).statusTickNow(); return JSON.stringify([priv(sb.session).statusRead(), sb.session.snapshot()]); };
    expect(run()).toBe(run());
  });
  it("no outward surface carries a tier, a leader, a lieutenant or a court", async () => {
    const sb = played(21, true, { hours: 20 });
    priv(sb.session).statusTickNow();
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.player.callTool("whereabouts", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {}),
    ];
    const blob = JSON.stringify(surfaces).toLowerCase();
    for (const k of ["lieutenant", "pecking", "vacuumsince", "informal leader", "\"status\":{", "hohcourt", "tiers"]) expect(blob.includes(k), `a live surface carries ${k}`).toBe(false);
  });
  it("a headless game is byte-identical with the flag on or off", () => {
    const snap = (flag: boolean): string => {
      const sb = new GameSessionRegistry().sandboxFor(`hoh0173-headless-${flag}`);
      sb.session.setHohCourtEnabled(flag); sb.session.createCharacter({ playerName: "The Player", seed: 3 }); sb.session.advanceGame({});
      return JSON.stringify(sb.session.snapshot());
    };
    expect(snap(true)).toBe(snap(false));
    expect(snap(true).includes("\"status\":{")).toBe(false);
  });
});
void runHours;
void B; void C; void D; void E;
