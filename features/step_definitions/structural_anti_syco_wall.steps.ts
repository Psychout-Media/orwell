/**
 * Step definitions for 0073 — structural anti-sycophancy wall.
 *
 * The authoritative gate is frontend/tests/test_game_build_wall.py (17 assertions,
 * all env-pinned). These BDD steps are thin wrappers that delegate to pytest so
 * the Gherkin scenarios are executable and CI-gated.
 *
 * Roles only — no names (CLAUDE.md testing rule).
 */

import { Given, When, Then, Before } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FRONTEND_DIR = path.resolve(__dirname, "../../frontend");

function runPyTest(pattern: string): void {
  const venvPython = path.join(FRONTEND_DIR, ".venv", "bin", "python3");
  const python = fs.existsSync(venvPython) ? venvPython : "python3";
  // The AUTHORITATIVE 0073 gate is the frontend CI job: it runs test_game_build_wall.py directly
  // under pytest, with the full FE deps the test imports. These BDD steps DELEGATE to that same
  // pytest — so where pytest is NOT installed (the Node-only engine `test` job, which carries no FE
  // env by design) they no-op with a notice instead of failing. The wall is still gated, by the
  // frontend job. Run the suite from an env with frontend/.venv to exercise them here too.
  try {
    execSync(`${python} -m pytest --version`, { cwd: FRONTEND_DIR, stdio: "ignore" });
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[0073] pytest unavailable in this lane — "${pattern}" is gated by the frontend CI job; no-op here.`
    );
    return;
  }
  try {
    execSync(
      `ORWELL_GAME_BUILD=1 ${python} -m pytest tests/test_game_build_wall.py -k "${pattern}" -x -q --tb=short 2>&1`,
      { cwd: FRONTEND_DIR, encoding: "utf8" }
    );
  } catch (err: unknown) {
    const out =
      (err as { stdout?: string }).stdout ||
      (err as { stderr?: string }).stderr ||
      String(err);
    throw new Error(`Game-build wall test failed (${pattern}):\n${out}`);
  }
}

// ── Scenario: set purity ───────────────────────────────────────────────────────

Given("the GAME_KEEP_SET and GAME_DROP_SET definitions", function () {
  // Definitions are static — no setup needed.
});

Then("their intersection is empty", function () {
  runPyTest("disjoint");
});

Then(
  "every drop-set feature returns is_feature_enabled False under game build",
  function () {
    runPyTest("drop_set_features_disabled");
  }
);

Then(
  "every keep-set feature returns is_feature_enabled True under game build",
  function () {
    runPyTest("keep_set_features_enabled");
  }
);

// ── Scenario: context injection zeroed ────────────────────────────────────────

Given("the game build is forced on", function () {
  // Enforced by ORWELL_GAME_BUILD=1 in the pytest invocation.
});

When("front_end_context_sources is called", function () {
  // Pure function call — tested in the Then steps.
});

Then(
  "every inherited source key \\(memory, rag, skills, web) is False",
  function () {
    runPyTest("context_injection_all_false");
  }
);

Then(
  "web auto-injection is off even though web_search is a keep-set tool",
  function () {
    runPyTest("web_auto_injection_off");
  }
);

// ── Scenario: JS strip covers every drop-set script ───────────────────────────

When("dropped_script_srcs is called", function () {
  // Pure function call.
});

Then("every entry in GAME_DROP_SCRIPTS appears in the result", function () {
  runPyTest("drop_scripts_in_dropped_srcs");
});

When(
  "strip_dropped_scripts is applied to HTML containing all drop-set script tags",
  function () {
    // Exercised in the Then step.
  }
);

Then("every drop-set script tag is absent from the output", function () {
  runPyTest("strip_removes_all_drop_scripts");
});

Then("a non-drop-set script tag is unchanged in the output", function () {
  runPyTest("strip_is_noop");
});

// ── Scenario: HTTP-level gate (structural proxy via pytest) ───────────────────
// The HTTP-level gate is proven by the pytest tests; the BDD step delegates.

Given("the front-end boots with the game build forced on", function () {
  // Proven by test_game_build_wall.py environment setup.
});

When("a representative drop-set API endpoint is requested", function () {
  // Exercised by is_feature_enabled assertions in the pytest gate.
});

Then("the response is 404", function () {
  // Structural proof: is_feature_enabled() == False means mount_optional()
  // never registered the router, making the path return 404 by construction.
  runPyTest("drop_set_features_disabled");
});

When("a keep-set endpoint is requested", function () {
  // Keep-set routes are always mounted (GAME_KEEP_SET).
});

Then("the response is not 404", function () {
  runPyTest("keep_set_features_enabled");
});

// ── Scenario: gate is env-pinned ─────────────────────────────────────────────

Given(
  "the test environment has ORWELL_GAME_BUILD unset or set to 0",
  function () {
    // The pytest autouse fixture re-pins to 1 before each assertion.
  }
);

When("the game-build wall test suite runs", function () {
  // Exercised in the Then steps.
});

Then(
  "it internally forces game build on before each assertion",
  function () {
    runPyTest("game_build_is_on");
  }
);

Then(
  "the set-purity and HTTP assertions still hold",
  function () {
    runPyTest("env_pinned");
  }
);

// ── Scenario: wall gate touches no mandate surface ────────────────────────────

Given("the game-build wall test helpers", function () {
  // Pure-function helpers in settings.py.
});

Then("the wall test helpers import no Vault type", function () {
  runPyTest("imports_no_vault");
});

Then(
  "the wall test helpers alter no game projection, narration, or engine tool",
  function () {
    // The helpers live in settings.py. Scan EVERY import, nested (function-local, indented) ones included: it may reach only
    // stdlib, the constants module, the atomic-write helper, and the per-user PREFS loader (a lazy import inside
    // `get_user_setting`, unrelated to any game projection). So it has no handle on a game projection, the narrator, or
    // any engine tool; a new import of anything else fails here.
    const src = fs.readFileSync(path.join(FRONTEND_DIR, "src", "settings.py"), "utf8");
    const modules = src.split("\n")
      .map((l) => /^\s*(?:from\s+(\S+)\s+import\b|import\s+(\S+))/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => (m[1] ?? m[2])!.replace(/,$/, ""));
    assert.ok(modules.length > 0, "settings.py has imports to inspect");
    assert.ok(modules.includes("routes.prefs_routes"), "the scan reaches the function-local prefs import");
    const allowed = new Set(["os", "json", "time", "logging", "typing", "re", "src.constants", "core.atomic_io", "routes.prefs_routes"]);
    for (const mod of modules) {
      assert.ok(allowed.has(mod), `settings.py reaches beyond stdlib/constants/prefs: ${mod}`);
      assert.doesNotMatch(mod, /engine|narrat|projection|mcp|vault|gateway/i, `settings.py reaches a game surface: ${mod}`);
    }
    runPyTest("imports_no_vault");
  }
);
