import { endHeldNight } from "../support/heldNight";
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";

// The FULL deployed flag profile, read from its single source (`deploy/orwell-env-defaults.sh`, the same
// function install + update write the box's .env from, and the `heavy-sims` CI lane plays — the code defaults ARE the deployed profile since the 2026-11 default flip) — "the
// gate tests what prod runs" (ADR 0016). Jury house / time of day etc. can change the eviction-night chain.
// The adapters read these env flags at MODULE LOAD, so they are applied BEFORE the dynamic import below.
// Embedding settings are dropped (they would fetch the ONNX model; tests use the deterministic fake).
const deployedProfile = execFileSync(
  "bash",
  ["-c", 'source "$1" && orwell_optin_env_defaults "$2"', "_", "deploy/orwell-env-defaults.sh", "/nonexistent/orwell-data"],
  { encoding: "utf8" },
)
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "")
  .map((l) => {
    // A malformed line means the profile source changed shape — fail loudly, never silently play a
    // different profile than the deploy (the same stance as the `heavy-sims` CI lane).
    if (!/^ORWELL_[A-Z0-9_]+=\S+$/.test(l)) throw new Error(`unexpected line from orwell_optin_env_defaults: ${l}`);
    return l;
  })
  .filter((l) => !/^ORWELL_(EMBEDDINGS|EMBED_CACHE)=/.test(l));
for (const line of deployedProfile) {
  const i = line.indexOf("=");
  process.env[line.slice(0, i)] = line.slice(i + 1);
}
const { composeRuntime } = await import("../../src/composition/runtime");

/**
 * 0130 / #1934 known issue — eviction night after the PLAYER's goodbye.
 *
 * The player's `goodbye-message` is the last player-owned gate of the eviction sub-loop, but
 * `submitDecision` returns only the goodbye beat: the engine still owes `exit-interview` →
 * `eviction-result` (→ rollWeek), and only `advanceGame` delivers them. The front-end's post-goodbye tail
 * therefore has to keep advancing until the engine reports the chain done, not fire a fixed count. This
 * drives the real engine through a full eviction night on the deployed (flags-on) profile and pins that
 * contract: the chain needs MORE than one advance, ends in `eviction-result`, and the `eviction`
 * projection is gone exactly when it does (the signal the route stops on).
 *
 * Roles only — no houseguest names; reads public beat/projection fields, never the Vault.
 */

interface NamedRef { id: string; name: string }
interface PendingView { kind: string; options?: NamedRef[]; appeals?: string[]; tones?: string[]; stances?: string[] }
interface BeatEv { beat?: string }
interface View { started: boolean; beatSeq: number; finished: boolean; pending: PendingView | null; event?: BeatEv | null; eviction?: unknown }

function answer(p: PendingView): Record<string, unknown> {
  const first = p.options?.[0]?.id;
  switch (p.kind) {
    case "nominations": return { kind: "nominations", choice: [p.options![0]!.id, p.options![1]!.id] };
    case "veto-decision":
      return p.options!.some((o) => o.id === PLAYER)
        ? { kind: "veto-decision", use: true, save: PLAYER }
        : { kind: "veto-decision", use: false };
    case "comp-intent": return { kind: "comp-intent", intent: "compete" };
    case "comp-round": return { kind: "comp-round", intent: "compete" };
    case "houseguests-choice": return { kind: "houseguests-choice", vote: first };
    case "replacement": return { kind: "replacement", replacement: first };
    case "eviction-vote": return { kind: "eviction-vote", vote: first };
    case "tie-break": return { kind: "tie-break", vote: first };
    case "goodbye-message": return { kind: "goodbye-message", vote: "respectful" };
    case "exit-interview": return { kind: "exit-interview", vote: "gracious" };
    case "spectator-choice": return { kind: "spectator-choice", vote: "watch" }; // 0133
    case "finale-interview": return { kind: "finale-interview", vote: "gracious" };
    default: throw new Error(`unhandled pending kind before the first goodbye: ${p.kind}`);
  }
}

/** Thrown ONLY when a seed's season ends without ever handing the player a goodbye — the one outcome the seed
 *  search is allowed to skip past. Anything else (a profile-guard failure, an engine error) must surface. */
class NoGoodbyeOnSeed extends Error {}

async function toPlayerGoodbyeOnSeed(seed: number) {
  const runtime = composeRuntime({ clock: new FakeClock(), seed: 1 });
  const user = `post-goodbye-${seed}`;
  // Prove the env profile reached the sandbox (not silently flags-off): the two co-presence layers are on.
  const sb = runtime.registry.sandboxFor(user);
  expect(deployedProfile.length, "the full deployed profile loaded").toBeGreaterThanOrEqual(20);
  expect(sb.session.dealDepthEnabledNow() && sb.session.triggersEnabledNow()).toBe(true);
  const mcp = runtime.registry.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed });
  for (let i = 0; i < 5_000; i++) {
    const adv = (await mcp.callTool("advanceGame", {})) as View;
    if ((adv as { held?: unknown }).held) await endHeldNight((n, a) => mcp.callTool(n, a), `pg${seed}`); // ORW-116: a held night is the player's: time passes, then they turn in
    if (adv.finished) break;
    if (adv.pending) {
      if (adv.pending.kind === "goodbye-message") return { mcp, pending: adv.pending };
      const sub = (await mcp.callTool("submitDecision", answer(adv.pending))) as View;
      if (sub.pending?.kind === "goodbye-message") return { mcp, pending: sub.pending };
      if (sub.finished) break;
    }
  }
  throw new NoGoodbyeOnSeed(`seed ${seed}: no player goodbye reached`);
}

/** The player only gets a `goodbye-message` when they SURVIVE an eviction, and which seeds do depends on the
 *  balance (#1941 moved them) — so SEARCH for a qualifying seed rather than pinning one. */
async function toPlayerGoodbye(maxSeeds = 40) {
  for (let seed = 1; seed <= maxSeeds; seed++) {
    try {
      return await toPlayerGoodbyeOnSeed(seed);
    } catch (e) {
      if (!(e instanceof NoGoodbyeOnSeed)) throw e; // a real failure — never swallow it
    }
  }
  throw new Error(`no seed in 1..${maxSeeds} reached a player goodbye`);
}

describe("0130 — the beat chain after the player's goodbye ends in eviction-result", () => {
  it("needs more than one advance, ends in eviction-result, and drops the eviction projection there", async () => {
    const { mcp } = await toPlayerGoodbye();
    const sub = (await mcp.callTool("submitDecision", { kind: "goodbye-message", vote: "respectful" })) as View;
    // The decision returns only the goodbye beat — the engine still owes the rest of the night.
    expect(sub.pending, "no player gate remains after the goodbye").toBeNull();
    expect(sub.event?.beat).not.toBe("eviction-result");
    expect(sub.eviction, "the eviction is still staging after the goodbye").toBeTruthy();

    const beats: string[] = [];
    let last: View = sub;
    for (let i = 0; i < 6 && last.eviction && !last.pending && !last.finished; i++) {
      // The route passes the PRIOR view's beatSeq as the CAS token (0065 Part A): each owed step must be
      // accepted with it, and a concurrent advance would make the next step stale.
      last = (await mcp.callTool("advanceGame", { expectedBeatSeq: last.beatSeq })) as View;
      if (last.event?.beat) beats.push(last.event.beat);
    }
    expect(beats.length, `one advance is not enough (saw ${beats.join(" → ")})`).toBeGreaterThan(1);
    expect(beats[beats.length - 1]).toBe("eviction-result");
    expect(beats).toContain("exit-interview");
    expect(last.eviction ?? null, "the eviction projection is gone once the result lands").toBeNull();
  }, 120_000);
});
