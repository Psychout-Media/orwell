import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { chooseHourAction, type HourView } from "../../src/engine/houseLife";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";

/** Feature 0173 helpers (roles only), shared by the unit tests and the BDD steps. Reaches the adapter's private state the way the territory tests do. */
export const A = "npc:1", B = "npc:2", C = "npc:3", D = "npc:4", E = "npc:5";
export type Priv = {
  live: { hoh?: string; resume?: Record<string, number>; status?: unknown; nominees?: string[]; evictionOrder: string[]; goalApproaches?: Record<string, { goalId: string; desire: string }>; agendas?: Record<string, { goals: unknown[] }>; nightDepth?: number; dayNumber?: number; week: number };
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number }; peek(a: string, b: string): { trust: number; affinity: number; threat: number } };
  alliances: { add(name: string, founder: string, members: string[], beat: number): { id: string }; history(): readonly { kind: string; who?: string }[]; all(): readonly { id: string; members: string[] }[] };
  livingIds(): string[];
  houseLifeStretch(events: unknown, awake: readonly string[], i: number): Array<{ initiator: string; partner: string; event: { houseLife?: { action: string } } }>;
  derivePitches(holder: string): Array<{ from: string; kind: string; protects?: string; strength: number }>;
  pitchTiltFor(subject: string, holder: string): number;
  recordLobbyPitches(hoh: string): void;
  campaigns: Array<{ id: string; owners: string[]; target: string; status: string; goal: string }>;
  campaignTick(): void;
  setCampaignsEnabled?(on: boolean): void;
  deriveCompIntent(id: string, field: readonly string[]): string;
  foldThirdPerson(p: unknown, listener: string, day: number, hour: number): void;
  statusTickNow(): void;
  statusRead(): { tiers: Record<string, number>; leader?: string; lieutenants: string[]; vacuumSince?: number; count: number; history: Array<{ kind: string; who: string }> } | undefined;
  houseGraphCache?: unknown;
  house: { npcs: Array<{ id: string }> };
};
export const priv = (s: GameSessionAdapter): Priv => s as unknown as Priv;
export type Boxed = { session: GameSessionAdapter; engine: { events: unknown }; mcp: { player: { callTool(n: string, a: unknown): Promise<unknown> }; admin: { callTool(n: string, a: unknown): Promise<unknown> } } };
let n = 0;
export function played(seed: number, flag = true, opts: { hours?: number } = {}): Boxed {
  const sb = new GameSessionRegistry().sandboxFor(`hoh0173-${n++}`) as unknown as Boxed;
  sb.session.setHohCourtEnabled(flag);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.noteMessage({ messageId: "m0" });
  if (opts.hours) runHours(sb, opts.hours);
  return sb;
}
export function runHours(sb: Boxed, hours: number): void {
  const s = priv(sb.session);
  const awake = s.livingIds().filter((i) => i !== "player");
  for (let h = 0; h < hours; h++) { s.live.nightDepth = (s.live.nightDepth ?? 8) + 1; s.houseLifeStretch(sb.engine.events, awake, h); }
}
/** Draw every pair's edge near `v` for the named pairs only (a controlled house). */
export function setEdge(s: GameSessionAdapter, a: string, b: string, e: { trust?: number; affinity?: number; threat?: number }): void { Object.assign(priv(s).rel.edge(a, b), e); }

const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
export const hourView = (over: Partial<HourView> = {}): HourView => ({
  owner: B, character: char, agenda: undefined, habits: [], emotional: 0.6, room: "living-room",
  whereabouts: new Map<string, Room>([[A, "hoh-room"], [B, "living-room"], [C, "living-room"]]),
  affinity: new Map([[A, 0.5], [C, 0.5]]), threat: new Map(), mates: [], nominees: [], hoh: A, timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
});
/** The share of seeded hours in which the holder goes to the HOH. */
export function courtShare(over: Partial<HourView>, trials = 1500): number {
  let go = 0;
  for (let i = 0; i < trials; i++) { const p = chooseHourAction({ ...hourView(over), day: 3 + Math.floor(i / 8), hour: 8 + (i % 8) }, 100 + i); if (p.with[0] === A && (p.kind === "check-in" || p.kind === "beg" || p.kind === "make-a-promise")) go++; }
  return go / trials;
}
