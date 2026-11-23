/**
 * ORW-281 slice 3: the ONE pure answer to "is a whole-house EVENT in session?", derived from the live state alone (so the orchestrator can ask it of a snapshot, and the
 * adapter's `houseEventInSession` reuses it rather than keeping a second copy). A competition (staged), a surfaced-but-unstaged comp, nominations, the veto ceremony
 * (veto-decision / replacement / houseguests-choice) and eviction (vote / tie-break / final). The premiere and champagne toast are reported too (callers that only care about
 * comps+ceremonies filter them with `isCompOrCeremonyKind`). Pure read; never mutates.
 */
import type { LiveSeasonState } from "./liveSeason";
import type { EntityId } from "../domain/ids";
import { tourFree } from "./houseTour";
import type { Room } from "../domain/house";

export type LiveHouseEventKind =
  | "premiere-entrances" | "champagne-circle" | "hoh-competition" | "veto-competition"
  | "veto-draw" | "nominations" | "veto-ceremony" | "eviction";

export function liveHouseEvent(s: LiveSeasonState | undefined | null, opts: { includeDraw?: boolean } = {}): { kind: LiveHouseEventKind; field?: EntityId[] } | null {
  if (!s) return null;
  if (s.premiereEntrance?.stage === "entrances" && !tourFree(s)) return { kind: "premiere-entrances" };
  if (s.champagneCircle === "gathered") return { kind: "champagne-circle" };
  if (s.competition) return { kind: s.competition.comp as LiveHouseEventKind, field: [...s.competition.field] };
  if (s.ceremony) return { kind: s.ceremony.hold as LiveHouseEventKind }; // ORW-281 4a: the staged ceremony holds the house event for its WHOLE length (the gathering never dissolves between steps)
  const p = s.pending;
  if (!p) {
    // TODO(ORW-281 slice 1): the veto DRAW is still bundled into the veto comp's beat (no pending, no vetoField yet). Once the draw is its own beat/milestone, key on that
    // instead of beat "veto-competition" + vetoField unset. Opt-in (`includeDraw`) so the observational whereabouts read is unchanged.
    return opts.includeDraw && s.beat === "veto-competition" && !s.vetoField && !s.finished ? { kind: "veto-draw", field: [] } : null; // ORW-281 slice 1: the unstaged draw reports as the draw ceremony (its own kind)
  }
  if (p.kind === "comp-intent" || p.kind === "comp-round") {
    if (p.comp === "veto-competition") return { kind: "veto-competition", field: s.vetoField ? [...s.vetoField] : [] };
    const finalThree = s.active.length === 3;
    return { kind: "hoh-competition", field: s.active.filter((id) => finalThree || id !== s.outgoingHoh) };
  }
  if (p.kind === "nominations") return { kind: "nominations" };
  if (p.kind === "houseguests-choice") return { kind: "veto-draw" }; // ORW-281 slice 1: the Houseguest's Choice card is the DRAW (it used to say veto-ceremony)
  if (p.kind === "veto-decision" || p.kind === "replacement") return { kind: "veto-ceremony" };
  if (p.kind === "eviction-vote" || p.kind === "tie-break" || p.kind === "final-eviction") return { kind: "eviction" };
  return null;
}

/** A comp or ceremony (not the premiere / champagne toast, which have their own skips). */
export function isCompOrCeremonyKind(k: LiveHouseEventKind | undefined): boolean {
  return k !== undefined && k !== "premiere-entrances" && k !== "champagne-circle";
}

/**
 * ORW-740b (ADR 0009 amended 2026-11-20): the ONE answer to "which room is this whole-house event staged in?" (Ryne 2026-11-11, ORW-281 slice 6: ceremonies live in the living room, competitions
 * in the backyard). The ceremony gather (`gatherForCeremony`), the restore rebuild of the hold and the per-turn briefing all read it, so the room the engine seats the house in and the
 * room the narrator is told can never be two reads. Competitions move the house for real in a PLAYED game only (a headless sim keeps no gather): `null` there, and for every kind that has no staging room.
 */
export function eventStagingRoom(kind: string | undefined | null, playedGame: boolean): Room | null {
  if (kind === "nominations" || kind === "veto-draw" || kind === "veto-ceremony" || kind === "eviction") return "living-room";
  if ((kind === "hoh-competition" || kind === "veto-competition") && playedGame) return "backyard";
  return null;
}
