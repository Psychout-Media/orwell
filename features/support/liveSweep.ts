import type { BbWorld } from "./world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { ALL_PLAYER_SURFACES } from "../../tests/support/sandbox";
import { assertNoSentinels, assertNoneAppear } from "../../tests/support/assertions";
import { npc } from "../../src/domain/ids";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { AdminPort } from "../../src/surfaces/admin/AdminPort";
import { InMemoryGameStateRepository } from "../../src/adapters/inmemory/InMemoryGameStateRepository";

/**
 * PAT-2 (#1979): Vault-leak sweeps that can FAIL.
 *
 * The canary `buildSandbox` fixture plants sentinels in ITS OWN engine; several scenarios then drove a
 * DIFFERENT, freshly built adapter and swept that adapter's output against the fixture's sentinels, so
 * the sweep could never fail. This helper plants sentinels into the SAME live game the scenario drives
 * (a registry-built per-user sandbox: engine core + live session + outward surfaces + MCP servers), so a
 * sweep of that game's output is non-vacuous. The whole-season proof stays in
 * `tests/property/liveSentinel.property.test.ts`; this is the BDD-sized slice of it.
 *
 * The sentinels are planted in the hidden layer only (NPC hidden elements, soul memory, a hidden event,
 * the soul store, a Vault confessional). NPC private KNOWLEDGE is intentionally not planted here: the
 * moment prompt carries a sanctioned, per-NPC-scoped knowledge block (ADR 0019), which the property test
 * excises before scanning.
 */

/** Anything a sweep can be run against: sentinel markers + the raw hidden strings that carry them. */
export interface SweepTargets {
  sentinels: string[];
  hiddenContents: string[];
}

export interface LiveSweep extends SweepTargets {
  reg: GameSessionRegistry;
  user: string;
  sb: UserSandbox;
}

/** Plant a unique sentinel into a houseguest's hidden material (hidden element + soul memory). */
export function plantInHouseguest(
  hg: { character: { hiddenElements: Array<{ kind: string; detail: string }> }; soul: { memory: string[] } },
  tag: string,
  into: SweepTargets,
): void {
  const mk = (kind: string): string => {
    const s = `SENTINEL-PAT2-${tag}-${kind}-${into.sentinels.length + 1}`;
    into.sentinels.push(s);
    return s;
  };
  const detail = `hidden ${mk("hidden")}`;
  const memory = `soul ${mk("soul")}`;
  hg.character.hiddenElements.push({ kind: "secret-motive", detail });
  hg.soul.memory.push(memory);
  into.hiddenContents.push(detail, memory);
}

/**
 * Stand up a live game and plant sentinels into every kind of hidden state it holds. `ticks` > 0 first
 * advances the off-screen clock so the house has genuinely confessed (the engine records the
 * confessionals), THEN plants — so the swept game is the one the scenario really ran.
 */
export function startLiveSweep(opts: { seed?: number; user?: string; ticks?: number } = {}): LiveSweep {
  const seed = opts.seed ?? 1;
  const user = opts.user ?? `pat2-${seed}`;
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "Player One", seed });
  if (opts.ticks) {
    const orch = new Orchestrator(reg, new FakeClock(), { seed });
    for (let i = 0; i < opts.ticks; i++) orch.advance(user, "offscreen-tick");
  }
  const out: LiveSweep = { reg, user, sb, sentinels: [], hiddenContents: [] };

  // (1) The generated house's hidden fields, via snapshot -> restore (also rebuilds the soul index).
  const core = sb.session.snapshot();
  for (const hg of core.house!.npcs) plantInHouseguest(hg, `s${seed}`, out);
  sb.session.restore(core);

  // (2) The engine's own hidden layer: a hidden event, the soul store, a Vault confessional.
  const mk = (tag: string): string => {
    const s = `SENTINEL-PAT2-s${seed}-${tag}-${out.sentinels.length + 1}`;
    out.sentinels.push(s);
    return s;
  };
  const ev = `off-screen ${mk("event")}`;
  sb.engine.events.record({
    id: `pat2:hidden:${seed}`, ts: 9_000_000, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: ev,
  });
  const soul = `soulstore ${mk("soulstore")}`;
  sb.engine.soul.recordToSoul(npc(1), soul);
  const vault = `vault ${mk("vault")}`;
  sb.engine.vault.writeHidden({ id: `pat2:vault:${seed}`, kind: "confessional", content: vault });
  out.hiddenContents.push(ev, soul, vault);

  // The sweep only bites if the sentinels are GENUINELY in the live hidden state. Prove it.
  const engineSide = JSON.stringify(sb.session.snapshot())
    + JSON.stringify(sb.engine.events.queryAll())
    + JSON.stringify(sb.engine.soul.soulOf(npc(1)))
    + JSON.stringify(sb.engine.vault.readHidden());
  for (const s of out.sentinels) {
    if (!engineSide.includes(s)) throw new Error(`PAT-2 sweep precondition: ${s} was not planted in the live game`);
  }
  return out;
}

// ---- The scenario's world <-> live sweep link (kept off world.ts: a side-channel accessor) ---------

type WithLive = { liveSweep?: SweepTargets & Partial<LiveSweep> };
export const liveOf = (w: BbWorld): (SweepTargets & Partial<LiveSweep>) | undefined => (w as unknown as WithLive).liveSweep;
export const setLive = (w: BbWorld, s: SweepTargets & Partial<LiveSweep>): void => { (w as unknown as WithLive).liveSweep = s; };

/** Sentinels to sweep for: the canary fixture's, PLUS the live game's own when the scenario drove one. */
export const sentinelsFor = (w: BbWorld): string[] => [...(w.sandbox?.sentinels ?? []), ...(liveOf(w)?.sentinels ?? [])];
export const hiddenFor = (w: BbWorld): string[] => [...(w.sandbox?.hiddenContents ?? []), ...(liveOf(w)?.hiddenContents ?? [])];

/** The sweep: the output must carry no sentinel (the thing every Vault-leak scenario asserts). */
export function assertLiveSweepClean(output: string, targets: SweepTargets): void {
  assertNoSentinels(output, targets.sentinels);
  assertNoneAppear(output, targets.hiddenContents);
}

// ---- Surfaces of the live game ---------------------------------------------------------------------

/** Every player-facing surface of THE LIVE GAME (the session's projections + the outward surfaces). */
export function livePlayerSurfaces(sb: UserSandbox): string {
  const ids = (sb.session.snapshot().house?.npcs ?? []).map((n) => n.id);
  return [
    ...ALL_PLAYER_SURFACES.map((s) => sb.player.produce(s)),
    JSON.stringify(sb.player.assembleNarrationContext("scene")),
    JSON.stringify(sb.player.assembleNarrationContext("dialogue")),
    sb.player.renderScene("compressed"),
    sb.player.renderScene("full"),
    sb.player.socialRead(),
    sb.player.socialRead(npc(1)),
    JSON.stringify(sb.player.getVisibleState()),
    JSON.stringify(sb.session.getGameState()),
    JSON.stringify(sb.session.gameStatus()),
    JSON.stringify(sb.session.whereabouts()),
    JSON.stringify(sb.session.getMomentPrompt({})),
    ...ids.map((id) => JSON.stringify(sb.session.npcVoice(id))),
  ].join("\n---\n");
}

/**
 * The STRUCTURED player projections of THE LIVE GAME (objects, not text), for a recursive numeric-field walk:
 * the HUD (`gameStatus` / `getGameState`), each houseguest's `npcVoice`, `whereabouts`, the journal-visible
 * state (`getVisibleState`), and the moment prompt object (whose `systemPrompt` is a string, so only a
 * numeric sibling field could trip the walk).
 */
export function livePlayerProjections(sb: UserSandbox): Record<string, unknown> {
  const ids = (sb.session.snapshot().house?.npcs ?? []).map((n) => n.id);
  const out: Record<string, unknown> = {
    gameStatus: sb.session.gameStatus(),
    getGameState: sb.session.getGameState(),
    whereabouts: sb.session.whereabouts(),
    journal: sb.player.getVisibleState(),
    momentPrompt: sb.session.getMomentPrompt({}),
  };
  for (const id of ids) out[`npcVoice:${id}`] = sb.session.npcVoice(id);
  return out;
}

/**
 * The ENGINE-GENERATED player-facing text of THE LIVE GAME, for the prose backstop. Same as
 * `livePlayerSurfaces` except the moment prompt's `systemPrompt` is left out: that is a ~tens-of-KB FIXED
 * instruction template (it talks about spectators "form[ing] opinions", power "changed hands", ...), not engine
 * output, so a prose regex over it only ever matches the template. Its engine-generated `hardConstraints`
 * block (scene occupancy / pronoun locks) IS kept.
 */
export function livePlayerProse(sb: UserSandbox): string {
  const ids = (sb.session.snapshot().house?.npcs ?? []).map((n) => n.id);
  const mp = sb.session.getMomentPrompt({});
  return [
    ...ALL_PLAYER_SURFACES.map((s) => sb.player.produce(s)),
    JSON.stringify(sb.player.assembleNarrationContext("scene")),
    JSON.stringify(sb.player.assembleNarrationContext("dialogue")),
    sb.player.renderScene("compressed"),
    sb.player.renderScene("full"),
    sb.player.socialRead(),
    sb.player.socialRead(npc(1)),
    JSON.stringify(sb.player.getVisibleState()),
    JSON.stringify(sb.session.getGameState()),
    JSON.stringify(sb.session.gameStatus()),
    JSON.stringify(sb.session.whereabouts()),
    mp.hardConstraints ?? "",
    ...ids.map((id) => JSON.stringify(sb.session.npcVoice(id))),
  ].join("\n---\n");
}

/** The admin / God-Mode surface of THE LIVE GAME (synced from the session first, as production does). */
export function liveAdminSurface(sb: UserSandbox): string {
  sb.syncAdmin();
  return JSON.stringify([sb.admin.inspect(), sb.admin.health()]);
}

/**
 * The admin / God-Mode surface for a BARE `GameSessionAdapter` (one a scenario built directly, with no registry
 * sandbox around it). It mirrors the registry's `syncAdmin` (the admin only ever holds the session's PUBLIC
 * week/phase and a roles-only roster) so the sweep reads the admin view of THE SAME game the scenario drove.
 */
export function adminSurfaceOfSession(session: GameSessionAdapter): string {
  const core = session.snapshot();
  const seat = (id: string): string => (core.live?.evictionOrder ?? []).includes(id) ? "evicted" : "active";
  const state = new InMemoryGameStateRepository({
    week: core.week,
    phase: core.phase,
    houseguests: core.house
      ? [{ role: "player", status: seat(core.house.player.id) }, ...core.house.npcs.map((n) => ({ role: "npc", status: seat(n.id) }))]
      : [],
  });
  return JSON.stringify(new AdminPort(state).inspect());
}
