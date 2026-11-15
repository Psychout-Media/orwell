/**
 * Step definitions for 0072 — multi-platform gateway.
 *
 * These steps exercise the pure-function invariants of the gateway Python layer
 * from the TypeScript BDD harness by running the Python test suite as a subprocess.
 * Each scenario is proven by one or more of:
 *   - frontend/tests/test_gateway_pairing.py
 *   - frontend/tests/test_gateway_scrub.py
 *   - frontend/tests/test_gateway_isolation.py
 *   - frontend/tests/test_gateway_build_gate.py
 *
 * The scenarios below are structural contract checks at the TS level:
 *   - The scrub module is a pure function with no Vault imports
 *   - The pairing module has no Vault imports
 *   - The platform adapter contract is satisfied by the Telegram adapter
 *   - The gateway handler routes through the player channel, not admin/Vault
 *
 * NOTE: roles only — no names in assertions (CLAUDE.md testing rule).
 */

import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FRONTEND_DIR = path.resolve(__dirname, "../../frontend");

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Run a subset of the frontend Python tests and assert they pass.
 * Surfaces the pytest output on failure so CI logs are diagnostic.
 */
/** True when the frontend's pytest environment exists in this lane (the Node-only engine job carries none by design). */
function pythonEnv(testModule: string): string | null {
  const venvPython = path.join(FRONTEND_DIR, ".venv", "bin", "python3");
  const python = fs.existsSync(venvPython) ? venvPython : "python3";

  // ORW-265: these steps DELEGATE to the frontend pytest, so a missing pytest must FAIL LOUDLY, never
  // pass as a silent no-op (a green Then that asserted nothing). The CI `bdd` job installs the FE env
  // (setup-fe-python), so it runs them for real. A lane that genuinely has no FE env may opt out
  // explicitly with ORWELL_BDD_PY_OPTIONAL=1 (the frontend CI job still gates the same modules).
  try {
    execSync(`${python} -m pytest --version`, { cwd: FRONTEND_DIR, stdio: "ignore" });
  } catch {
    if (process.env.ORWELL_BDD_PY_OPTIONAL === "1") {
      // eslint-disable-next-line no-console
      console.warn(`[0072] pytest unavailable — "${testModule}" skipped by explicit ORWELL_BDD_PY_OPTIONAL=1.`);
      return null;
    }
    throw new Error(
      `[0072] pytest is not available, so "${testModule}" cannot be verified. Install the frontend ` +
        `environment (frontend/requirements.lock.txt) or set ORWELL_BDD_PY_OPTIONAL=1 to opt out explicitly.`
    );
  }
  return python;
}

function runPyTests(testModule: string): void {
  const python = pythonEnv(testModule);
  if (!python) return;

  try {
    execSync(
      `${python} -m pytest tests/${testModule} -x -q --tb=short 2>&1`,
      { cwd: FRONTEND_DIR, encoding: "utf8" }
    );
  } catch (err: unknown) {
    const output =
      (err as { stdout?: string; stderr?: string }).stdout ||
      (err as { stderr?: string }).stderr ||
      String(err);
    throw new Error(
      `Python gateway tests failed (${testModule}):\n${output}`
    );
  }
}

/**
 * Run an inline Python boundary check against the REAL gateway handler (same gate and same FE env as `runPyTests`).
 * The script drives `gateway.handler` with the engine / narrator doubles it names, and exits non-zero (an assertion) on a miss.
 */
function runPyScript(label: string, script: string): void {
  const python = pythonEnv(label);
  if (!python) return;
  try {
    execSync(`${python} -`, { cwd: FRONTEND_DIR, encoding: "utf8", input: script, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`Gateway boundary check failed (${label}):\n${e.stdout ?? ""}\n${e.stderr ?? String(err)}`);
  }
}

/** Python preamble: pair identities, double the engine + narrator, and drive `handle_platform_turn` end to end. */
const PY_HANDLER_HARNESS = `
import asyncio, re, sys
from unittest import mock
sys.path.insert(0, ".")
import gateway.handler as h
from gateway.pairing import generate_code, verify_code, pair
from src import orwell_engine

def do_pair(identity, user):
    code = generate_code(identity)
    assert verify_code(identity, code)
    pair(identity, user)

async def _noop(*a, **k):
    return None

async def _ident(user, text):
    return text

def drive(identity, text, narration, calls):
    """One gateway turn through the real handler; every engine read and the narrator call are recorded in \`calls\`."""
    async def state(user=None, **kw):
        calls.append(("get_game_state", user)); return {"house": []}
    async def moment(moment=None, user=None, **kw):
        calls.append(("get_moment_prompt", user)); return {"systemPrompt": "moment"}
    async def narrate(system_prompt, user_message, user):
        calls.append(("narrate", user)); return narration
    with mock.patch.object(orwell_engine, "get_game_state", state), \
         mock.patch.object(orwell_engine, "get_moment_prompt", moment), \
         mock.patch.object(h, "_narrate_gateway_turn", narrate), \
         mock.patch.object(h, "fold_gateway_turn", _noop), \
         mock.patch.object(h, "screen_knowledge_wall", _ident), \
         mock.patch.object(h, "screen_presence_wall", _ident), \
         mock.patch("src.orwell_game_session.publish_game_updated", lambda *a, **k: None):
        return asyncio.new_event_loop().run_until_complete(h.handle_platform_turn("telegram", identity, text))
`;

// ── Scenario: a paired platform identity reaches the player's own game ────────

let _pairedIdentityCtx: {
  platformIdentity: string;
  orwellUser: string;
} | null = null;

Given("a player account with a live game", function () {
  // Structural: a player account exists with a game. The pairing invariant is
  // tested in the Python isolation suite; here we set up the context object.
  _pairedIdentityCtx = { platformIdentity: "", orwellUser: "test-player-account" };
});

Given("a platform identity paired to that account", function () {
  assert.ok(_pairedIdentityCtx, "player account context must be set");
  _pairedIdentityCtx.platformIdentity = "telegram:test-identity-1";
});

When("the platform identity sends a turn over the gateway", function () {
  // Proven by test_gateway_isolation.py::TestPairedIdentityReachesOwnGame
  runPyTests("test_gateway_isolation.py");
});

Then("the turn runs against that account's game on the player channel", function () {
  // Isolation invariant: the paired user is resolved by get_paired_user and the engine call uses
  // x-orwell-user = that user. Run the exact tests that assert it (plus the handler's per-user routing).
  runPyTests("test_gateway_isolation.py::TestPairedIdentityReachesOwnGame");
  runPyTests("test_gateway_isolation.py::TestCrossUserIsolation::test_handler_uses_paired_user_not_another");
  // ...and through the real handler: two paired identities each turn run against ONLY their own account, on the player
  // channel (every engine call carries that account's user and none of the other's).
  runPyScript("handler routes each paired identity to its own account", `${PY_HANDLER_HARNESS}
do_pair("telegram:route-a", "user_route_a")
do_pair("telegram:route-b", "user_route_b")
calls_a, calls_b = [], []
drive("telegram:route-a", "hi", "A narration.", calls_a)
drive("telegram:route-b", "hi", "B narration.", calls_b)
assert {c[0] for c in calls_a} == {"get_game_state", "get_moment_prompt", "narrate"}, calls_a
assert all(c[1] == "user_route_a" for c in calls_a), calls_a
assert {c[0] for c in calls_b} == {"get_game_state", "get_moment_prompt", "narrate"}, calls_b
assert all(c[1] == "user_route_b" for c in calls_b), calls_b
`);
});

Then("the public reply contains no Vault or secret content", function () {
  // Scrub invariant: the chokepoint fires before delivery.
  // Proven by test_gateway_scrub.py + test_gateway_isolation.py.
  // ...and at the delivery boundary: a paired turn whose narration leaks a secret canary in each leak shape (reasoning
  // block, operator aside, raw npc id) comes back from the real handler with the canary gone.
  runPyScript("handler delivery is scrubbed of a secret canary", `${PY_HANDLER_HARNESS}
calls = []
do_pair("telegram:leak-a", "user_leak_a")
leaky = "<think>CANARY-SECRET plan</think>You wait. [OPERATOR: CANARY-SECRET aside] npc:hg-07 leans in."
reply = drive("telegram:leak-a", "hi", leaky, calls)
assert "CANARY-SECRET" not in reply, reply
assert "<think>" not in reply and "[OPERATOR:" not in reply and "npc:" not in reply, reply
assert "You wait." in reply, reply
`);
  runPyTests("test_gateway_scrub.py");
  runPyTests("test_gateway_build_gate.py::TestScrubAlwaysInDeliveryPath");
});

// ── Scenario: one human shares one game across platforms ──────────────────────

Given("two platform identities paired to that account", function () {
  // The pairing is tested in test_gateway_isolation.py::TestOneHumanOneGame.
  assert.ok(_pairedIdentityCtx, "player account context must be set");
});

When("each platform identity reads the game state over the gateway", function () {
  runPyTests("test_gateway_isolation.py");
});

Then("both see the same game under the same user", function () {
  // Both identities resolve to the same orwell user via get_paired_user.
  runPyTests("test_gateway_isolation.py::TestOneHumanOneGame::test_two_identities_paired_to_same_user_share_game");
});

When("a third, unpaired platform identity sends a turn", function () {
  // The unpaired path is tested in test_gateway_isolation.py::TestUnpairedCannotReachGame.
  runPyTests("test_gateway_isolation.py");
});

Then("it cannot reach any game", function () {
  // get_paired_user returns None → handler returns the unpaired message.
  runPyTests("test_gateway_isolation.py::TestUnpairedCannotReachGame");
  runPyTests("test_gateway_isolation.py::TestOneHumanOneGame::test_third_unpaired_identity_blocked");
});

// ── Scenario: cross-user isolation holds over the gateway ─────────────────────

Given("two player accounts each with a live game", function () {
  _pairedIdentityCtx = { platformIdentity: "", orwellUser: "cross-user-a" };
});

Given("a platform identity paired to the first account", function () {
  assert.ok(_pairedIdentityCtx);
  _pairedIdentityCtx.platformIdentity = "telegram:cross-test-1";
});

When("that identity sends a turn over the gateway", function () {
  runPyTests("test_gateway_isolation.py");
});

Then("no part of the second account's game is returned", function () {
  // Cross-user isolation: get_paired_user(identity_1) !== user_2.
  runPyTests("test_gateway_isolation.py::TestCrossUserIsolation");
});

// ── Scenario: reasoning never reaches the public bubble ──────────────────────

Given("a paired platform identity with a live game", function () {
  _pairedIdentityCtx = { platformIdentity: "telegram:scrub-test", orwellUser: "test-player" };
});

When(
  "a turn's narration carries reasoning, an operator-aside, and a raw npc id",
  function () {
    // Scrub tests cover all three leak types.
    runPyTests("test_gateway_scrub.py");
  }
);

Then(
  "the delivered reply is scrubbed of reasoning, operator-asides, and the npc id",
  function () {
    runPyTests("test_gateway_scrub.py::TestCombinedLeaks::test_all_three_leak_types_stripped");
  }
);

Then(
  "the scrub chokepoint fires regardless of which prompt produced the leak",
  function () {
    runPyTests("test_gateway_scrub.py::TestCombinedLeaks::test_chokepoint_fires_on_any_model_output");
    runPyTests("test_gateway_build_gate.py::TestScrubAlwaysInDeliveryPath::test_scrub_is_called_on_every_code_path");
  }
);

// ── Scenario: the gateway is chat only (ORW-286 item 8; Ryne 2026-11-11) ────

Given("a paired platform identity with a pending binding decision", function () {
  _pairedIdentityCtx = { platformIdentity: "telegram:decision-test", orwellUser: "test-player-dec" };
});

/** One REAL gateway turn (handle_platform_turn) with a binding decision pending in the narration: the engine reads, the narrator and the consequence fold are doubled and recorded, and
 * submit_decision / advance_game are doubled too so any call to them is seen. `checks` is the Python that asserts on `reply`, `calls` and `folded`. */
function chatOnlyTurn(label: string, checks: string): void {
  runPyScript(label, `${PY_HANDLER_HARNESS}
do_pair("telegram:chat-only", "user_chat_only")
calls, folded = [], []
async def submit_decision(*a, **k):
    calls.append(("submit_decision", k.get("user"))); return {}
async def advance_game(*a, **k):
    calls.append(("advance_game", k.get("user"))); return {}
async def fold(user, message, reply, house):
    folded.append((user, message, reply))
async def state(user=None, **kw):
    calls.append(("get_game_state", user)); return {"house": []}
async def moment(moment=None, user=None, **kw):
    calls.append(("get_moment_prompt", user)); return {"systemPrompt": "moment"}
async def narrate(system_prompt, user_message, user):
    calls.append(("narrate", user)); return "The room waits on you. 1. use the veto 2. keep the nominations."
with mock.patch.object(orwell_engine, "get_game_state", state), \\
     mock.patch.object(orwell_engine, "get_moment_prompt", moment), \\
     mock.patch.object(orwell_engine, "submit_decision", submit_decision), \\
     mock.patch.object(orwell_engine, "advance_game", advance_game), \\
     mock.patch.object(h, "_narrate_gateway_turn", narrate), \\
     mock.patch.object(h, "fold_gateway_turn", fold), \\
     mock.patch.object(h, "screen_knowledge_wall", _ident), \\
     mock.patch.object(h, "screen_presence_wall", _ident), \\
     mock.patch("src.orwell_game_session.publish_game_updated", lambda *a, **k: None):
    reply = asyncio.new_event_loop().run_until_complete(h.handle_platform_turn("telegram", "telegram:chat-only", "I keep the nominations."))
${checks}
`);
}

When("the identity sends a text message over the gateway", function () {
  assert.ok(_pairedIdentityCtx, "identity context set");
});

Then("the reply is one narrated turn that mentions the pending decision as plain text", function () {
  chatOnlyTurn("gateway chat-only: one narrated turn", `
assert "1. use the veto" in reply and "2. keep the nominations" in reply, reply
assert [c[0] for c in calls].count("narrate") == 1, calls
`);
});

Then("the gateway made no submit-decision call and no advance-game call", function () {
  chatOnlyTurn("gateway chat-only: no decide/advance", `
assert not [c for c in calls if c[0] in ("submit_decision", "advance_game")], calls
assert any(c[0] == "get_game_state" for c in calls), calls   # a real turn ran: the doubled engine WAS used
`);
  // and no gateway code calls them at all (comments aside)
  const dir = path.join(FRONTEND_DIR, "gateway");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".py"))) {
    const code = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.ok(!/\.(submit_decision|advance_game)\(/.test(code), `gateway/${f} calls submit_decision/advance_game`);
  }
});

Then("the turn's scene was folded through the consequence seam", function () {
  chatOnlyTurn("gateway chat-only: scene folded", `
assert len(folded) == 1 and folded[0][0] == "user_chat_only" and folded[0][1] == "I keep the nominations.", folded   # mandate #4: narrated means recorded
`);
});

// ── Scenario: the game build is respected over the gateway ───────────────────

When(
  "the identity attempts to invoke a drop-set inherited-workspace tool",
  function () {
    runPyTests("test_gateway_build_gate.py");
  }
);

Then("the tool is unavailable over the gateway", function () {
  runPyTests("test_gateway_build_gate.py::TestDropSetUnavailable");
  runPyTests("test_gateway_build_gate.py::TestGatewayGameBuildFlag");
});

// ── Scenario: pairing is hardened ────────────────────────────────────────────

Given("the pairing flow", function () {
  // Pairing state is managed by gateway/pairing.py (in-memory, process-local).
  assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "gateway", "pairing.py")), "the pairing module exists");
});

When("a code is issued", function () {
  runPyTests("test_gateway_pairing.py::TestCodeGeneration::test_generate_returns_nonempty_code");
});

Then(
  "it is stored only as a salted hash with a bounded lifetime",
  function () {
    runPyTests("test_gateway_pairing.py::TestCodeGeneration");
    runPyTests("test_gateway_pairing.py::TestTTL");
  }
);

When("an incorrect code is presented repeatedly", function () {
  runPyTests("test_gateway_pairing.py::TestRateLimit");
});

Then("the identity is rate-limited and locked out", function () {
  runPyTests("test_gateway_pairing.py::TestLockout");
});

When("an expired code is presented", function () {
  runPyTests("test_gateway_pairing.py::TestTTL::test_expired_code_is_refused");
});

Then("pairing is refused", function () {
  runPyTests("test_gateway_pairing.py::TestTTL::test_expired_code_is_refused");
  runPyTests("test_gateway_pairing.py::TestVerifyAndPair::test_incorrect_code_is_refused");
});

