import { endHeldNight } from "../support/heldNight";
import "../support/pinFlagsOff";
import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import { MOVEMENT_PERSONALITY } from "../../src/engine/presenceConstants";

/**
 * L21/L24 — the RNG-ISOLATION regression guard (the golden test the feature lives or dies on).
 *
 * NPC-personality movement weighting (`presence.ts` / `presenceConstants.ts`) bends each NPC's
 * room-to-room movement by WHO they are (social aptitude + soul volatility). TWO prior attempts at this
 * broke the seeded `juryReach` calibration gate — both by changing how the orchestrator's SHARED per-user
 * RNG stream (which drives the off-screen society + relationship folds + downstream nomination/vote
 * decisions) is consumed during `presenceTick`:
 *   1. The FIRST reverted attempt ADDED extra weighting rolls to the shared stream — re-phasing it.
 *   2. The SECOND (the first ship of this feature) over-corrected and stopped drawing from the shared
 *      stream ENTIRELY (all movement went to a dedicated stream) — which ALSO re-phased every later
 *      shared-stream consumer, because the un-weighted room assignment used to BE part of the spine.
 *
 * THE FIX, proven here AND in `tests/unit/presence.test.ts` (the shared-draw-count guard): the
 * CALIBRATION-NEUTRAL BASE assignment — `presenceBase`, what the off-screen society pairs on — STILL
 * draws from the SHARED per-user stream, un-weighted, with the EXACT same draw count as the pre-feature
 * build, so the shared stream is advanced byte-identically and the competition/vote outcomes are
 * UNCHANGED. ONLY the personality-WEIGHTED, player-facing positions ride a DEDICATED stream that
 * `presenceTick` forks off the GAME seed + a persisted per-tick counter. So however differently the
 * weighting moves the player-facing house, the calibration spine is byte-for-byte unchanged.
 *
 * The golden assertion: drive the SAME seeded passive live season twice through the SAME runtime the
 * production composition (and `juryReach`) uses — once with the DEFAULT movement weighting, once with
 * the weighting cranked to an EXTREME (every houseguest a manic roamer / a frozen homebody) — and the
 * full sequence of PUBLIC competition/eviction/ceremony beat outcomes must match line-for-line. If the
 * movement stream were not isolated, the extreme weighting would shift the shared stream and the
 * outcomes would diverge. (The companion permanent gate is `juryReach.property.test.ts` itself.)
 *
 * SCOPE (#1934 item 1): the claim is "movement weighting uses its OWN stream", proven on the profile
 * where nothing else reads co-presence (`ORWELL_DEAL_DEPTH` / `ORWELL_TRIGGERS` pinned off in
 * `seasonBeatLog`). Those layers consume co-presence — which weighted movement changes on purpose
 * (0078) — so their outcomes may differ per weighting without any stream being shared.
 *
 * Roles only — no houseguest names; outcomes are read off the public beat content, never the Vault.
 */

interface NamedRef { id: string; name: string }
interface PendingView { kind: string; options: NamedRef[]; appeals?: string[] }
interface BeatEv { beat?: string; content?: string }
interface AdvanceResult { started: boolean; finished: boolean; pending: PendingView | null; event?: BeatEv | null }

/** The same passive policy juryReach uses: first legal option everywhere; compete; veto only on self. */
function passiveAnswer(p: PendingView): Record<string, unknown> {
  switch (p.kind) {
    case "nominations":
      return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
    case "veto-decision":
      return p.options.some((o) => o.id === PLAYER)
        ? { kind: "veto-decision", use: true, save: PLAYER }
        : { kind: "veto-decision", use: false };
    case "comp-intent":
      return { kind: "comp-intent", intent: "compete" };
    case "comp-round":
      return { kind: "comp-round", intent: "compete" }; // 0006 staged-rounds
    case "houseguests-choice":
      return { kind: "houseguests-choice", vote: p.options[0]!.id };
    case "replacement":
      return { kind: "replacement", replacement: p.options[0]!.id };
    case "eviction-vote":
      return { kind: "eviction-vote", vote: p.options[0]!.id };
    case "tie-break":
      return { kind: "tie-break", vote: p.options[0]!.id };
    case "final-eviction":
      return { kind: "final-eviction", vote: p.options[0]!.id };
    case "finale-statement":
      return { kind: "finale-statement", statement: "I played my own game." };
    case "finale-answer":
      return { kind: "finale-answer", appeal: p.appeals?.[0] ?? "own-game" };
    case "juror-vote":
      return { kind: "juror-vote", vote: p.options[0]!.id };
    case "goodbye-message":
      return { kind: "goodbye-message", vote: "respectful" };
    case "exit-interview": // 0130 — the player-evictee's posture rides `vote`.
      return { kind: "exit-interview", vote: "gracious" };
    case "spectator-choice": // 0133
      return { kind: "spectator-choice", vote: "watch" };
    case "secret-veto": // 0025 reactive twists (default ON since 2026-11-03): the player holds the sealed one-time safety and is on the block — every arm HOLDS it (arms stay comparable)
      return { kind: "secret-veto", use: false };
    case "finale-interview":
      return { kind: "finale-interview", vote: "gracious" };
    case "juror-question":
      return { kind: "juror-question", statement: "What was your biggest move?" };
    default:
      throw new Error(`unhandled pending kind: ${p.kind}`);
  }
}

/**
 * Play one full passive seeded season through the production runtime composition and return the
 * ordered log of PUBLIC competition/eviction/ceremony beat outcomes — the calibration-bearing record.
 * Vault-free by construction (beat content is player-witnessed broadcast).
 */
async function seasonBeatLog(seed: number): Promise<string[]> {
  const runtime = composeRuntime({
    clock: new FakeClock(),
    seed: 1,
  });
  // Pin the two co-presence layers OFF for this sandbox, whatever the process env says (#1934 item 1):
  // `ORWELL_DEAL_DEPTH` and `ORWELL_TRIGGERS` both ACT on who is in the room together (deal offers,
  // eruption sparks). Weighted movement changes co-presence by design (the 0078 coupling), so with
  // either on, the public beat log legitimately differs between weightings. Neither draws from the
  // movement stream — deal depth rides `beatRng()` (week/beat keyed), triggers a `triggers:<tick>`
  // stream — so the isolation claim holds, and is asserted here on the flags-off profile.
  const sandbox = runtime.registry.sandboxFor(`move-iso-${seed}`);
  sandbox.session.setDealDepthEnabled(false);
  sandbox.session.setTriggersEnabled(false);
  const mcp = runtime.registry.resolver()("player", `move-iso-${seed}`);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed });
  const log: string[] = [];
  const note = (ev: BeatEv | null | undefined): void => {
    if (ev?.beat && ev?.content) log.push(`${ev.beat}::${ev.content}`);
  };
  let finished = false;
  for (let i = 0; i < 5_000 && !finished; i++) {
    const adv = (await mcp.callTool("advanceGame", {})) as AdvanceResult;
    if ((adv as { held?: unknown }).held) await endHeldNight((n, a) => mcp.callTool(n, a), `mv${seed}`); // ORW-116: a held night is the player's: time passes, then they turn in
    finished = adv.finished;
    note(adv.event);
    if (adv.pending) {
      const sub = (await mcp.callTool("submitDecision", passiveAnswer(adv.pending))) as AdvanceResult;
      finished = sub.finished;
      note(sub.event);
    }
  }
  expect(finished, `season for seed ${seed} must finish`).toBe(true);
  return log;
}

/** Run `fn` with MOVEMENT_PERSONALITY temporarily overridden, restoring it afterward (no leakage). */
async function withMovement(over: Partial<typeof MOVEMENT_PERSONALITY>, fn: () => Promise<string[]>): Promise<string[]> {
  const saved = { ...MOVEMENT_PERSONALITY };
  Object.assign(MOVEMENT_PERSONALITY, over);
  try {
    return await fn();
  } finally {
    Object.assign(MOVEMENT_PERSONALITY, saved);
  }
}

describe("L21/L24 — movement-RNG isolation: the competition/vote stream is unaffected", () => {
  it(
    "extreme personality movement weighting leaves every public competition/vote outcome byte-identical",
    async () => {
      // AMEND 0078 #2 (Ryne: location SHOULD matter). What this test claims is NARROW and true: weighted movement rides its OWN dedicated stream, so it never perturbs the SEEDED
      // competition/vote random stream. It does NOT claim location never changes outcomes - co-presence legitimately shapes who talks to whom, and therefore (through recorded events and
      // the co-presence-reading layers) outcomes. History: on 2026-11-04 seed 1 (post one-turn-reveal) and seed 22 (on the then-main) diverged in a NOMINATION choice and the seeds were
      // re-picked [1,2,3] -> [2,3,4] rather than explained. Re-measured on main @ 2026-11-04 (after the 5-min pace / hang-out work): seeds 1 and 22 now BOTH match line-for-line
      // (350/329-beat seasons identical under the extreme weighting), so the divergence was a transient co-presence coupling of the older trajectory, not a shared-stream leak; the seeds
      // are restored and 22 is kept as a standing regression. If a seed diverges again, bisect the co-presence-reading layers (deal depth/triggers are already pinned off) before touching the seed list.
      const seeds = [1, 2, 3, 4, 22];
      for (const seed of seeds) {
        // The default weighting (what ships) …
        const baseline = await seasonBeatLog(seed);
        // … vs. the weighting cranked to an EXTREME: everyone a manic roamer who seeks company hard,
        // restlessness amplified, the move-rate clamp opened wide — the house moves COMPLETELY
        // differently. If movement shared the calibration stream, this would shift the outcomes.
        const extreme = await withMovement(
          {
            moveAptitudeWeight: 5,
            seekAptitudeWeight: 8,
            volatilityWeight: 5,
            moveProbFloor: 0.01,
            moveProbCeil: 0.999,
          },
          () => seasonBeatLog(seed),
        );
        expect(
          extreme,
          `seed ${seed}: movement weighting must NOT perturb the competition/vote outcomes (RNG isolation broken)`,
        ).toEqual(baseline);
        // Sanity: the season actually produced a real run of outcomes (not a trivially-empty match).
        expect(baseline.length).toBeGreaterThan(10);
      }
    },
    { timeout: 600_000 },
  );
});
