import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);

// Secret-looking tokens that must never be committed (feature 0010; widened per audit E78).
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9]{24,}\b/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // GitHub tokens (classic + fine-grained + app) — the A4 private-repo design makes a pasted
  // PAT the most likely accident class.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  // Slack / Google API keys — cheap to refute, common paste mistakes.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // OpenRouter keys (`sk-or-v1-<64 hex>`) — the app's own provider. The generic `sk-` pattern above
  // misses them: its [A-Za-z0-9]{24,} run is broken by the hyphens after `sk-`.
  /sk-or-v1-[A-Za-z0-9]{20,}/,
  // OpenAI project / service-account / admin keys (`sk-proj-…`): base64url body with `-` and `_`,
  // which the generic `sk-` pattern also misses.
  /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/,
];

// Audit E78: the guard used to scan only deploy/ + root configs — not src/, not the vendored
// front-end. Now EVERY tracked file is in scope except lockfiles and binary assets.
const EXCLUDED_FILES = new Set(["package-lock.json", "frontend/requirements.lock.txt"]);
const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|pdf|zip|gz|tar|mp[34]|wav|onnx|bin|sqlite|db)$/i;

// Redaction/scrubbing test fixtures (0071) EXIST to carry example secrets — they prove the log/secret
// scrubber catches token SHAPES, so they will always trip the patterns below. Exempt them by EXACT
// path (never a glob), so the exemption is auditable and a real secret committed ANYWHERE else is
// still caught. The fixtures use obviously non-functional values (sequential alphabet).
const REDACTION_TEST_FIXTURES = new Set([
  "features/step_definitions/defensive_hardening.steps.ts",
  "frontend/tests/test_secret_redaction.py",
  // Scrub-coverage fixtures carrying obviously-fake key shapes to prove the censor/settings
  // scrubber catches token SHAPES (not real secrets) — exact-path exempt, same as above.
  "frontend/tests/test_censor_no_overmatch.py",
  "frontend/tests/test_settings_scrub_allowlist.py",
]);

function inScope(f: string): boolean {
  if (EXCLUDED_FILES.has(f)) return false;
  if (REDACTION_TEST_FIXTURES.has(f)) return false;
  if (/(^|\/)package-lock\.json$|(^|\/)yarn\.lock$|(^|\/)pnpm-lock\.yaml$/.test(f)) return false;
  if (BINARY_EXTENSIONS.test(f)) return false;
  return true;
}

describe("secrets never live in the repo (feature 0010 + audit E78)", () => {
  it("no committed file — engine, front-end, deploy, docs — contains an API key or private key", () => {
    const files = tracked.filter(inScope);
    // Self-check: the sweep must genuinely cover the engine and the vendored front-end —
    // a silently-narrowed scope is exactly the failure E78 found.
    expect(files.some((f) => f.startsWith("src/")), "scope covers src/").toBe(true);
    expect(files.some((f) => f.startsWith("frontend/")), "scope covers frontend/").toBe(true);
    expect(files.some((f) => f.startsWith("deploy/")), "scope covers deploy/").toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // unreadable (deleted in worktree) — git ls-files can lag the tree
      }
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text)) offenders.push(`${file} matches ${pattern}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no real .env file is committed (only .env.example)", () => {
    const envFiles = tracked.filter((f) => /(^|\/)\.env$/.test(f));
    expect(envFiles).toEqual([]);
  });
});

describe("secret patterns recognise each key format", () => {
  // Samples are assembled at runtime, never written as literals: this file is itself swept by the
  // test above and scanned by gitleaks, so a complete key-shaped literal here would trip both.
  const hex64 = "0123456789abcdef".repeat(4);
  const base64url = "Ab3_-Zy9".repeat(8);
  const matchesAny = (sample: string): boolean => SECRET_PATTERNS.some((p) => p.test(sample));

  it.each([
    ["OpenRouter key", "OPENROUTER_API_KEY=sk-or-v1-" + hex64],
    ["OpenRouter key in prose", "use sk-or-v1-" + hex64 + " to call it"],
    ["OpenAI project key", "OPENAI_API_KEY=sk-proj-" + base64url],
    ["OpenAI service-account key", "sk-svcacct-" + base64url],
    ["OpenAI admin key", "sk-admin-" + base64url],
    ["Anthropic key (existing format)", "sk-ant-" + "a".repeat(24)],
    ["generic sk- key (existing format)", "sk-" + "a".repeat(32)],
  ])("flags a %s", (_label, sample) => {
    expect(matchesAny(sample)).toBe(true);
  });

  it.each([
    ["a bare OpenRouter prefix", "sk-or-v1-"],
    ["an elided OpenRouter placeholder", "sk-or-v1-..."],
    ["a short OpenRouter-looking token", "sk-or-v1-abc123"],
    ["an OpenAI prefix with no body", "/^sk-proj-/ and `/setup openai sk-proj-...`"],
  ])("does not flag %s", (_label, sample) => {
    expect(matchesAny(sample)).toBe(false);
  });
});
